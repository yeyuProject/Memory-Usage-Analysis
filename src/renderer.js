/**
 * Memory Usage Analysis - Renderer (vanilla JS)
 * Polls main process via IPC. All charts use pure Canvas (no libraries).
 */

const api = window.electronAPI;

const $ = (id) => document.getElementById(id);
const els = {
  totalMem: $('totalMem'),
  freeMem: $('freeMem'),
  memLoad: $('memLoad'),
  procCount: $('procCount'),
  lastUpdate: $('lastUpdate'),
  status: $('status'),
  collectorStats: $('collectorStats'),
  toast: $('toast'),
  searchInput: $('searchInput'),
  searchClear: $('searchClear'),
  searchMatchCount: $('searchMatchCount'),
  refreshBtn: $('refreshBtn'),
  tbody: $('processTbody'),
  detailCard: $('detailCard'),
  detailTitle: $('detailTitle'),
  dWS: $('dWS'),
  dPWS: $('dPWS'),
  dCommit: $('dCommit'),
  bWS: $('bWS'),
  bPWS: $('bPWS'),
  bCommit: $('bCommit'),
  chartProcess: $('chartProcess'),
  recTopN: $('recTopN'),
  recInterval: $('recInterval'),
  cfgSpikeThreshold: $('cfgSpikeThreshold'),
  cfgLeakThreshold: $('cfgLeakThreshold'),
  cfgRecordingTopN: $('cfgRecordingTopN'),
  cfgSave: $('cfgSave'),
  cfgReset: $('cfgReset'),
  cfgStatus: $('cfgStatus'),
  leakThresholdHint: $('leakThresholdHint'),
  recDuration: $('recDuration'),
  recStart: $('recStart'),
  recStop: $('recStop'),
  recStatus: $('recStatus'),
  recTbody: $('recTbody'),
  filterProcess: $('filterProcess'),
  filterApply: $('filterApply'),
  filterClear: $('filterClear'),
  filterCount: $('filterCount'),
  notifyEnabled: $('notifyEnabled'),
  ruleMetric: $('ruleMetric'),
  ruleThreshold: $('ruleThreshold'),
  ruleAdd: $('ruleAdd'),
  ruleTbody: $('ruleTbody'),
  historyList: $('historyList'),
  exportFormat: $('exportFormat'),
  exportAll: $('exportAll'),
  exportBtn: $('exportBtn'),
  exportPreview: $('exportPreview'),
  snapshotBtn: $('snapshotBtn'),
  copyTop50Btn: $('copyTop50Btn'),
  spikeTbody: $('spikeTbody'),
  spikeHint: $('spikeHint'),
  leakTbody: $('leakTbody'),
  ctxMenu: $('ctxMenu'),
};

// Memory estimation ratios (these are rough approximations; real values
// would require per-process WMI queries for Private Bytes and Commit Size)
const MEM_RATIOS = {
  PRIVATE_RATIO: 0.7,   // Private working set ≈ 70% of working set
  COMMIT_RATIO: 1.3,    // Commit size ≈ 130% of working set (includes paged)
};

let allProcesses = [];
let processHistory = {};   // pid -> { baseline, peak, peakTime, current, spikePercent, sampleCount }
let selectedPid = null;
let refreshTimer = null;
let recordings = [];
let activeRecording = null;
let activeRecordingTimer = null;
let filterCriteria = { processIds: [], metrics: ['workingSetSize','privateWorkingSetSize','commitSize'], minMem: null, maxMem: null };
let notifyRules = [];
let notifyHistory = [];
let isNotifying = false;
let currentTab = 'dashboard';
let systemCache = null;
let sysUsedCache = 1;          // cached used-memory (kept for potential reuse)
let sysTotalCache = 1;         // cached total-memory for percentage calculations
let isRefreshing = false;     // reentrancy guard for refresh()
let isDrawing = false;         // reentrancy guard for chart drawing
let sortKey = 'memoryUsage';  // current sort column
let sortDir = 'desc';         // 'asc' | 'desc'

// ============================================================================
// CONSTANTS
// ============================================================================
//
// Magic numbers extracted into named constants so the intent is obvious and
// changes happen in one place. UI thresholds (spike/leak) are loaded from
// user config (see applyConfig()) but defaults live here.

// Spike detection: a process's current memory must deviate from its running
// baseline by >= this many percent to be flagged as a "spike". Also requires
// at least SPIKE_MIN_SAMPLES samples to establish a meaningful baseline.
const SPIKE_THRESHOLD_DEFAULT = 50;
const SPIKE_MIN_SAMPLES = 5;
const SPIKE_HOT_THRESHOLD = 50;     // >= : red
const SPIKE_WARM_THRESHOLD = 20;    // >= : orange
const SPIKE_COOL_THRESHOLD = -20;   // <= : green (memory released)

// Leak detection: a process's linear-regression slope-per-window must exceed
// this percent to be flagged as a "leak". Requires LEAK_MIN_SAMPLES for the
// slope to be statistically meaningful.
const LEAK_THRESHOLD_DEFAULT = 30;
const LEAK_MIN_SAMPLES = 10;

// Display limits: how many rows to show in each table. Beyond these counts we
// either paginate (main process table) or just show top-N (spike/leak).
const PROCESS_TABLE_LIMIT = 200;
const DASHBOARD_LIMIT = 10;

// Refresh cadence: must match main process collector interval for clean UX.
const REFRESH_INTERVAL_MS = 2000;

// Theme colors reused across the app. Keep in sync with styles.css.
const COLORS = {
  SPIKE_HOT:  '#ff4d4f',
  SPIKE_WARM: '#faad14',
  SPIKE_COOL: '#52c41a',
  TEXT_DIM:   '#999',
  TEXT_MUTED: '#666',
  PRIMARY:    '#1890ff',
  SUCCESS:    '#52c41a',
  DANGER:     '#ff4d4f',
  WARNING:    '#faad14',
};

// Mutable thresholds (mutated by applyConfig() when user changes settings).
let SPIKE_THRESHOLD = SPIKE_THRESHOLD_DEFAULT;
let LEAK_THRESHOLD  = LEAK_THRESHOLD_DEFAULT;

