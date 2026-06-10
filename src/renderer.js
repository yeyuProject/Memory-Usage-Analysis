/**
 * Memory Usage Analysis - Renderer (orchestrator)
 *
 * Thin wiring layer: holds DOM element references, runs the refresh loop,
 * wires module event bindings, switches tabs, handles the context menu.
 * All real logic lives in src/modules/.
 *
 * Architecture (post-cleanup-3-step):
 *   src/modules/
 *     state.js          — shared mutable state (getters/setters via accessors)
 *     utils.js          — DOM helpers, formatters, escapeHtml
 *     charts.js         — Canvas drawing (bar/pie/line)
 *     search.js         — compileSearchMatcher, getHighlightRe, highlight
 *     process-table.js  — renderTable, renderSpikes, renderLeaks, etc.
 *     recordings.js     — start/stop/list/delete/export recording
 *     notifications.js  — threshold rules + history
 *     export.js         — exportReport, exportHistorySnapshot
 *     config.js         — user thresholds (loaded from main process)
 */

const state = require('./modules/state');
const { el, setStatus, formatBytes, showToast } = require('./modules/utils');
const processTable = require('./modules/process-table');
const recordings = require('./modules/recordings');
const notifications = require('./modules/notifications');
const exporter = require('./modules/export');
const config = require('./modules/config');
const charts = require('./modules/charts');
const { COLORS, loadColor } = require('./modules/theme');

const REFRESH_INTERVAL_MS = config.REFRESH_INTERVAL_MS;

// ===== Element references =====
const els = {
  totalMem: el('totalMem'),
  freeMem: el('freeMem'),
  memLoad: el('memLoad'),
  procCount: el('procCount'),
  lastUpdate: el('lastUpdate'),
  status: el('status'),
  collectorStats: el('collectorStats'),
  toast: el('toast'),
  searchInput: el('searchInput'),
  searchClear: el('searchClear'),
  searchMatchCount: el('searchMatchCount'),
  refreshBtn: el('refreshBtn'),
  tbody: el('tbody'),
  spikeTbody: el('spikeTbody'),
  spikeHint: el('spikeHint'),
  leakTbody: el('leakTbody'),
  ctxMenu: el('ctxMenu'),
  recStart: el('recStart'),
  recStop: el('recStop'),
  recStatus: el('recStatus'),
  recInterval: el('recInterval'),
  recTopN: el('recTopN'),
  recTbody: el('recTbody'),
  ruleAdd: el('ruleAdd'),
  ruleTbody: el('ruleTbody'),
  ruleMetric: el('ruleMetric'),
  ruleThreshold: el('ruleThreshold'),
  notifyEnabled: el('notifyEnabled'),
  filterApply: el('filterApply'),
  filterClear: el('filterClear'),
  filterProcess: el('filterProcess'),
  minMem: el('minMem'),
  maxMem: el('maxMem'),
  chartProcess: el('chartProcess'),
  historyList: el('historyList'),
  cfgSpikeThreshold: el('cfgSpikeThreshold'),
  cfgLeakThreshold: el('cfgLeakThreshold'),
  cfgRecordingTopN: el('cfgRecordingTopN'),
  cfgSave: el('cfgSave'),
  cfgReset: el('cfgReset'),
  cfgStatus: el('cfgStatus'),
  exportFormat: el('exportFormat'),
  exportAll: el('exportAll'),
  exportBtn: el('exportBtn'),
  exportPreview: el('exportPreview'),
  snapshotBtn: el('snapshotBtn'),
  copyTop50Btn: el('copyTop50Btn'),
};

// ===== Dashboard chart wrappers =====
function renderSystem(sys) {
  if (!sys) return;
  els.totalMem.textContent = formatBytes(sys.totalPhysicalMemory);
  els.freeMem.textContent = formatBytes(sys.availablePhysicalMemory);
  els.memLoad.textContent = sys.memoryLoad + '%';
  els.memLoad.style.color = loadColor(sys.memoryLoad);
  els.procCount.textContent = state.allProcesses.length;
}

function renderDashCharts() {
  charts.drawBarChart(el('dashBarChart'), state.allProcesses);
  if (state.systemCache) {
    charts.drawPieChart(el('dashPie'), [
      { name: '已用', value: state.systemCache.totalPhysicalMemory - state.systemCache.availablePhysicalMemory, color: COLORS.DANGER },
      { name: '可用', value: state.systemCache.availablePhysicalMemory, color: COLORS.SUCCESS },
    ]);
  }
}

// ===== Main refresh loop =====
async function refresh() {
  if (state.isRefreshing) return;
  state.isRefreshing = true;
  try {
    const [sys, procs, history] = await Promise.all([
      state.api.getSystemInfo(),
      state.api.getProcesses(),
      state.api.getProcessHistory(),
    ]);
    state.allProcesses = procs || [];
    state.processHistory = history || {};
    state.systemCache = sys;
    state.sysTotalCache = (sys && sys.totalPhysicalMemory) ? sys.totalPhysicalMemory : 1;
    state.sysUsedCache = (sys && sys.totalPhysicalMemory)
      ? Math.max(sys.totalPhysicalMemory - sys.availablePhysicalMemory, 1)
      : 1;
    renderSystem(sys);
    processTable.renderTable();
    renderDashCharts();
    processTable.renderSpikes();
    processTable.renderLeaks();
    processTable.renderChartPage();
    notifications.populateFilterProcesses();
    notifications.checkNotifications();
    els.lastUpdate.textContent = '更新: ' + new Date().toLocaleTimeString();
    setStatus('已加载 ' + state.allProcesses.length + ' 个进程');
    config.updateCollectorStats();
  } catch (e) {
    setStatus('错误: ' + e.message);
  } finally {
    state.isRefreshing = false;
  }
}

