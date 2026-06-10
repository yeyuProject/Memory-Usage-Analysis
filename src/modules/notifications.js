// Notifications module: threshold-based alerts + history log.
//
// Each rule has a threshold (in bytes). When ANY process crosses the
// threshold (rising edge), we add a warn entry to notifyHistory and
// show a toast. When the trigger condition ends (falling edge), we
// add an info "recovery" entry. History is capped at 20 entries.
//
// Notifications are gated by the "enable" checkbox in the filter tab.
// During a single check pass we set `isNotifying` to prevent recursive
// updates if renderRules/renderHistory somehow feed back.

const state = require('./state');
const { el, escapeHtml, formatBytes, showToast } = require('./utils');

const HISTORY_LIMIT = 20;

function addHistoryEntry(text) {
  state.notifyHistory.unshift({ id: 'notif_' + Date.now(), time: Date.now(), text });
  if (state.notifyHistory.length > HISTORY_LIMIT) {
    state.notifyHistory = state.notifyHistory.slice(0, HISTORY_LIMIT);
  }
}

/**
 * Evaluate all notify rules against the current process list. Called
 * every refresh tick from the main refresh loop.
 */
function checkNotifications() {
  const enabled = el('notifyEnabled');
  if (!enabled || !enabled.checked || state.isNotifying || state.notifyRules.length === 0) return;
  state.isNotifying = true;
  let changed = false;
  state.notifyRules.forEach(rule => {
    const target = state.allProcesses.find(p => p.memoryUsage >= rule.threshold);
    if (target && !rule.triggered) {
      // Rising edge: process just crossed the threshold
      rule.triggered = true;
      const text = target.name + ' (PID ' + target.pid + ') ' + rule.metric +
        ' 达到 ' + formatBytes(target.memoryUsage) +
        ' (阈值 ' + formatBytes(rule.threshold) + ')';
      addHistoryEntry(text);
      showToast(text, 'warn');
      changed = true;
    } else if (!target && rule.triggered) {
      // Falling edge: process dropped below threshold (recovery)
      rule.triggered = false;
      const text = rule.metric + ' 已回落至阈值以下 (阈值 ' + formatBytes(rule.threshold) + ')';
      addHistoryEntry(text);
      showToast(text, 'info');
      changed = true;
    }
  });
  if (changed) { renderRules(); renderHistory(); }
  state.isNotifying = false;
}

function renderHistory() {
  const list = el('historyList');
  if (!list) return;
  if (state.notifyHistory.length === 0) {
    list.className = 'empty';
    list.textContent = '无通知历史';
    return;
  }
  list.className = '';
  list.innerHTML = state.notifyHistory.map(h =>
    '<div class="history-item"><b>' + new Date(h.time).toLocaleTimeString() +
    '</b> - ' + escapeHtml(h.text) + '</div>'
  ).join('');
}

/**
 * Add a new threshold rule. Reads form inputs, validates, appends.
 */
function addRule() {
  const nameEl = el('ruleMetric');
  const threshEl = el('ruleThreshold');
  if (!nameEl || !threshEl) return;
  const metric = nameEl.value.trim();
  const threshold = Number(threshEl.value);
  if (!metric || !Number.isFinite(threshold) || threshold <= 0) {
    showToast('请填写指标名和正数阈值', 'warn');
    return;
  }
  state.notifyRules.push({ metric, threshold, triggered: false });
  renderRules();
  showToast('规则已添加: ' + metric + ' ≥ ' + formatBytes(threshold * 1024 * 1024), 'info');
}

function clearFilter() {
  state.filterCriteria = { processIds: [], metrics: ['workingSetSize','privateWorkingSetSize','commitSize'], minMem: null, maxMem: null };
  el('minMem').value = '';
  el('maxMem').value = '';
  el('filterProcess').selectedIndex = -1;
  document.querySelectorAll('.metric-cb').forEach(cb => cb.checked = true);
  showToast('筛选已清空', 'info');
}

function applyFilter() {
  state.filterCriteria.processIds = Array.from(el('filterProcess').selectedOptions).map(o => Number(o.value));
  state.filterCriteria.metrics = Array.from(document.querySelectorAll('.metric-cb:checked')).map(cb => cb.value);
  state.filterCriteria.minMem = el('minMem').value ? Number(el('minMem').value) : null;
  state.filterCriteria.maxMem = el('maxMem').value ? Number(el('maxMem').value) : null;
  showToast('筛选已应用', 'info');
}

function renderRules() {
  const tbody = el('ruleTbody');
  if (!tbody) return;
  if (state.notifyRules.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无规则, 添加阈值规则触发通知</td></tr>';
    return;
  }
  tbody.innerHTML = state.notifyRules.map((r, i) =>
    '<tr>' +
    '<td>' + escapeHtml(r.metric) + '</td>' +
    '<td>' + formatBytes(r.threshold) + '</td>' +
    '<td><span style="color:' + (r.triggered ? '#ff4d4f' : '#52c41a') + '">' +
    (r.triggered ? '已触发' : '正常') +
    '</span></td></tr>'
  ).join('');
}

// Display limits — must match the constants in process-table.js so the
// filter <select> doesn't lag the main table.
const PROCESS_TABLE_LIMIT = 200;

/**
 * Populate the filter-process <select> with currently-available processes.
 * Uses the same limit as the main process table.
 */
function populateFilterProcesses() {
  const sel = el('filterProcess');
  if (!sel) return;
  const current = new Set(Array.from(sel.selectedOptions).map(o => Number(o.value)));
  sel.innerHTML = state.allProcesses.slice(0, PROCESS_TABLE_LIMIT).map(p =>
    '<option value="' + p.pid + '"' + (current.has(p.pid) ? ' selected' : '') + '>' +
    escapeHtml(p.name) + ' (' + p.pid + ') - ' + formatBytes(p.memoryUsage) + '</option>'
  ).join('');
}

/**
 * Wire click handlers for the notification tab controls.
 */
function bindNotificationEvents() {
  const ruleAdd = el('ruleAdd');
  if (ruleAdd) ruleAdd.addEventListener('click', addRule);
  const filterApply = el('filterApply');
  if (filterApply) filterApply.addEventListener('click', applyFilter);
  const filterClear = el('filterClear');
  if (filterClear) filterClear.addEventListener('click', clearFilter);
}

module.exports = {
  checkNotifications,
  renderHistory,
  addRule,
  clearFilter,
  applyFilter,
  renderRules,
  populateFilterProcesses,
  bindNotificationEvents,
};