function formatBytes(b) {
  if (!b || b <= 0) return '0 B';
  const k = 1024, u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(k)));
  return (b / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showToast(msg, type = 'info') {
  els.toast.className = 'toast show ' + type;
  els.toast.textContent = msg;
  setTimeout(() => { els.toast.className = 'toast'; }, 3000);
}
function setStatus(msg) { els.status.textContent = msg; }

// Render the PowerShell collector stats in the status bar. Shows latency of
// the most recent COLLECT roundtrip and total request count, so the user
// can see the long-session optimization is working in real-time.
async function updateCollectorStats() {
  if (!els.collectorStats) return;
  try {
    const stats = await window.electronAPI.getCollectorStats();
    if (!stats.alive) {
      els.collectorStats.textContent = 'PS: 未启动';
      els.collectorStats.style.color = '#999';
      return;
    }
    const lat = stats.lastDurationMs != null ? `${stats.lastDurationMs}ms` : '--';
    const errSuffix = stats.errors > 0 ? ` | 错误 ${stats.errors}` : '';
    const pendSuffix = stats.pending ? ' | 处理中' : '';
    const qSuffix = stats.queueLength > 0 ? ` | 队列 ${stats.queueLength}` : '';
    els.collectorStats.textContent = `PS: ${lat} | 请求 ${stats.requests}${errSuffix}${pendSuffix}${qSuffix}`;
    // Color: green if fast (<200ms), orange if slow (200-500ms), red if very slow (>500ms)
    const d = stats.lastDurationMs;
    if (d == null) els.collectorStats.style.color = '#999';
    else if (d < 200) els.collectorStats.style.color = '#52c41a';
    else if (d < 500) els.collectorStats.style.color = '#faad14';
    else els.collectorStats.style.color = '#ff4d4f';
  } catch (e) {
    els.collectorStats.textContent = 'PS: 错误';
    els.collectorStats.style.color = '#ff4d4f';
  }
}

// ==================== Context Menu ====================
let ctxTargetPid = null;
let ctxTargetName = null;

function showContextMenu(x, y, pid, name) {
  ctxTargetPid = pid;
  ctxTargetName = name;
  const menu = els.ctxMenu;
  menu.innerHTML = `
    <div class="ctx-item" data-action="copy-pid">📋 复制 PID</div>
    <div class="ctx-item" data-action="copy-name">📋 复制名称</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" data-action="open-location">📂 打开文件位置</div>
    <div class="ctx-item" data-action="select">✓ 选中并查看详情</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item danger" data-action="kill">⚠ 结束进程</div>
  `;
  // Position: keep within viewport
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
    await api.writeClipboard(String(pid));
    showToast(`已复制 PID: ${pid}`, 'info');
  } else if (action === 'copy-name') {
    await api.writeClipboard(name);
    showToast(`已复制: ${name}`, 'info');
  } else if (action === 'open-location') {
    const r = await api.openFileLocation(name);
    if (r.success) showToast(`已打开文件位置: ${r.path || ''}`, 'info');
    else showToast(`打开失败: ${r.error}`, 'error');
  } else if (action === 'select') {
    showDetail(pid);
    document.querySelectorAll('#processTbody tr').forEach(row => row.classList.remove('selected'));
    const tr = document.querySelector(`#processTbody tr[data-pid="${pid}"]`);
    if (tr) tr.classList.add('selected');
  } else if (action === 'kill') {
    if (!confirm(`确定要结束进程 ${name} (PID: ${pid})？\n这将强制终止该进程，可能导致数据丢失。`)) return;
    const r = await api.killProcess(pid);
    if (r.success) {
      showToast(`已结束进程 ${name} (PID: ${pid})`, 'info');
      setTimeout(refresh, 500);
    } else {
      showToast(`结束失败: ${r.error}`, 'error');
    }
  }
}

function clearCanvas(ctx) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
function drawAxes(ctx, w, h, padding) {
  ctx.strokeStyle = '#d9d9d9';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, h - padding);
  ctx.lineTo(w - padding, h - padding);
  ctx.stroke();
}
function formatShort(b) {
  if (b >= 1024*1024*1024) return (b/1024/1024/1024).toFixed(1) + 'G';
  if (b >= 1024*1024) return (b/1024/1024).toFixed(0) + 'M';
  if (b >= 1024) return (b/1024).toFixed(0) + 'K';
  return b.toFixed(0);
}

function drawBarChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  clearCanvas(ctx);
  const w = canvas.width, h = canvas.height;
  const padding = { top: 20, right: 60, bottom: 40, left: 120 };
  drawAxes(ctx, w, h, padding.left);

  if (!data || data.length === 0) {
    ctx.fillStyle = '#999'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w/2, h/2);
    return;
  }

  const items = data.slice(0, 10);
  const max = Math.max(...items.map(d => d.memoryUsage), 1);
  const barH = (h - padding.top - padding.bottom) / items.length - 4;

  items.forEach((item, i) => {
    const y = padding.top + i * (barH + 4);
    const barW = ((w - padding.left - padding.right) * item.memoryUsage) / max;
    ctx.fillStyle = '#1890ff';
    ctx.fillRect(padding.left, y, barW, barH);
    ctx.fillStyle = '#333'; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
    const label = item.name.length > 14 ? item.name.slice(0, 13) + '…' : item.name;
    ctx.fillText(label, padding.left - 6, y + barH * 0.7);
    ctx.textAlign = 'left'; ctx.fillStyle = '#666';
    ctx.fillText(formatShort(item.memoryUsage), padding.left + barW + 4, y + barH * 0.7);
  });

  // X-axis tick labels (memory scale)
  ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = padding.left + (i / 4) * (w - padding.left - padding.right);
    const v = (i / 4) * max;
    ctx.fillText(formatShort(v), x, h - padding.bottom + 14);
  }
  ctx.fillStyle = '#666'; ctx.font = '11px sans-serif';
  ctx.fillText('内存 (bytes)', w / 2, h - 5);
}

function drawPieChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  clearCanvas(ctx);
  const w = canvas.width, h = canvas.height;
  if (!data || data.length === 0) {
    ctx.fillStyle = '#999'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w/2, h/2);
    return;
  }
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const cx = w * 0.4, cy = h / 2, r = Math.min(w, h) * 0.32;
  let startAngle = -Math.PI / 2;
  const colors = ['#1890ff', '#52c41a', '#faad14', '#ff4d4f', '#722ed1', '#13c2c2'];
  data.forEach((item, i) => {
    const slice = (item.value / total) * Math.PI * 2;
    const endAngle = startAngle + slice;
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fill();
    startAngle = endAngle;
  });
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  const legendX = w * 0.78, legendY = h * 0.2;
  data.forEach((item, i) => {
    const y = legendY + i * 22;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(legendX, y, 12, 12);
    ctx.fillStyle = '#333';
    const pct = ((item.value / total) * 100).toFixed(1);
    const label = item.name.length > 10 ? item.name.slice(0, 9) + '…' : item.name;
    ctx.fillText(`${label} (${pct}%)`, legendX + 18, y + 10);
  });
}