// ===== Tab switching =====
function switchTab(name) {
  state.currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'charts') processTable.renderChartPage();
}

// ===== Context menu =====
let ctxTargetPid = null;
let ctxTargetName = null;
function showContextMenu(x, y, pid, name) {
  ctxTargetPid = pid;
  ctxTargetName = name;
  const menu = els.ctxMenu;
  menu.innerHTML =
    '<div class="ctx-item" data-action="copy-pid">📋 复制 PID</div>' +
    '<div class="ctx-item" data-action="copy-name">📋 复制名称</div>' +
    '<div class="ctx-divider"></div>' +
    '<div class="ctx-item" data-action="open-location">📂 打开文件位置</div>' +
    '<div class="ctx-item" data-action="select">✓ 选中并查看详情</div>' +
    '<div class="ctx-divider"></div>' +
    '<div class="ctx-item danger" data-action="kill">⚠ 结束进程</div>';
  const w = 200, h = 240;
  const px = Math.min(x, window.innerWidth - w - 8);
  const py = Math.min(y, window.innerHeight - h - 8);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
  menu.classList.add('show');
}
function hideContextMenu() {
  els.ctxMenu.classList.remove('show');
  ctxTargetPid = null;
  ctxTargetName = null;
}
async function handleContextAction(action) {
  const pid = ctxTargetPid;
  const name = ctxTargetName;
  hideContextMenu();
  if (pid == null || !name) return;
  if (action === 'copy-pid') {
    await state.api.writeClipboard(String(pid));
    showToast('已复制 PID: ' + pid, 'info');
  } else if (action === 'copy-name') {
    await state.api.writeClipboard(name);
    showToast('已复制: ' + name, 'info');
  } else if (action === 'open-location') {
    const r = await state.api.openFileLocation(name);
    if (r.success) showToast('已打开文件位置: ' + (r.path || ''), 'info');
    else showToast('打开失败: ' + r.error, 'error');
  } else if (action === 'select') {
    processTable.showDetail(pid);
    document.querySelectorAll('#processTbody tr').forEach(row => row.classList.remove('selected'));
    const tr = document.querySelector('#processTbody tr[data-pid="' + pid + '"]');
    if (tr) tr.classList.add('selected');
  } else if (action === 'kill') {
    if (!confirm('确定要结束进程 ' + name + ' (PID: ' + pid + ')?\n这将强制终止该进程，可能导致数据丢失。')) return;
    const r = await state.api.killProcess(pid);
    if (r.success) {
      showToast('已结束进程 ' + name + ' (PID: ' + pid + ')', 'info');
      setTimeout(refresh, 500);
    } else {
      showToast('结束失败: ' + r.error, 'error');
    }
  }
}

// ===== Event wiring =====
function wireEvents() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.go)));

  // Sortable columns
  document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'name' ? 'asc' : 'desc';
    }
    processTable.renderTable();
  }));

  // Refresh + search
  els.refreshBtn.addEventListener('click', refresh);
  els.searchInput.addEventListener('input', () => processTable.renderTable());
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    processTable.renderTable();
    els.searchInput.focus();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+F focuses search box
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
    // Escape: clear search if input focused, hide ctx menu otherwise
    if (e.key === 'Escape') {
      if (document.activeElement === els.searchInput) {
        els.searchInput.value = '';
        processTable.renderTable();
        els.searchInput.blur();
      } else {
        hideContextMenu();
      }
    }
  });

  // Process table interactions
  els.tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.pid) return;
    processTable.showDetail(Number(tr.dataset.pid));
    document.querySelectorAll('#processTbody tr').forEach(r => r.classList.remove('selected'));
    tr.classList.add('selected');
  });
  els.tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.pid) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, Number(tr.dataset.pid), tr.children[1].textContent);
  });

  // Dashboard card clicks: jump to process detail
  function jumpToProcess(e) {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.pid) return;
    state.selectedPid = Number(tr.dataset.pid);
    processTable.showDetail(state.selectedPid);
    switchTab('processes');
    processTable.renderTable();
  }
  els.spikeTbody.addEventListener('click', jumpToProcess);
  els.leakTbody.addEventListener('click', jumpToProcess);

  // Context menu actions
  els.ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    handleContextAction(item.dataset.action);
  });
  document.addEventListener('click', hideContextMenu);

  // Module-specific event wiring
  recordings.bindRecordingsEvents();
  notifications.bindNotificationEvents();
  exporter.bindExportEvents();
  config.bindConfigEvents();
}

// ===== Startup =====
async function init() {
  wireEvents();
  // Load config (applies thresholds + populates inputs)
  await config.loadConfig().catch(err => console.error('config load failed:', err));
  // Load recordings from disk (handles crash recovery)
  await recordings.loadRecordings();
  const status = await state.api.getRecordingStatus();
  if (status.active) {
    state.activeRecording = status;
    els.recStart.disabled = true;
    els.recStop.disabled = false;
    const interval = status.interval || 2000;
    if (state.statusPollTimer) clearInterval(state.statusPollTimer);
    state.statusPollTimer = setInterval(recordings.updateRecStatus, interval);
    await recordings.updateRecStatus();
  }
  // Initial render + start refresh loop
  refresh();
  state.refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  // Pause refresh when tab is hidden (saves CPU when minimized)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    } else {
      if (!state.refreshTimer) {
        refresh(); // immediate catch-up
        state.refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}