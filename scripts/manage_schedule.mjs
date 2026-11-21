import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PLUGIN_ROOT = dirname(__dirname);
export const DATA_DIR = join(PLUGIN_ROOT, 'data');

export const PATHS = {
  schedule: join(DATA_DIR, 'schedule.json'),
  state: join(DATA_DIR, 'state.json'),
  history: join(DATA_DIR, 'history.json'),
  runtime: join(DATA_DIR, 'runtime.json'),
  pending: join(DATA_DIR, 'pending_trigger.json'),
  lock: join(DATA_DIR, 'trigger.lock'),
  wakeLog: join(DATA_DIR, 'wake.log'),
  syncScript: join(__dirname, 'sync_tasks.ps1'),
};

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABELS = {
  mon: '周一',
  tue: '周二',
  wed: '周三',
  thu: '周四',
  fri: '周五',
  sat: '周六',
  sun: '周日',
};
const JS_DAY_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{0,128}$/;

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function defaultSchedule() {
  return {
    version: 1,
    enabled: true,
    message: '你好',
    model: '',
    title: '额度预热',
    runIfMissed: false,
    days: {
      mon: { enabled: false, times: ['08:00'] },
      tue: { enabled: false, times: ['08:00'] },
      wed: { enabled: false, times: ['08:00'] },
      thu: { enabled: false, times: ['08:00'] },
      fri: { enabled: false, times: ['08:00'] },
      sat: { enabled: false, times: ['09:00'] },
      sun: { enabled: false, times: ['09:00'] },
    },
    updatedAt: '',
  };
}

export function readJsonSafe(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    let raw = readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    raw = raw.trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, obj) {
  ensureDataDir();
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
  renameSync(tmp, filePath);
}

export function validateSchedule(input, base = defaultSchedule()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid schedule payload: expected object');
  }

  const out = {
    version: 1,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : Boolean(base.enabled),
    message: base.message || '你好',
    model: base.model || '',
    title: base.title || '额度预热',
    runIfMissed: input.runIfMissed !== undefined ? Boolean(input.runIfMissed) : Boolean(base.runIfMissed),
    days: {},
    updatedAt: new Date().toISOString(),
  };

  if (input.message !== undefined) {
    if (typeof input.message !== 'string') {
      throw new Error('message must be a string');
    }
    const trimmedMsg = input.message.trim();
    if (!trimmedMsg) {
      throw new Error('message cannot be empty');
    }
    if (trimmedMsg.length > 500) {
      throw new Error('message cannot exceed 500 characters');
    }
    out.message = trimmedMsg;
  }

  if (input.model !== undefined) {
    if (typeof input.model !== 'string') {
      throw new Error('model must be a string');
    }
    const trimmedModel = input.model.trim();
    if (!MODEL_RE.test(trimmedModel)) {
      throw new Error('model contains invalid characters');
    }
    out.model = trimmedModel;
  }

  if (input.title !== undefined) {
    if (typeof input.title !== 'string') {
      throw new Error('title must be a string');
    }
    const trimmedTitle = input.title.trim();
    if (trimmedTitle.length > 100) {
      throw new Error('title cannot exceed 100 characters');
    }
    out.title = trimmedTitle || '额度预热';
  }

  const inputDays = input.days && typeof input.days === 'object' ? input.days : {};
  const baseDays = base.days && typeof base.days === 'object' ? base.days : defaultSchedule().days;

  for (const key of DAY_KEYS) {
    const src = inputDays[key] !== undefined ? inputDays[key] : baseDays[key];
    const fallbackDay = baseDays[key] || { enabled: false, times: ['08:00'] };
    if (!src || typeof src !== 'object') {
      out.days[key] = { enabled: false, times: [...fallbackDay.times] };
      continue;
    }

    const dayEnabled = src.enabled !== undefined ? Boolean(src.enabled) : Boolean(fallbackDay.enabled);
    const rawTimes = Array.isArray(src.times) ? src.times : fallbackDay.times;
    const uniqueTimes = new Set();
    for (const t of rawTimes) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (!TIME_RE.test(trimmed)) {
        throw new Error(`Invalid time format for ${key}: "${trimmed}". Expected HH:MM (24-hour).`);
      }
      uniqueTimes.add(trimmed);
      if (uniqueTimes.size >= 8) break;
    }
    const sortedTimes = [...uniqueTimes].sort();
    out.days[key] = {
      enabled: dayEnabled,
      times: sortedTimes,
    };
  }

  return out;
}