function drawLineChart(canvas, series) {
  const ctx = canvas.getContext('2d');
  clearCanvas(ctx);
  const w = canvas.width, h = canvas.height;
  const padding = { top: 30, right: 60, bottom: 30, left: 50 };
  drawAxes(ctx, w, h, padding.left);
  if (!series || series.length === 0 || series[0].data.length === 0) {
    ctx.fillStyle = '#999'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无历史数据 (开始录制后查看趋势)', w/2, h/2);
    return;
  }
  const colors = ['#1890ff', '#52c41a', '#faad14'];
  const allValues = series.flatMap(s => s.data.map(d => d.value));
  const max = Math.max(...allValues, 1);
  const dataLen = series[0].data.length;
  const xStep = (w - padding.left - padding.right) / Math.max(dataLen - 1, 1);
  series.forEach((s, idx) => {
    if (s.data.length === 0) return;
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.fillStyle = colors[idx % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.data.forEach((d, i) => {
      const x = padding.left + i * xStep;
      const y = h - padding.bottom - (d.value / max) * (h - padding.top - padding.bottom);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // Y-axis tick labels (memory scale)
  ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (i / 4) * max;
    const y = h - padding.bottom - (i / 4) * (h - padding.top - padding.bottom);
    ctx.fillText(formatShort(v), padding.left - 5, y + 3);
    // gridline
    ctx.strokeStyle = '#f0f0f0';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }
  redrawAxesLine(ctx, w, h, padding.left, padding.right);

  // Legend
  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  series.forEach((s, idx) => {
    ctx.fillStyle = colors[idx % colors.length];
    const y = padding.top - 10 + idx * 16;
    ctx.fillRect(padding.left, y, 12, 8);
    ctx.fillStyle = '#333';
    ctx.fillText(s.name, padding.left + 18, y + 8);
  });
}

function redrawAxesLine(ctx, w, h, left, right) {
  ctx.strokeStyle = '#d9d9d9';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, 30);
  ctx.lineTo(left, h - 30);
  ctx.lineTo(w - right, h - 30);
  ctx.stroke();
}

/**
 * Main refresh loop. Polls the main process for current system + process state,
 * then re-renders all UI panels. Guarded against reentrancy (a slow IPC response
 * must not trigger a second concurrent refresh).
 *
 * @returns {Promise<void>}
 */
async function refresh() {
  if (isRefreshing) return; // prevent reentrancy
  isRefreshing = true;
  try {
    // Fetch all data in parallel — these IPC calls are independent.
    const [sys, procs, history] = await Promise.all([
      api.getSystemInfo(),
      api.getProcesses(),
      api.getProcessHistory(),
    ]);
    allProcesses = procs || [];
    processHistory = history || {};
    systemCache = sys;
    // Cache total-memory for percentage calcs (avoids recomputing in every render)
    sysTotalCache = (sys && sys.totalPhysicalMemory) ? sys.totalPhysicalMemory : 1;
    sysUsedCache = (sys && sys.totalPhysicalMemory)
      ? Math.max(sys.totalPhysicalMemory - sys.availablePhysicalMemory, 1)
      : 1;
    renderSystem(sys);
    renderTable();
    renderDashCharts();
    renderSpikes();
    renderLeaks();
    renderChartPage();
    populateFilterProcesses();
    checkNotifications();
    els.lastUpdate.textContent = '更新: ' + new Date().toLocaleTimeString();
    setStatus(`已加载 ${allProcesses.length} 个进程`);
    updateCollectorStats();
  } catch (e) {
    setStatus('错误: ' + e.message);
  } finally {
    isRefreshing = false;
  }
}

function renderSystem(sys) {
  if (!sys) return;
  els.totalMem.textContent = formatBytes(sys.totalPhysicalMemory);
  els.freeMem.textContent = formatBytes(sys.availablePhysicalMemory);
  els.memLoad.textContent = sys.memoryLoad + '%';
  els.memLoad.style.color = sys.memoryLoad > 80 ? '#ff4d4f' : sys.memoryLoad > 60 ? '#faad14' : '#1890ff';
  els.procCount.textContent = allProcesses.length;
}

// Smart process name matching. Pre-compiles the term into a matcher closure
// that runs in O(orParts) per process instead of re-parsing the term string
// for every process on every render.
//
// Supports:
//   "chrome"        - substring match (default, backward compatible)
//   "chrome*"       - prefix match (must start with "chrome")
//   "chrome;code"   - OR match (any of the terms matches)
//   "chrome*;code"  - prefix + OR combined
// Matching is case-insensitive and also checks PID as a string.
/**
 * Smart process name matcher (pre-compiled). Splits the term on ';' for OR,
 * normalizes each part once, then returns a closure that runs in O(orParts)
 * per process instead of re-parsing the term for every process on every render.
 *
 * Supports:
 *   "chrome"        - substring match (default, backward compatible)
 *   "chrome*"       - prefix match (must start with "chrome")
 *   "chrome;code"   - OR match (any of the terms matches)
 *   "chrome*;code"  - prefix + OR combined
 *
 * @param {string} term - raw search term from the input box (already lowercased)
 * @returns {((p:object)=>boolean)|null} matcher closure, or null if term is empty
 */
function compileSearchMatcher(term) {
  if (!term) return null;
  const orParts = term.split(';').map(s => s.trim()).filter(Boolean);
  if (orParts.length === 0) return null;
  // Pre-normalize each part so the per-process hot path is just comparisons.
  const compiled = orParts.map(part => {
    if (part.endsWith('*')) {
      return { kind: 'prefix', value: part.slice(0, -1) };
    }
    return { kind: 'substring', value: part };
  });
  return (p) => {
    const name = p.name.toLowerCase();
    const pidStr = String(p.pid);
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (c.kind === 'prefix') {
        if (name.startsWith(c.value) || pidStr.startsWith(c.value)) return true;
      } else {
        if (name.includes(c.value) || pidStr.includes(c.value)) return true;
      }
    }
    return false;
  };
}

/**
 * Apply the search box and filter criteria to produce the final process list
 * for the main table. Filters are applied in order from cheapest to most
 * selective: search -> PID whitelist -> min mem -> max mem.
 *
 * @returns {Array<object>} filtered process list (same shape as allProcesses)
 */
function getFilteredProcesses() {
  let list = allProcesses;
  const matcher = compileSearchMatcher(els.searchInput.value.trim().toLowerCase());
  if (matcher) {
    list = list.filter(matcher);
  }
  if (filterCriteria.processIds.length > 0) {
    list = list.filter(p => filterCriteria.processIds.includes(p.pid));
  }
  if (filterCriteria.minMem != null) {
    list = list.filter(p => p.memoryUsage >= filterCriteria.minMem * 1024 * 1024);
  }
  if (filterCriteria.maxMem != null) {
    list = list.filter(p => p.memoryUsage <= filterCriteria.maxMem * 1024 * 1024);
  }
  return list;
}

// Render the process table. Optimizations vs. the original:
// 1. Cache processHistory lookup once per row (was 3x per row).
// 2. Skip the `{...p, spike}` spread — just use local variables.
// 3. Pre-compute shared values (sysTotalCache, isSelected) outside the loop.
// 4. Cache the highlight RegExp by term (rebuild only when term changes).
// 5. Skip the highlight pass when there's no term.
// 6. Only update sort indicators if sortKey/sortDir actually changed.
let _cachedHlTerm = null;
let _cachedHlRe = null;
let _lastSortKey = null;
let _lastSortDir = null;
let _sortIndicatorsDirty = true;
function getHighlightRe(term) {
  if (!term) return null;
  if (term === _cachedHlTerm) return _cachedHlRe;
  const escTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  _cachedHlRe = new RegExp('(' + escTerm + ')', 'gi');
  _cachedHlTerm = term;
  return _cachedHlRe;
}

/**
 * Render the main process table (Dashboard / Processes tab). Reads the
 * current search input, applies user sort, builds HTML rows, updates the
 * match-count indicator, and refreshes sort column indicators.
 *
 * Hot path: called every REFRESH_INTERVAL_MS while the tab is visible.
 */
function renderTable() {
  let matched = getFilteredProcesses();
  // Update search UI: match count and clear button visibility
  const term = els.searchInput.value.trim();
  if (els.searchClear) els.searchClear.style.display = term ? 'inline-block' : 'none';
  if (els.searchMatchCount) {
    if (term) {
      els.searchMatchCount.textContent = `${matched.length} / ${allProcesses.length}`;
      els.searchMatchCount.style.color = matched.length === 0 ? '#ff4d4f' : '#1890ff';
    } else {
      els.searchMatchCount.textContent = allProcesses.length > 0 ? `共 ${allProcesses.length} 个` : '';
    }
  }
  if (matched.length === 0) {
    els.tbody.innerHTML = `<tr><td colspan="6" class="empty">${allProcesses.length === 0 ? '暂无数据' : '无匹配结果'}</td></tr>`;
    return;
  }

  // Apply user-selected sort. We mutate in-place to avoid the spread + new array.
  // sortKey/sortDir are module-level state; if unchanged, we can skip re-sorting
  // because allProcesses is already sorted desc by memoryUsage from main.cjs.
  if (_lastSortKey !== sortKey || _lastSortDir !== sortDir) {
    matched.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    _lastSortKey = sortKey;
    _lastSortDir = sortDir;
    _sortIndicatorsDirty = true;
  }
  const slice = matched.slice(0, PROCESS_TABLE_LIMIT);

  // Cache RegExp by term — rebuilt only when term changes.
  const re = term ? getHighlightRe(term) : null;
  const hl = s => {
    if (!re || s == null) return escapeHtml(String(s));
    return escapeHtml(String(s)).replace(re, '<mark class="search-hl">$1</mark>');
  };

  // Pre-compute once outside the loop.
  const totalMem = sysTotalCache || 1;
  const isSelected = p => selectedPid === p.pid;

  els.tbody.innerHTML = slice.map(p => renderProcessRow(p, hl, totalMem)).join('');
  if (matched.length > PROCESS_TABLE_LIMIT) {
    els.tbody.insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="empty">仅显示前200个，共 ${matched.length} 个匹配</td></tr>`);
  }
  // Update sort indicators only when sort state changes.
  if (_sortIndicatorsDirty) {
    document.querySelectorAll('th.sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });
    _sortIndicatorsDirty = false;
  }
}

// ============================================================================
// RENDER HELPERS — small, pure functions that build HTML strings for table rows.
// Extracted from renderTable/renderSpikes/renderLeaks to avoid duplication.
// ============================================================================

/**
 * Build the inline-colored spike-percentage cell used in the main process table.
 * Returns "--" (dim) if there aren't enough samples to establish a baseline.
 *
 * @param {number} spike - spikePercent from process history
 * @param {number} sampleCount - number of samples collected so far
 * @returns {string} HTML span
 */
function renderSpikeCell(spike, sampleCount) {
  if (sampleCount <= SPIKE_MIN_SAMPLES) {
    return '<span style="color:#999">--</span>';
  }
  if (spike >= SPIKE_HOT_THRESHOLD) {
    return `<span style="color:${COLORS.SPIKE_HOT};font-weight:600">↑${spike}%</span>`;
  }
  if (spike >= SPIKE_WARM_THRESHOLD) {
    return `<span style="color:${COLORS.SPIKE_WARM}">↑${spike}%</span>`;
  }
  if (spike <= SPIKE_COOL_THRESHOLD) {
    return `<span style="color:${COLORS.SPIKE_COOL}">↓${-spike}%</span>`;
  }
  return `<span style="color:${COLORS.TEXT_DIM}">${spike >= 0 ? '+' : ''}${spike}%</span>`;
}

/**
 * Build a single <tr> for the main process table. Single history lookup per row.
 *
 * @param {object} p - process row {pid, name, memoryUsage}
 * @param {(s:any)=>string} hl - highlight function for escaping + mark insertion
 * @param {number} totalMem - denominator for percent calculation
 * @returns {string} HTML <tr>
 */
function renderProcessRow(p, hl, totalMem) {
  const h = processHistory[p.pid];
  const spikeCell = renderSpikeCell(h ? h.spikePercent : 0, h ? h.sampleCount : 0);
  const selCls = selectedPid === p.pid ? ' class="selected"' : '';
  const statusCell = selectedPid === p.pid
    ? `<span style="color:${COLORS.SUCCESS};font-weight:500">已选择</span>`
    : `<span style="color:${COLORS.TEXT_DIM}">运行中</span>`;
  return `<tr data-pid="${p.pid}"${selCls}><td>${hl(p.pid)}</td><td>${hl(p.name)}</td><td>${formatBytes(p.memoryUsage)}</td><td>${((p.memoryUsage / totalMem) * 100).toFixed(2)}%</td><td>${spikeCell}</td><td>${statusCell}</td></tr>`;
}

function renderDashCharts() {
  drawBarChart($('dashBarChart'), allProcesses);
  if (systemCache) {
    drawPieChart($('dashPieChart'), [
      { name: '已用', value: systemCache.totalPhysicalMemory - systemCache.availablePhysicalMemory },
      { name: '可用', value: systemCache.availablePhysicalMemory },
    ]);
  }
}

// Spike detection: surface processes whose current memory deviates >= configured
// threshold from their running baseline. Threshold is loaded from user config.
// Sample count must be > SPIKE_MIN_SAMPLES to establish a meaningful baseline.

function renderSpikes() {
  // Optimization: single pass over allProcesses collects both spikes AND
  // total sample count (was two passes before).
  const spikes = [];
  let totalSamples = 0;
  for (const p of allProcesses) {
    const h = processHistory[p.pid];
    if (!h) continue;
    totalSamples += h.sampleCount;
    if (h.sampleCount <= SPIKE_MIN_SAMPLES) continue;
    if (Math.abs(h.spikePercent) >= SPIKE_THRESHOLD) {
      spikes.push({ pid: p.pid, name: p.name, h });
    }
  }
  // Sort by absolute spike, biggest first
  spikes.sort((a, b) => Math.abs(b.h.spikePercent) - Math.abs(a.h.spikePercent));

  const avgSamples = allProcesses.length ? Math.floor(totalSamples / allProcesses.length) : 0;
  els.spikeHint.textContent = `需积累样本后检测 (当前平均 ${avgSamples} 个/进程, 阈值 ${SPIKE_THRESHOLD}%)`;

  if (spikes.length === 0) {
    const emptyMsg = avgSamples < SPIKE_MIN_SAMPLES + 1
      ? `样本不足 (需>${SPIKE_MIN_SAMPLES}个)`
      : `暂无明显突变 (≥${SPIKE_THRESHOLD}%)`;
    els.spikeTbody.innerHTML = `<tr><td colspan="6" class="empty">${emptyMsg}</td></tr>`;
    return;
  }
  els.spikeTbody.innerHTML = spikes.slice(0, DASHBOARD_LIMIT).map(s => {
    const pct = s.h.spikePercent;
    const arrow = pct >= 0 ? '↑' : '↓';
    return `<tr data-pid="${s.pid}" style="cursor:pointer">
      <td>${s.pid}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${formatBytes(s.h.current)}</td>
      <td style="color:#999">${formatBytes(s.h.baseline)}</td>
      <td style="color:#faad14">${formatBytes(s.h.peak)}</td>
      <td style="color:#ff4d4f;font-weight:600">${arrow}${Math.abs(pct)}%</td>
    </tr>`;
  }).join('');
}

// Leak detection: a process with a sustained upward trend over the sample window.
// Threshold: leakPercent >= configured value (i.e., memory growing at >= threshold
// of baseline per window). Default 30, loaded from user config.

function renderLeaks() {
  const leaks = [];
  for (const p of allProcesses) {
    const h = processHistory[p.pid];
    if (!h || h.sampleCount < LEAK_MIN_SAMPLES) continue;
    if (h.leakPercent >= LEAK_THRESHOLD) {
      leaks.push({ pid: p.pid, name: p.name, h });
    }
  }
  // Sort by steepest leak first
  leaks.sort((a, b) => b.h.leakPercent - a.h.leakPercent);

  if (leaks.length === 0) {
    els.leakTbody.innerHTML = `<tr><td colspan="5" class="empty">暂无内存泄漏迹象 (需≥${LEAK_MIN_SAMPLES}个样本+≥${LEAK_THRESHOLD}%增长)</td></tr>`;
    return;
  }
  els.leakTbody.innerHTML = leaks.slice(0, DASHBOARD_LIMIT).map(l => {
    const pct = l.h.leakPercent;
    return `<tr data-pid="${l.pid}" style="cursor:pointer">
      <td>${l.pid}</td>
      <td>${escapeHtml(l.name)}</td>
      <td>${formatBytes(l.h.current)}</td>
      <td style="color:#999">${formatBytes(l.h.baseline)}</td>
      <td style="color:#ff4d4f;font-weight:600">↗ +${pct}%/窗</td>
    </tr>`;
  }).join('');
}

function renderChartPage() {
  if (currentTab !== 'charts') return;
  const pid = Number(els.chartProcess.value);
  const proc = pid ? allProcesses.find(p => p.pid === pid) : null;
  const pieData = proc
    ? [
        { name: '私有', value: Math.floor(proc.memoryUsage * MEM_RATIOS.PRIVATE_RATIO) },
        { name: '共享', value: Math.floor(proc.memoryUsage * (1 - MEM_RATIOS.PRIVATE_RATIO)) },
        { name: '提交', value: Math.floor(proc.memoryUsage * MEM_RATIOS.COMMIT_RATIO) },
      ]
    : allProcesses.slice(0, 5).map(p => ({ name: p.name, value: p.memoryUsage }));
  drawPieChart($('pieChart'), pieData);
  drawBarChart($('barChart'), allProcesses);
  const recordingsWithData = recordings.filter(r => r.data && r.data.length > 1);
  if (recordingsWithData.length > 0) {
    const lastRec = recordingsWithData[recordingsWithData.length - 1];
    const series = filterCriteria.metrics.map((m) => ({
      name: m === 'workingSetSize' ? '工作集' : m === 'privateWorkingSetSize' ? '私有' : '提交',
      data: lastRec.data.map(d => ({
        time: d.timestamp,
        value: m === 'workingSetSize' ? d.workingSetSize : m === 'privateWorkingSetSize' ? d.privateWorkingSetSize : d.commitSize,
      })),
    }));
    drawLineChart($('lineChart'), series);
  } else {
    drawLineChart($('lineChart'), []);
  }
}

function showDetail(pid) {
  const proc = allProcesses.find(p => p.pid === pid);
  if (!proc) { els.detailCard.style.display = 'none'; return; }
  selectedPid = pid;
  const ws = proc.memoryUsage;
  const pws = Math.floor(ws * MEM_RATIOS.PRIVATE_RATIO);
  const commit = Math.floor(ws * MEM_RATIOS.COMMIT_RATIO);
  const max = Math.max(ws, pws, commit);
  els.detailTitle.textContent = `${proc.name} (PID: ${pid})`;
  els.dWS.textContent = formatBytes(ws);
  els.dPWS.textContent = formatBytes(pws);
  els.dCommit.textContent = formatBytes(commit);
  els.bWS.style.width = (ws / max) * 100 + '%';
  els.bPWS.style.width = (pws / max) * 100 + '%';
  els.bCommit.style.width = (commit / max) * 100 + '%';
  els.detailCard.style.display = 'block';
}

function populateFilterProcesses() {
  const current = new Set(Array.from(els.filterProcess.selectedOptions).map(o => Number(o.value)));
  els.filterProcess.innerHTML = allProcesses.slice(0, PROCESS_TABLE_LIMIT).map(p =>
    `<option value="${p.pid}" ${current.has(p.pid) ? 'selected' : ''}>${escapeHtml(p.name)} (${p.pid}) - ${formatBytes(p.memoryUsage)}</option>`
  ).join('');
  const currentChart = Number(els.chartProcess.value);
  els.chartProcess.innerHTML = '<option value="">-- 选择进程 --</option>' + allProcesses.slice(0, 100).map(p =>
    `<option value="${p.pid}" ${currentChart === p.pid ? 'selected' : ''}>${escapeHtml(p.name)} (${p.pid})</option>`
  ).join('');
}

// Persistent recording: main process owns the file. Renderer just sends commands
// and polls status for the live counter. The recordings list is loaded from disk.
let statusPollTimer = null;

async function startRecording() {
  const interval = Math.max(1000, Number(els.recInterval.value) || 2000);
  const topN = Math.min(50, Math.max(5, Number(els.recTopN.value) || 20));
  const result = await window.electronAPI.startRecording({ interval, topN });
  if (!result.ok) {
    showToast(result.error || '启动录制失败', 'error');
    return;
  }
  els.recStart.disabled = true;
  els.recStop.disabled = false;
  // Poll status every interval to update counter
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(updateRecStatus, interval);
  await updateRecStatus();
  await loadRecordings();
  showToast(`录制已开始 (Top ${topN}, 间隔 ${interval}ms)`, 'info');
}

async function stopRecording() {
  const result = await window.electronAPI.stopRecording();
  if (!result.ok) {
    showToast(result.error || '停止录制失败', 'error');
    return;
  }
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
  els.recStart.disabled = false;
  els.recStop.disabled = true;
  activeRecording = null;
  await updateRecStatus();
  await loadRecordings();
  showToast(`录制完成: ${result.sampleCount} 个采样点`, 'info');
}

async function updateRecStatus() {
  const status = await window.electronAPI.getRecordingStatus();
  if (status.active) {
    activeRecording = status;
    const elapsed = ((Date.now() - status.startTime) / 1000).toFixed(1);
    els.recStatus.className = 'recording';
    els.recStatus.textContent = `录制中: Top ${status.topN} | 已采集 ${status.sampleCount} 个点 | ${elapsed}s | 间隔 ${status.interval}ms`;
  } else {
    els.recStatus.className = 'idle';
    els.recStatus.textContent = '未在录制 (数据保存到本地 JSONL, 刷新不丢失)';
  }
}

async function loadRecordings() {
  recordings = await window.electronAPI.listRecordings();
  renderRecordings();
}

function renderRecordings() {
  if (!recordings || recordings.length === 0) {
    els.recTbody.innerHTML = '<tr><td colspan="6" class="empty">暂无录制</td></tr>';
    return;
  }
  els.recTbody.innerHTML = recordings.map(r => {
    const sizeKb = (r.sizeBytes / 1024).toFixed(1);
    const dur = r.sampleCount && r.interval
      ? `${(r.sampleCount * r.interval / 1000).toFixed(0)}s`
      : '-';
    return `<tr>
      <td style="font-family:monospace;font-size:11px" title="${escapeHtml(r.id)}">${escapeHtml(r.id)}</td>
      <td>${new Date(r.startTime).toLocaleString()}</td>
      <td>${r.sampleCount || 0} <span style="color:#999;font-size:11px">(${dur})</span></td>
      <td>${r.interval}ms</td>
      <td>${sizeKb} KB</td>
      <td>
        <button class="btn btn-export-csv" data-export-rec="${r.id}" title="导出为CSV">CSV</button>
        <button class="btn btn-danger" data-del-rec="${r.id}" title="删除录制">删除</button>
      </td>
    </tr>`;
  }).join('');
}

async function deleteRecording(id) {
  const result = await window.electronAPI.deleteRecording(id);
  if (result.ok) {
    await loadRecordings();
    showToast('已删除', 'info');
  } else {
    showToast('删除失败: ' + result.error, 'error');
  }
}

async function exportRecordingCsv(id) {
  const result = await window.electronAPI.exportRecordingCsv(id);
  if (result.ok) {
    showToast(`已导出: ${result.filePath}`, 'info');
  } else if (result.error !== '用户取消') {
    showToast('导出失败: ' + result.error, 'error');
  }
}

function applyFilter() {
  filterCriteria.processIds = Array.from(els.filterProcess.selectedOptions).map(o => Number(o.value));
  filterCriteria.metrics = Array.from(document.querySelectorAll('.metric-cb:checked')).map(cb => cb.value);
  filterCriteria.minMem = $('minMem').value ? Number($('minMem').value) : null;
  filterCriteria.maxMem = $('maxMem').value ? Number($('maxMem').value) : null;
  renderTable();
  const matched = getFilteredProcesses();
  els.filterCount.textContent = `匹配 ${matched.length} / ${allProcesses.length} 个进程`;
  showToast(`筛选已应用: ${matched.length} 个进程`, 'info');
}

function clearFilter() {
  els.filterProcess.selectedIndex = -1;
  document.querySelectorAll('.metric-cb').forEach(cb => cb.checked = true);
  $('minMem').value = '';
  $('maxMem').value = '';
  filterCriteria = { processIds: [], metrics: ['workingSetSize','privateWorkingSetSize','commitSize'], minMem: null, maxMem: null };
  renderTable();
  els.filterCount.textContent = '';
}

function addRule() {
  const metric = els.ruleMetric.value;
  const threshold = Number(els.ruleThreshold.value);
  if (!threshold || threshold <= 0) {
    showToast('请输入有效的阈值', 'warn');
    return;
  }
  notifyRules.push({
    id: 'rule_' + Date.now(),
    metric,
    threshold: threshold * 1024 * 1024,
    enabled: true,
    triggered: false,
  });
  els.ruleThreshold.value = '';
  renderRules();
  showToast('规则已添加', 'info');
}

function renderRules() {
  if (notifyRules.length === 0) {
    els.ruleTbody.innerHTML = '<tr><td colspan="4" class="empty">暂无规则</td></tr>';
    return;
  }
  els.ruleTbody.innerHTML = notifyRules.map(r => `<tr>
    <td>${r.metric === 'workingSetSize' ? '工作集' : r.metric === 'privateWorkingSetSize' ? '私有' : '提交'}</td>
    <td>${formatBytes(r.threshold)}</td>
    <td>${r.triggered ? '<span style="color:#ff4d4f">已触发</span>' : '<span style="color:#52c41a">正常</span>'}</td>
    <td><button class="btn btn-danger" data-del-rule="${r.id}">删除</button></td>
  </tr>`).join('');
}

function checkNotifications() {
  if (!els.notifyEnabled.checked || isNotifying || notifyRules.length === 0) return;
  isNotifying = true;
  let changed = false;
  notifyRules.forEach(rule => {
    const target = allProcesses.find(p => p.memoryUsage >= rule.threshold);
    if (target && !rule.triggered) {
      // Trigger: process crossed the threshold (rising edge)
      rule.triggered = true;
      const entry = {
        id: 'notif_' + Date.now(),
        time: Date.now(),
        text: `${target.name} (PID ${target.pid}) ${rule.metric} 达到 ${formatBytes(target.memoryUsage)} (阈值 ${formatBytes(rule.threshold)})`,
      };
      notifyHistory.unshift(entry);
      notifyHistory = notifyHistory.slice(0, 20);
      showToast(entry.text, 'warn');
      changed = true;
    } else if (!target && rule.triggered) {
      // Recovery: process fell back below threshold (falling edge)
      rule.triggered = false;
      const recoveryEntry = {
        id: 'notif_' + Date.now(),
        time: Date.now(),
        text: `${rule.metric} 已回落至阈值以下 (阈值 ${formatBytes(rule.threshold)})`,
      };
      notifyHistory.unshift(recoveryEntry);
      notifyHistory = notifyHistory.slice(0, 20);
      showToast(recoveryEntry.text, 'info');
      changed = true;
    }
  });
  if (changed) { renderRules(); renderHistory(); }
  isNotifying = false;
}

function renderHistory() {
  if (notifyHistory.length === 0) {
    els.historyList.className = 'empty';
    els.historyList.textContent = '无通知历史';
    return;
  }
  els.historyList.className = '';
  els.historyList.innerHTML = notifyHistory.map(h =>
    `<div class="history-item"><b>${new Date(h.time).toLocaleTimeString()}</b> - ${escapeHtml(h.text)}</div>`
  ).join('');
}

function exportReport() {
  const format = els.exportFormat.value;
  const data = els.exportAll.checked ? allProcesses : getFilteredProcesses();
  if (data.length === 0) {
    showToast('没有数据可导出', 'warn');
    return;
  }
  let content, mime, ext;
  if (format === 'csv') {
    content = ['PID,名称,工作集,私有工作集,提交大小,时间戳'];
    data.forEach(p => content.push([p.pid, p.name, p.memoryUsage, Math.floor(p.memoryUsage*0.7), Math.floor(p.memoryUsage*1.3), Date.now()].join(',')));
    content = content.join('\n');
    mime = 'text/csv;charset=utf-8';
    ext = 'csv';
  } else if (format === 'json') {
    content = JSON.stringify({ generatedAt: new Date().toISOString(), system: systemCache, processes: data, recordings }, null, 2);
    mime = 'application/json;charset=utf-8';
    ext = 'json';
  } else {
    content = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>内存分析报告</title>
      <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#1890ff;color:#fff}</style>
      </head><body><h1>内存分析报告</h1><p>生成时间: ${new Date().toLocaleString()}</p>
      <p>进程数: ${data.length}</p>
      <table><thead><tr><th>PID</th><th>名称</th><th>内存占用</th></tr></thead><tbody>
      ${data.map(p => `<tr><td>${p.pid}</td><td>${escapeHtml(p.name)}</td><td>${formatBytes(p.memoryUsage)}</td></tr>`).join('')}
      </tbody></table></body></html>`;
    mime = 'text/html;charset=utf-8';
    ext = 'html';
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `memory-report-${new Date().toISOString().slice(0,10)}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  els.exportPreview.className = '';
  els.exportPreview.innerHTML = `<b>已导出 ${data.length} 个进程</b><br>格式: ${format.toUpperCase()}<br>时间: ${new Date().toLocaleString()}`;
  showToast(`已导出 ${data.length} 条记录`, 'info');
}

// Export a richer snapshot: current state + per-process history analysis.
// Captures: pid, name, memory, baseline, peak, spikePercent, leakPercent, sampleCount.
// JSON output also includes system info + thresholds for full reconstruction.
async function exportHistorySnapshot() {
  const format = els.exportFormat.value === 'html' ? 'json' : els.exportFormat.value;  // snapshot supports CSV/JSON
  const result = await window.electronAPI.exportHistorySnapshot({
    format,
    includeAll: els.exportAll.checked,
  });
  if (result.ok) {
    els.exportPreview.className = '';
    els.exportPreview.innerHTML = `<b>已导出历史快照</b><br>进程数: ${result.processCount}<br>格式: ${format.toUpperCase()}<br>路径: ${escapeHtml(result.filePath)}`;
    showToast(`已导出 ${result.processCount} 个进程的历史快照`, 'info');
  } else if (result.error !== '用户取消') {
    showToast('快照导出失败: ' + result.error, 'error');
  }
}

// Copy the top-50 processes (by memory) to the system clipboard as CSV.
// Use case: paste into chat/ticket/issue tracker without saving a file first.
// Also includes a system memory summary line at the top for context.
async function copyTop50ToClipboard() {
  if (!allProcesses || allProcesses.length === 0) {
    showToast('暂无进程数据可复制', 'warn');
    return;
  }
  // Top-50 by memoryUsage (descending). allProcesses is already sorted desc.
  const top = allProcesses.slice(0, 50);
  const cols = ['rank', 'pid', 'name', 'memoryMB', 'percentOfTotal'];
  const csvEscape = v => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const totalMem = systemCache ? systemCache.totalPhysicalMemory : 1;
  const lines = [cols.join(',')];
  top.forEach((p, i) => {
    lines.push([
      i + 1,
      p.pid,
      csvEscape(p.name),
      (p.memoryUsage / 1024 / 1024).toFixed(1),
      ((p.memoryUsage / totalMem) * 100).toFixed(2),
    ].join(','));
  });
  // System memory summary (commented lines for context)
  const summary = [
    `# Top ${top.length} of ${allProcesses.length} processes by memory`,
    `# System total: ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
    `# System used: ${systemCache ? ((totalMem - systemCache.availablePhysicalMemory) / 1024 / 1024 / 1024).toFixed(1) : '?'} GB`,
    `# Generated: ${new Date().toISOString()}`,
  ].join('\n');
  const csv = summary + '\n' + lines.join('\n');

  // Use main process IPC for reliable clipboard write (avoids browser permission
  // prompts and works even when the window doesn't have focus).
  const result = await window.electronAPI.writeClipboard(csv);
  if (result.success) {
    showToast(`已复制 Top ${top.length} 进程到剪贴板 (${(csv.length / 1024).toFixed(1)} KB)`, 'info');
    els.exportPreview.className = '';
    els.exportPreview.innerHTML = `<b>已复制 Top ${top.length} 到剪贴板</b><br>格式: CSV (含系统内存摘要)<br>大小: ${(csv.length / 1024).toFixed(1)} KB<br>时间: ${new Date().toLocaleString()}`;
  } else {
    showToast('复制失败: ' + (result.error || '未知错误'), 'error');
  }
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'charts') renderChartPage();
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.go)));
document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDir = key === 'name' ? 'asc' : 'desc';
  }
  renderTable();
}));

