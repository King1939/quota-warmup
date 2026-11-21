import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  PATHS,
  buildStatusSnapshot,
  computeNextRun,
  defaultSchedule,
  ensureDataDir,
  formatLocalDate,
  getDayKey,
  readJsonSafe,
  syncWindowsTasks,
  validateSchedule,
  writeJsonAtomic,
} from '../../scripts/manage_schedule.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_STALE_MS = 120 * 1000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const SLOT_TOLERANCE_MS = 75 * 1000;
const TICK_INTERVAL_MS = 10 * 1000;

const inFlightSlots = new Set();

function recordRuntimeInfo() {
  ensureDataDir();
  const runtime = {
    antigravityExe: process.execPath,
    agentapiExe: process.env.ANTIGRAVITY_AGENTAPI_EXE || '',
    projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
    appDataDir: process.env.ANTIGRAVITY_APP_DATA_DIR || '',
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS || '',
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(PATHS.runtime, runtime);
}

function acquireLock() {
  ensureDataDir();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const fd = openSync(PATHS.lock, 'wx');
      try {
        writeSync(fd, `${process.pid}|${new Date().toISOString()}`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = statSync(PATHS.lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            unlinkSync(PATHS.lock);
            continue;
          }
        } catch {
          // Lock vanished or unreadable; retry briefly
        }
        return false;
      }
      return false;
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (existsSync(PATHS.lock)) unlinkSync(PATHS.lock);
  } catch {
    // Ignore cleanup errors
  }
}

async function waitForLsHealthz(timeoutMs = 30000) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  if (!lsAddr) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${lsAddr}/healthz`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return;
    } catch {
      // Wait and retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Language server health check timed out (${lsAddr})`);
}

function extractConversationId(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of ['conversationId', 'conversation_id', 'id']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      return obj[key].trim();
    }
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = extractConversationId(val);
      if (found) return found;
    }
  }
  return '';
}

function resolveAgentApiInvocation({ message, model, title }) {
  const baseArgs = ['new-conversation'];
  if (title) baseArgs.push('--title', title);
  if (model) baseArgs.push('--model', model);
  baseArgs.push('--', message);

  const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (envExe && existsSync(envExe)) {
    return { file: envExe, args: ['agentapi', ...baseArgs] };
  }

  const adjacentLs = join(dirname(process.execPath), 'resources', 'bin', 'language_server.exe');
  if (existsSync(adjacentLs)) {
    return { file: adjacentLs, args: ['agentapi', ...baseArgs] };
  }

  const batPath = join(homedir(), '.gemini', 'antigravity', 'bin', 'agentapi.bat');
  if (existsSync(batPath)) {
    return { file: 'cmd.exe', args: ['/c', batPath, ...baseArgs] };
  }

  throw new Error('Could not locate ANTIGRAVITY_AGENTAPI_EXE, language_server.exe, or agentapi.bat');
}

async function triggerConversation({ message, model, title }) {
  const { file, args } = resolveAgentApiInvocation({ message, model, title });
  const env = {
    ...process.env,
    ANTIGRAVITY_PROJECT_ID: process.env.ANTIGRAVITY_PROJECT_ID || 'outside-of-project',
  };
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf-8',
    timeout: 60000,
    env,
  });

  let conversationId = '';
  const trimmed = (stdout || '').trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      conversationId = extractConversationId(parsed);
    } catch {
      // Output was non-JSON; ignore
    }
  }
  return { conversationId, raw: trimmed };
}

