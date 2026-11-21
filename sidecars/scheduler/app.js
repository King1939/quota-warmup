(function () {
  const DAYS = [
    { key: 'mon', label: '周一' },
    { key: 'tue', label: '周二' },
    { key: 'wed', label: '周三' },
    { key: 'thu', label: '周四' },
    { key: 'fri', label: '周五' },
    { key: 'sat', label: '周六' },
    { key: 'sun', label: '周日' },
  ];
  const PRESET_MODELS = new Set(['', 'flash_lite', 'flash', 'pro']);
  const SOURCE_LABELS = {
    sidecar_timer: 'Sidecar 定时',
    task_scheduler: '任务计划唤醒',
    task_scheduler_fallback: '任务计划兜底',
    manual_ui: '手动测试',
  };

  let serverSnapshot = null;
  let draftSchedule = null;
  let isDirty = false;
  let isBusy = false;

  const els = {
    globalEnabled: document.getElementById('global-enabled'),
    nextRunText: document.getElementById('next-run-text'),
    countdownText: document.getElementById('countdown-text'),
    syncCountText: document.getElementById('sync-count-text'),
    syncTimeText: document.getElementById('sync-time-text'),
    syncErrorBanner: document.getElementById('sync-error-banner'),
    toastBanner: document.getElementById('toast-banner'),
    triggerNowBtn: document.getElementById('trigger-now-btn'),
    syncNowBtn: document.getElementById('sync-now-btn'),
    daysList: document.getElementById('days-list'),
    messageInput: document.getElementById('message-input'),
    titleInput: document.getElementById('title-input'),
    modelSelect: document.getElementById('model-select'),
    customModelWrap: document.getElementById('custom-model-wrap'),
    customModelInput: document.getElementById('custom-model-input'),
    runIfMissed: document.getElementById('run-if-missed'),
    dirtyIndicator: document.getElementById('dirty-indicator'),
    saveBtn: document.getElementById('save-btn'),
    historyCount: document.getElementById('history-count'),
    historyList: document.getElementById('history-list'),
    clearHistoryBtn: document.getElementById('clear-history-btn'),
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function showToast(msg, kind = 'ok') {
    els.toastBanner.textContent = msg;
    els.toastBanner.className = `banner ${kind}`;
    setTimeout(() => {
      if (els.toastBanner.textContent === msg) {
        els.toastBanner.classList.add('hidden');
      }
    }, 5000);
  }

  function apiFetch(path, options = {}) {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(path, options);
    }
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(path, { ...options, headers });
  }

  function markDirty(flag = true) {
    isDirty = flag;
    els.dirtyIndicator.classList.toggle('hidden', !isDirty);
    els.saveBtn.classList.toggle('dirty', isDirty);
  }

  function formatCountdown(iso) {
    if (!iso) return '';
    const diffMs = Date.parse(iso) - Date.now();
    if (Number.isNaN(diffMs) || diffMs <= 0) return '即将执行';
    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    const parts = [];
    if (days > 0) parts.push(`${days} 天`);
    if (hours > 0) parts.push(`${hours} 小时`);
    parts.push(`${mins} 分钟后`);
    return parts.join(' ');
  }

  function formatLocalTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function renderStatus() {
    if (!serverSnapshot) return;
    const { state, nextRun, timezone } = serverSnapshot;
    if (!draftSchedule.enabled) {
      els.nextRunText.textContent = '总开关已暂停';
      els.countdownText.textContent = timezone ? `时区：${timezone}` : '';
    } else if (nextRun) {
      els.nextRunText.textContent = nextRun.localDisplay;
      els.countdownText.textContent = `${formatCountdown(nextRun.iso)} · ${timezone || '本地时间'}`;
    } else {
      els.nextRunText.textContent = '未启用任何时段';
      els.countdownText.textContent = '请在下方开启至少一天并添加时间';
    }

    const syncedCount = Array.isArray(state?.syncedTasks) ? state.syncedTasks.length : 0;
    els.syncCountText.textContent = `${syncedCount} 个已同步任务`;
    els.syncTimeText.textContent = state?.lastSyncAt ? `上次同步：${formatLocalTime(state.lastSyncAt)}` : '尚未同步';

    if (state?.syncError) {
      els.syncErrorBanner.textContent = `任务同步异常：${state.syncError}`;
      els.syncErrorBanner.classList.remove('hidden');
    } else {
      els.syncErrorBanner.classList.add('hidden');
    }
  }

  function renderDays() {
    els.daysList.innerHTML = '';
    for (const day of DAYS) {
      const cfg = draftSchedule.days[day.key] || { enabled: false, times: [] };

      const row = document.createElement('div');
      row.className = `day-row${cfg.enabled ? '' : ' disabled'}`;

      const top = document.createElement('div');
      top.className = 'day-top';

      const left = document.createElement('div');
      left.className = 'day-label-wrap';

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'switch';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(cfg.enabled);
      checkbox.addEventListener('change', () => {
        cfg.enabled = checkbox.checked;
        if (cfg.enabled && cfg.times.length === 0) {
          cfg.times.push('08:00');
        }
        markDirty(true);
        renderDays();
      });
      const slider = document.createElement('span');
      slider.className = 'slider';
      toggleLabel.append(checkbox, slider);

      const nameEl = document.createElement('span');
      nameEl.className = 'day-name';
      nameEl.textContent = day.label;

      const countEl = document.createElement('span');
      countEl.className = 'day-count';
      countEl.textContent = cfg.enabled ? `${cfg.times.length} 个时段` : '未启用';

      left.append(toggleLabel, nameEl, countEl);

      const addWrap = document.createElement('div');
      addWrap.className = 'day-add-wrap';
      const timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.className = 'time-input';
      timeInput.value = '08:00';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-ghost btn-sm';
      addBtn.textContent = '+ 添加';
      addBtn.addEventListener('click', () => {
        const val = (timeInput.value || '').trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) {
          showToast('请选择有效的 24 小时制时间（HH:MM）', 'error');
          return;
        }
        if (cfg.times.includes(val)) {
          showToast(`${day.label} 已存在 ${val}`, 'error');
          return;
        }
        if (cfg.times.length >= 8) {
          showToast(`${day.label} 最多支持 8 个时间点`, 'error');
          return;
        }
        cfg.times.push(val);
        cfg.times.sort();
        cfg.enabled = true;
        markDirty(true);
        renderDays();
      });

      addWrap.append(timeInput, addBtn);
      top.append(left, addWrap);

      const timesWrap = document.createElement('div');
      timesWrap.className = 'times-wrap';
      if (cfg.times.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'empty-times';
        empty.textContent = '暂无时间点，请在右侧选择时间并点击“+ 添加”';
        timesWrap.append(empty);
      } else {
        for (const t of cfg.times) {
          const pill = document.createElement('span');
          pill.className = 'time-pill';
          const textNode = document.createTextNode(t);
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'time-remove';
          rmBtn.title = `删除 ${t}`;
          rmBtn.textContent = '×';
          rmBtn.addEventListener('click', () => {
            cfg.times = cfg.times.filter((x) => x !== t);
            markDirty(true);
            renderDays();
          });
          pill.append(textNode, rmBtn);
          timesWrap.append(pill);
        }
      }

      row.append(top, timesWrap);
      els.daysList.append(row);
    }
  }

  function renderParams() {
    els.globalEnabled.checked = Boolean(draftSchedule.enabled);
    els.messageInput.value = draftSchedule.message || '你好';
    els.titleInput.value = draftSchedule.title || '额度预热';
    els.runIfMissed.checked = Boolean(draftSchedule.runIfMissed);

    const m = draftSchedule.model || '';
    if (PRESET_MODELS.has(m)) {
      els.modelSelect.value = m;
      els.customModelWrap.classList.add('hidden');
      els.customModelInput.value = '';
    } else {
      els.modelSelect.value = '__custom__';
      els.customModelWrap.classList.remove('hidden');
      els.customModelInput.value = m;
    }
  }

  function renderHistory() {
    const history = Array.isArray(serverSnapshot?.history) ? serverSnapshot.history : [];
    els.historyCount.textContent = history.length > 0 ? `(${history.length})` : '';
    els.historyList.innerHTML = '';

    if (history.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '暂无执行记录';
      els.historyList.append(p);
      return;
    }

    for (const item of history.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'history-item';

      const top = document.createElement('div');
      top.className = 'history-top';

      const timeEl = document.createElement('strong');
      timeEl.textContent = formatLocalTime(item.at);

      const badge = document.createElement('span');
      const isOk = item.status === 'ok';
      badge.className = `badge ${isOk ? 'ok' : 'error'}`;
      badge.textContent = isOk ? '成功' : '失败';
      top.append(timeEl, badge);

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const srcLabel = SOURCE_LABELS[item.source] || item.source || '未知来源';
      const infoSpan = document.createElement('span');
      infoSpan.textContent = `来源：${srcLabel} · 消息：“${item.message || '你好'}”${item.model ? ` · 模型：${item.model}` : ''}`;
      meta.append(infoSpan);

      if (item.conversationId && window.sidecar?.ui?.toggleConversation) {
        const jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'btn-link';
        jumpBtn.textContent = '打开对话';
        jumpBtn.addEventListener('click', () => {
          window.sidecar.ui.toggleConversation(item.conversationId);
        });
        meta.append(jumpBtn);
      }

      row.append(top, meta);
      if (item.error) {
        const errEl = document.createElement('div');
        errEl.className = 'history-err';
        errEl.textContent = item.error;
        row.append(errEl);
      }
      els.historyList.append(row);
    }
  }

  function renderAll() {
    renderStatus();
    renderDays();
    renderParams();
    renderHistory();
  }

  function setBusy(busy) {
    isBusy = busy;
    els.saveBtn.disabled = busy;
    els.triggerNowBtn.disabled = busy;
    els.syncNowBtn.disabled = busy;
  }

  async function loadState(preserveDraft = false) {
    try {
      const res = await apiFetch('/api/state', { method: 'GET' });
      if (!res.ok) throw new Error(await res.text());
      serverSnapshot = await res.json();
      if (!preserveDraft || !isDirty || !draftSchedule) {
        draftSchedule = deepClone(serverSnapshot.schedule);
        markDirty(false);
        renderAll();
      } else {
        renderStatus();
        renderHistory();
      }
    } catch (err) {
      showToast(`读取状态失败：${err.message}`, 'error');
    }
  }

  function syncDraftInputs() {
    draftSchedule.enabled = els.globalEnabled.checked;
    draftSchedule.message = els.messageInput.value.trim();
    draftSchedule.title = els.titleInput.value.trim();
    draftSchedule.runIfMissed = els.runIfMissed.checked;
    if (els.modelSelect.value === '__custom__') {
      draftSchedule.model = els.customModelInput.value.trim();
    } else {
      draftSchedule.model = els.modelSelect.value;
    }
  }

  function bindEvents() {
    els.globalEnabled.addEventListener('change', () => {
      draftSchedule.enabled = els.globalEnabled.checked;
      markDirty(true);
      renderStatus();
    });

    els.messageInput.addEventListener('input', () => markDirty(true));
    els.titleInput.addEventListener('input', () => markDirty(true));
    els.runIfMissed.addEventListener('change', () => markDirty(true));
    els.customModelInput.addEventListener('input', () => markDirty(true));

    els.modelSelect.addEventListener('change', () => {
      const isCustom = els.modelSelect.value === '__custom__';
      els.customModelWrap.classList.toggle('hidden', !isCustom);
      markDirty(true);
    });

    document.querySelectorAll('.chip-btn[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        if (preset === 'weekdays') {
          for (const d of DAYS) {
            const isWeekday = !['sat', 'sun'].includes(d.key);
            draftSchedule.days[d.key] = {
              enabled: isWeekday,
              times: isWeekday ? ['08:00'] : [],
            };
          }
          draftSchedule.enabled = true;
        } else if (preset === 'everyday') {
          for (const d of DAYS) {
            draftSchedule.days[d.key] = { enabled: true, times: ['08:00'] };
          }
          draftSchedule.enabled = true;
        } else if (preset === 'clear') {
          for (const d of DAYS) {
            draftSchedule.days[d.key].enabled = false;
          }
        }
        markDirty(true);
        renderAll();
      });
    });

    els.saveBtn.addEventListener('click', async () => {
      if (isBusy) return;
      syncDraftInputs();
      if (!draftSchedule.message) {
        showToast('发送消息内容不能为空', 'error');
        return;
      }
      setBusy(true);
      try {
        const res = await apiFetch('/api/schedule', {
          method: 'POST',
          body: JSON.stringify(draftSchedule),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存失败');
        serverSnapshot = data;
        draftSchedule = deepClone(data.schedule);
        markDirty(false);
        renderAll();
        if (data.ok) {
          const count = data.sync?.syncedTasks?.length ?? 0;
          showToast(`已保存并同步 ${count} 个 Windows 计划任务`, 'ok');
        } else {
          showToast(`配置已保存，但任务同步失败：${data.sync?.error || '未知错误'}`, 'error');
        }
      } catch (err) {
        showToast(`保存失败：${err.message}`, 'error');
      } finally {
        setBusy(false);
      }
    });

    els.syncNowBtn.addEventListener('click', async () => {
      if (isBusy) return;
      setBusy(true);
      try {
        const res = await apiFetch('/api/sync', { method: 'POST', body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '同步失败');
        serverSnapshot = data;
        renderStatus();
        showToast(`已重新同步 ${data.sync?.syncedTasks?.length ?? 0} 个系统任务`, data.ok ? 'ok' : 'error');
      } catch (err) {
        showToast(`同步失败：${err.message}`, 'error');
      } finally {
        setBusy(false);
      }
    });

    els.triggerNowBtn.addEventListener('click', async () => {
      if (isBusy) return;
      syncDraftInputs();
      setBusy(true);
      try {
        const res = await apiFetch('/api/trigger-now', {
          method: 'POST',
          body: JSON.stringify({
            message: draftSchedule.message || '你好',
            title: draftSchedule.title || '额度预热',
            model: draftSchedule.model || '',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '触发失败');
        serverSnapshot = data;
        renderHistory();
        if (data.ok) {
          showToast(
            data.conversationId
              ? `已成功发送预热消息（对话 ID: ${data.conversationId.slice(0, 8)}…）`
              : '已成功发送预热消息',
            'ok'
          );
        } else {
          showToast(`发送失败：${data.error || '未知错误'}`, 'error');
        }
      } catch (err) {
        showToast(`测试发送失败：${err.message}`, 'error');
      } finally {
        setBusy(false);
      }
    });

    els.clearHistoryBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const res = await apiFetch('/api/clear-history', { method: 'POST', body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '清空失败');
        serverSnapshot = data;
        renderHistory();
        showToast('已清空执行记录', 'ok');
      } catch (err) {
        showToast(`清空失败：${err.message}`, 'error');
      }
    });
  }

  bindEvents();
  loadState(false);
  setInterval(() => {
    loadState(true);
  }, 15000);
})();