els.refreshBtn.addEventListener('click', refresh);
els.searchInput.addEventListener('input', renderTable);
els.searchClear.addEventListener('click', () => {
  els.searchInput.value = '';
  renderTable();
  els.searchInput.focus();
});
// Ctrl+F focuses search box (matches browser convention)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }
  // Escape clears search when input is focused
  if (e.key === 'Escape' && document.activeElement === els.searchInput) {
    els.searchInput.value = '';
    renderTable();
    els.searchInput.blur();
  }
});
els.tbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pid) return;
  showDetail(Number(tr.dataset.pid));
  document.querySelectorAll('#processTbody tr').forEach(r => r.classList.remove('selected'));
  tr.classList.add('selected');
});
els.tbody.addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pid) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, Number(tr.dataset.pid), tr.children[1].textContent);
});
els.spikeTbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pid) return;
  // Jump to process detail and select the process
  selectedPid = Number(tr.dataset.pid);
  showDetail(selectedPid);
  switchTab('processes');
  // Re-render the process table to show the selected row
  renderTable();
});
els.leakTbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pid) return;
  selectedPid = Number(tr.dataset.pid);
  showDetail(selectedPid);
  switchTab('processes');
  renderTable();
});
els.ctxMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  handleContextAction(item.dataset.action);
});
document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
els.recStart.addEventListener('click', startRecording);
els.recStop.addEventListener('click', stopRecording);
els.recTbody.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.delRec) deleteRecording(t.dataset.delRec);
  else if (t.dataset.exportRec) exportRecordingCsv(t.dataset.exportRec);
});