export function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatLocalHHMM(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function getDayKey(date) {
  return JS_DAY_TO_KEY[date.getDay()];
}

export function computeNextRun(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule?.days) return null;

  let best = null;
  for (let offset = 0; offset <= 7; offset++) {
    const candidateDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
    const dayKey = getDayKey(candidateDay);
    const cfg = schedule.days[dayKey];
    if (!cfg?.enabled || !Array.isArray(cfg.times) || cfg.times.length === 0) continue;

    for (const timeStr of cfg.times) {
      if (!TIME_RE.test(timeStr)) continue;
      const [hh, mm] = timeStr.split(':').map((n) => parseInt(n, 10));
      const candidate = new Date(
        candidateDay.getFullYear(),
        candidateDay.getMonth(),
        candidateDay.getDate(),
        hh,
        mm,
        0,
        0
      );
      if (candidate.getTime() <= now.getTime()) continue;
      if (!best || candidate.getTime() < best.date.getTime()) {
        best = {
          dayKey,
          dayLabel: DAY_LABELS[dayKey],
          time: timeStr,
          date: candidate,
          iso: candidate.toISOString(),
          localDisplay: `${formatLocalDate(candidate)} ${timeStr} (${DAY_LABELS[dayKey]})`,
        };
      }
    }
  }

  return best ? {
    dayKey: best.dayKey,
    dayLabel: best.dayLabel,
    time: best.time,
    iso: best.iso,
    localDisplay: best.localDisplay,
  } : null;
}

export async function syncWindowsTasks() {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PATHS.syncScript],
    { encoding: 'utf-8', timeout: 30000 }
  );
  const text = (stdout || '').trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  try {
    return JSON.parse(lastLine);
  } catch {
    return {
      ok: false,
      syncedTasks: [],
      lastSyncAt: new Date().toISOString(),
      error: stderr || text || 'Failed to parse sync_tasks.ps1 output',
    };
  }
}

export function buildStatusSnapshot() {
  const schedule = readJsonSafe(PATHS.schedule, defaultSchedule());
  const state = readJsonSafe(PATHS.state, {
    lastSyncAt: '',
    syncedTasks: [],
    syncError: '',
    firedSlots: {},
  });
  const history = readJsonSafe(PATHS.history, []);
  const runtime = readJsonSafe(PATHS.runtime, {});
  return {
    schedule,
    state,
    history: Array.isArray(history) ? history : [],
    runtime,
    nextRun: computeNextRun(schedule),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local',
  };
}

function parseCliArgs(argv) {
  const [cmd = 'status', ...rest] = argv;
  let jsonArg = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json' && i + 1 < rest.length) {
      jsonArg = rest[i + 1];
      i++;
    }
  }
  return { cmd, jsonArg };
}

async function runCli() {
  const { cmd, jsonArg } = parseCliArgs(process.argv.slice(2));
  if (cmd === 'status') {
    const snap = buildStatusSnapshot();
    console.log(JSON.stringify({
      ...snap,
      history: snap.history.slice(0, 10),
    }, null, 2));
    return;
  }
  if (cmd === 'history') {
    const history = readJsonSafe(PATHS.history, []);
    console.log(JSON.stringify(Array.isArray(history) ? history : [], null, 2));
    return;
  }
  if (cmd === 'sync') {
    const syncRes = await syncWindowsTasks();
    console.log(JSON.stringify(syncRes, null, 2));
    if (!syncRes.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'set') {
    if (!jsonArg) {
      throw new Error('Missing --json <payload>');
    }
    const parsed = JSON.parse(jsonArg);
    const current = readJsonSafe(PATHS.schedule, defaultSchedule());
    const validated = validateSchedule(parsed, current);
    writeJsonAtomic(PATHS.schedule, validated);
    const syncRes = await syncWindowsTasks();
    console.log(JSON.stringify({
      ok: Boolean(syncRes.ok),
      schedule: validated,
      sync: syncRes,
      nextRun: computeNextRun(validated),
    }, null, 2));
    if (!syncRes.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${cmd}. Supported: status, set --json '...', sync, history`);
}

const isCliMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliMain) {
  runCli().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