function recordExecution({ slotKey, status, source, conversationId, message, model, error }) {
  const nowIso = new Date().toISOString();
  const state = readJsonSafe(PATHS.state, {
    lastSyncAt: '',
    syncedTasks: [],
    syncError: '',
    firedSlots: {},
  });

  const cutoffMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const firedSlots = {};
  if (state.firedSlots && typeof state.firedSlots === 'object') {
    for (const [k, v] of Object.entries(state.firedSlots)) {
      const m = /^(\d{4}-\d{2}-\d{2})_/.exec(k);
      if (m) {
        const ts = Date.parse(`${m[1]}T00:00:00`);
        if (!Number.isNaN(ts) && ts < cutoffMs) continue;
      }
      firedSlots[k] = v;
    }
  }

  firedSlots[slotKey] = {
    status,
    at: nowIso,
    source,
    conversationId: conversationId || '',
    error: error || '',
  };

  const nextState = {
    lastSyncAt: state.lastSyncAt || '',
    syncedTasks: Array.isArray(state.syncedTasks) ? state.syncedTasks : [],
    syncError: state.syncError || '',
    lastRun: {
      slotKey,
      status,
      at: nowIso,
      source,
      conversationId: conversationId || '',
      error: error || '',
    },
    firedSlots,
  };
  writeJsonAtomic(PATHS.state, nextState);

  const prevHistory = readJsonSafe(PATHS.history, []);
  const nextHistory = [
    {
      slotKey,
      at: nowIso,
      status,
      source,
      conversationId: conversationId || '',
      message,
      model: model || '',
      error: error || '',
    },
    ...(Array.isArray(prevHistory) ? prevHistory : []),
  ].slice(0, 50);
  writeJsonAtomic(PATHS.history, nextHistory);
}

function clearPendingIfMatches(slotKey) {
  const pending = readJsonSafe(PATHS.pending, null);
  if (pending && (!slotKey || pending.slotKey === slotKey)) {
    try {
      unlinkSync(PATHS.pending);
    } catch {
      // Ignore
    }
  }
}

async function runSlot({ slotKey, source, message, model, title, force = false }) {
  if (!force && inFlightSlots.has(slotKey)) {
    return { skipped: true, reason: 'in_flight' };
  }

  const preState = readJsonSafe(PATHS.state, {});
  if (!force && preState?.firedSlots?.[slotKey]?.status === 'ok') {
    clearPendingIfMatches(slotKey);
    return { skipped: true, reason: 'already_fired' };
  }

  inFlightSlots.add(slotKey);
  let locked = false;
  try {
    locked = acquireLock();
    if (!locked) {
      return { skipped: true, reason: 'locked' };
    }

    const curState = readJsonSafe(PATHS.state, {});
    if (!force && curState?.firedSlots?.[slotKey]?.status === 'ok') {
      clearPendingIfMatches(slotKey);
      return { skipped: true, reason: 'already_fired' };
    }

    await waitForLsHealthz(30000);
    const res = await triggerConversation({ message, model, title });
    recordExecution({
      slotKey,
      status: 'ok',
      source,
      conversationId: res.conversationId,
      message,
      model,
      error: '',
    });
    if (!force) {
      clearPendingIfMatches(slotKey);
    }
    return { ok: true, slotKey, conversationId: res.conversationId };
  } catch (err) {
    const errMsg = err?.message || String(err);
    recordExecution({
      slotKey,
      status: 'error',
      source,
      conversationId: '',
      message,
      model,
      error: errMsg,
    });
    if (!force) {
      clearPendingIfMatches(slotKey);
    }
    return { ok: false, slotKey, error: errMsg };
  } finally {
    if (locked) releaseLock();
    inFlightSlots.delete(slotKey);
  }
}