// Load recordings from disk on startup and sync status (handles crash recovery)
loadRecordings();
window.electronAPI.getRecordingStatus().then(status => {
  if (status.active) {
    // Main is still recording (e.g., after renderer reload) - re-attach UI
    activeRecording = status;
    els.recStart.disabled = true;
    els.recStop.disabled = false;
    const interval = status.interval || 2000;
    if (statusPollTimer) clearInterval(statusPollTimer);
    statusPollTimer = setInterval(updateRecStatus, interval);
    updateRecStatus();
  }
});

// ============== Config loading ==============
// Load user config (thresholds, recording defaults) on startup and apply.
// Settings card on dashboard lets the user override; changes save immediately.
let currentConfig = null;

async function loadConfig() {
  currentConfig = await window.electronAPI.getConfig();
  applyConfig(currentConfig);
}

function applyConfig(cfg) {
  SPIKE_THRESHOLD = cfg.spikeThreshold;
  LEAK_THRESHOLD = cfg.leakThreshold;
  // Sync inputs
  if (els.cfgSpikeThreshold) els.cfgSpikeThreshold.value = cfg.spikeThreshold;
  if (els.cfgLeakThreshold) els.cfgLeakThreshold.value = cfg.leakThreshold;
  if (els.cfgRecordingTopN) els.cfgRecordingTopN.value = cfg.recordingTopN;
  // Update hint on leak card
  if (els.leakThresholdHint) els.leakThresholdHint.textContent = cfg.leakThreshold;
  // Sync recording defaults into the recording tab inputs
  if (els.recTopN) els.recTopN.value = cfg.recordingTopN;
  if (els.recInterval) els.recInterval.value = cfg.recordingInterval;
  // Re-render so thresholds take effect immediately
  renderSpikes();
  renderLeaks();
}

async function saveConfigFromUI() {
  const patch = {
    spikeThreshold: Number(els.cfgSpikeThreshold.value),
    leakThreshold: Number(els.cfgLeakThreshold.value),
    recordingTopN: Number(els.cfgRecordingTopN.value),
  };
  const result = await window.electronAPI.setConfig(patch);
  if (result.ok) {
    applyConfig(result.config);
    els.cfgStatus.textContent = '已保存 ✓';
    setTimeout(() => { els.cfgStatus.textContent = ''; }, 2000);
    showToast('设置已保存', 'info');
  } else {
    els.cfgStatus.textContent = '保存失败';
    els.cfgStatus.style.color = '#ff4d4f';
    showToast('保存失败: ' + result.error, 'error');
  }
}

async function resetConfig() {
  const result = await window.electronAPI.resetConfig();
  if (result.ok) {
    applyConfig(result.config);
    els.cfgStatus.textContent = '已恢复默认 ✓';
    setTimeout(() => { els.cfgStatus.textContent = ''; }, 2000);
    showToast('已恢复默认设置', 'info');
  }
}

els.cfgSave.addEventListener('click', saveConfigFromUI);
els.cfgReset.addEventListener('click', resetConfig);

// Load config on startup (non-blocking - settings card works with defaults if it fails)
loadConfig().catch(err => console.error('config load failed:', err));

els.filterApply.addEventListener('click', applyFilter);
els.filterClear.addEventListener('click', clearFilter);
els.ruleAdd.addEventListener('click', addRule);
els.ruleTbody.addEventListener('click', (e) => {
  if (e.target.dataset.delRule) {
    notifyRules = notifyRules.filter(r => r.id !== e.target.dataset.delRule);
    renderRules();
  }
});
els.chartProcess.addEventListener('change', renderChartPage);
els.exportBtn.addEventListener('click', exportReport);
els.snapshotBtn.addEventListener('click', exportHistorySnapshot);
els.copyTop50Btn.addEventListener('click', copyTop50ToClipboard);

refresh();
refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

// Optimization: when the window/tab is hidden (minimized, other tab focused,
// screen locked, etc.) the user can't see updates anyway. Pausing refresh
// saves CPU + avoids waking up the PowerShell session. On return, do one
// immediate refresh so the UI isn't stale.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  } else {
    if (!refreshTimer) {
      refresh();  // immediate catch-up
      refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
    }
  }
});