async function schedulerTick() {
  try {
    const schedule = readJsonSafe(PATHS.schedule, defaultSchedule());

    // 1. Check pending_trigger.json placed by wake_and_trigger.ps1
    const pending = readJsonSafe(PATHS.pending, null);
    if (pending && pending.slotKey) {
      const createdMs = Date.parse(pending.createdAt || '');
      if (Number.isNaN(createdMs) || Date.now() - createdMs > PENDING_MAX_AGE_MS) {
        clearPendingIfMatches(pending.slotKey);
      } else if (schedule.enabled) {
        await runSlot({
          slotKey: pending.slotKey,
          source: pending.source || 'task_scheduler',
          message: pending.message || schedule.message || '你好',
          model: pending.model !== undefined ? pending.model : (schedule.model || ''),
          title: pending.title || schedule.title || '额度预热',
        });
      } else {
        clearPendingIfMatches(pending.slotKey);
      }
    }

    // 2. Check active local schedule (including 75s tolerance window)
    if (!schedule.enabled || !schedule.days) return;
    const now = new Date();
    const updatedMs = schedule.updatedAt ? Date.parse(schedule.updatedAt) : 0;
    const dayOffsets = [0, -1];
    const seenDates = new Set();

    for (const offset of dayOffsets) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
      const dateStr = formatLocalDate(d);
      if (seenDates.has(dateStr)) continue;
      seenDates.add(dateStr);

      const dayKey = getDayKey(d);
      const cfg = schedule.days[dayKey];
      if (!cfg?.enabled || !Array.isArray(cfg.times)) continue;

      for (const t of cfg.times) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) continue;
        const [hh, mm] = t.split(':').map((n) => parseInt(n, 10));
        const slotDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
        const diffMs = now.getTime() - slotDate.getTime();
        if (diffMs < 0 || diffMs > SLOT_TOLERANCE_MS) continue;
        // Avoid firing an already-past minute added just seconds ago
        if (updatedMs && !Number.isNaN(updatedMs) && updatedMs > slotDate.getTime() + 5000) continue;

        const slotKey = `${dateStr}_${t}`;
        await runSlot({
          slotKey,
          source: 'sidecar_timer',
          message: schedule.message || '你好',
          model: schedule.model || '',
          title: schedule.title || '额度预热',
        });
      }
    }
  } catch (err) {
    console.error('[quota-warmup] tick error:', err?.message || err);
  }
}

async function main() {
  ensureDataDir();
  if (!existsSync(PATHS.schedule)) {
    writeJsonAtomic(PATHS.schedule, defaultSchedule());
  }
  recordRuntimeInfo();

  const app = new SidecarApp();

  app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
  app.page('/styles.css', () => new Response(
    readFileSync(join(__dirname, 'styles.css'), 'utf-8'),
    { contentType: 'text/css; charset=utf-8' }
  ));
  app.page('/app.js', () => new Response(
    readFileSync(join(__dirname, 'app.js'), 'utf-8'),
    { contentType: 'application/javascript; charset=utf-8' }
  ));

  app.api('/api/state', async () => {
    return buildStatusSnapshot();
  }, 'GET');

  app.api('/api/schedule', async (data) => {
    const current = readJsonSafe(PATHS.schedule, defaultSchedule());
    const validated = validateSchedule(data, current);
    writeJsonAtomic(PATHS.schedule, validated);
    const syncRes = await syncWindowsTasks();
    return {
      ok: Boolean(syncRes.ok),
      sync: syncRes,
      ...buildStatusSnapshot(),
    };
  }, 'POST');

  app.api('/api/sync', async () => {
    const syncRes = await syncWindowsTasks();
    return {
      ok: Boolean(syncRes.ok),
      sync: syncRes,
      ...buildStatusSnapshot(),
    };
  }, 'POST');

  app.api('/api/trigger-now', async (data) => {
    const schedule = readJsonSafe(PATHS.schedule, defaultSchedule());
    const message = (typeof data?.message === 'string' && data.message.trim())
      ? data.message.trim().slice(0, 500)
      : (schedule.message || '你好');
    const title = (typeof data?.title === 'string' && data.title.trim())
      ? data.title.trim().slice(0, 100)
      : (schedule.title || '额度预热');
    const model = typeof data?.model === 'string'
      ? data.model.trim()
      : (schedule.model || '');

    const slotKey = `manual_${Date.now()}`;
    const result = await runSlot({
      slotKey,
      source: 'manual_ui',
      message,
      model,
      title,
      force: true,
    });
    return {
      ...result,
      ...buildStatusSnapshot(),
    };
  }, 'POST');

  app.api('/api/clear-history', async () => {
    writeJsonAtomic(PATHS.history, []);
    return {
      ok: true,
      ...buildStatusSnapshot(),
    };
  }, 'POST');

  await app.run();

  setTimeout(() => {
    schedulerTick();
  }, 1500);
  setInterval(schedulerTick, TICK_INTERVAL_MS);
}

main().catch((err) => {
  console.error('[quota-warmup] fatal error:', err);
  process.exit(1);
});
