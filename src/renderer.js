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
  toast: $('toast'),
  searchInput: $('searchInput'),
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
  recInterval: $('recInterval'),
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

async function refresh() {
  if (isRefreshing) return; // prevent reentrancy
  isRefreshing = true;
  try {
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

function getFilteredProcesses() {
  let list = allProcesses;
  const term = els.searchInput.value.trim().toLowerCase();
  if (term) {
    list = list.filter(p => p.name.toLowerCase().includes(term) || String(p.pid).includes(term));
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

function renderTable() {
  let matched = getFilteredProcesses();
  if (matched.length === 0) {
    els.tbody.innerHTML = `<tr><td colspan="6" class="empty">${allProcesses.length === 0 ? '暂无数据' : '无匹配结果'}</td></tr>`;
    return;
  }
  // Enrich with computed spike value (from processHistory)
  const enriched = matched.map(p => ({
    ...p,
    spike: (processHistory[p.pid] && processHistory[p.pid].spikePercent) || 0,
  }));
  // Apply user-selected sort
  enriched.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortDir === 'asc' ? va - vb : vb - va;
  });
  const slice = enriched.slice(0, 200);
  els.tbody.innerHTML = slice.map(p => {
    const spike = processHistory[p.pid]?.spikePercent ?? 0;
    // Only show spike after we have enough samples to establish a baseline (>5)
    const sampleCount = processHistory[p.pid]?.sampleCount ?? 0;
    const showSpike = sampleCount > 5;
    let spikeCell = '<span style="color:#999">--</span>';
    if (showSpike) {
      if (spike >= 50) spikeCell = `<span style="color:#ff4d4f;font-weight:600">↑${spike}%</span>`;
      else if (spike >= 20) spikeCell = `<span style="color:#faad14">↑${spike}%</span>`;
      else if (spike <= -20) spikeCell = `<span style="color:#52c41a">↓${Math.abs(spike)}%</span>`;
      else spikeCell = `<span style="color:#999">${spike >= 0 ? '+' : ''}${spike}%</span>`;
    }
    return `<tr data-pid="${p.pid}" class="${selectedPid === p.pid ? 'selected' : ''}">
      <td>${p.pid}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${formatBytes(p.memoryUsage)}</td>
      <td>${((p.memoryUsage / sysTotalCache) * 100).toFixed(2)}%</td>
      <td>${spikeCell}</td>
      <td>${selectedPid === p.pid ? '<span style="color:#52c41a;font-weight:500">已选择</span>' : '<span style="color:#999">运行中</span>'}</td>
    </tr>`;
  }).join('');
  if (matched.length > 200) {
    els.tbody.insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="empty">仅显示前200个，共 ${matched.length} 个匹配</td></tr>`);
  }
  // Update sort indicators
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
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

// Spike detection: surface processes whose current memory deviates >=50% from their
// running baseline. Sample count must be > 5 to establish a meaningful baseline.
const SPIKE_THRESHOLD = 50;

function renderSpikes() {
  const spikes = [];
  for (const p of allProcesses) {
    const h = processHistory[p.pid];
    if (!h || h.sampleCount <= 5) continue;
    if (Math.abs(h.spikePercent) >= SPIKE_THRESHOLD) {
      spikes.push({ ...p, history: h });
    }
  }
  // Sort by absolute spike, biggest first
  spikes.sort((a, b) => Math.abs(b.history.spikePercent) - Math.abs(a.history.spikePercent));

  const totalSamples = allProcesses.reduce((s, p) => {
    const h = processHistory[p.pid];
    return s + (h ? h.sampleCount : 0);
  }, 0);
  const avgSamples = allProcesses.length ? Math.floor(totalSamples / allProcesses.length) : 0;
  els.spikeHint.textContent = `需积累样本后检测 (当前平均 ${avgSamples} 个/进程, 阈值 ${SPIKE_THRESHOLD}%)`;

  if (spikes.length === 0) {
    els.spikeTbody.innerHTML = `<tr><td colspan="6" class="empty">${avgSamples < 6 ? '样本不足 (需>5个)' : '暂无明显突变 (≥50%)'}</td></tr>`;
    return;
  }
  els.spikeTbody.innerHTML = spikes.slice(0, 10).map(s => {
    const pct = s.history.spikePercent;
    const color = pct >= 50 ? '#ff4d4f' : '#faad14';
    const arrow = pct >= 0 ? '↑' : '↓';
    return `<tr data-pid="${s.pid}" style="cursor:pointer">
      <td>${s.pid}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${formatBytes(s.history.current)}</td>
      <td style="color:#999">${formatBytes(s.history.baseline)}</td>
      <td style="color:#faad14">${formatBytes(s.history.peak)}</td>
      <td style="color:${color};font-weight:600">${arrow}${Math.abs(pct)}%</td>
    </tr>`;
  }).join('');
}

// Leak detection: a process with a sustained upward trend over the sample window.
// Threshold: leakPercent >= 30 (i.e., memory growing at >=30% of baseline per window).
const LEAK_THRESHOLD = 30;

function renderLeaks() {
  const leaks = [];
  for (const p of allProcesses) {
    const h = processHistory[p.pid];
    if (!h || h.sampleCount < 10) continue; // need enough samples for slope
    if (h.leakPercent >= LEAK_THRESHOLD) {
      leaks.push({ ...p, history: h });
    }
  }
  // Sort by steepest leak first
  leaks.sort((a, b) => b.history.leakPercent - a.history.leakPercent);

  if (leaks.length === 0) {
    els.leakTbody.innerHTML = `<tr><td colspan="5" class="empty">暂无内存泄漏迹象 (需≥10个样本+≥${LEAK_THRESHOLD}%增长)</td></tr>`;
    return;
  }
  els.leakTbody.innerHTML = leaks.slice(0, 10).map(l => {
    const pct = l.history.leakPercent;
    return `<tr data-pid="${l.pid}" style="cursor:pointer">
      <td>${l.pid}</td>
      <td>${escapeHtml(l.name)}</td>
      <td>${formatBytes(l.history.current)}</td>
      <td style="color:#999">${formatBytes(l.history.baseline)}</td>
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
  els.filterProcess.innerHTML = allProcesses.slice(0, 200).map(p =>
    `<option value="${p.pid}" ${current.has(p.pid) ? 'selected' : ''}>${escapeHtml(p.name)} (${p.pid}) - ${formatBytes(p.memoryUsage)}</option>`
  ).join('');
  const currentChart = Number(els.chartProcess.value);
  els.chartProcess.innerHTML = '<option value="">-- 选择进程 --</option>' + allProcesses.slice(0, 100).map(p =>
    `<option value="${p.pid}" ${currentChart === p.pid ? 'selected' : ''}>${escapeHtml(p.name)} (${p.pid})</option>`
  ).join('');
}

function startRecording() {
  const interval = Math.max(500, Number(els.recInterval.value) || 1000);
  const duration = Math.max(5, Number(els.recDuration.value) || 60);
  if (!selectedPid) {
    showToast('请先在"进程"标签选择一个进程', 'warn');
    switchTab('processes');
    return;
  }
  const proc = allProcesses.find(p => p.pid === selectedPid);
  if (!proc) {
    showToast('所选进程已不存在', 'error');
    return;
  }
  // Defensive: clear any leftover timer before starting a new one
  if (activeRecordingTimer) {
    clearInterval(activeRecordingTimer);
    activeRecordingTimer = null;
  }
  activeRecording = {
    id: 'rec_' + Date.now(),
    processId: selectedPid,
    processName: proc.name,
    interval,
    duration,
    startTime: Date.now(),
    data: [],
    status: 'recording',
  };
  recordings.push(activeRecording);
  els.recStart.disabled = true;
  els.recStop.disabled = false;
  updateRecStatus();
  const endTime = activeRecording.startTime + duration * 1000;
  activeRecordingTimer = setInterval(() => {
    const now = Date.now();
    if (now >= endTime) { stopRecording(); return; }
    // Defensive: stopRecording may have nulled activeRecording already
    if (!activeRecording) return;
    const p = allProcesses.find(x => x.pid === activeRecording.processId);
    if (!p) { stopRecording(); return; }
    activeRecording.data.push({
      timestamp: now,
      workingSetSize: p.memoryUsage,
      privateWorkingSetSize: Math.floor(p.memoryUsage * MEM_RATIOS.PRIVATE_RATIO),
      commitSize: Math.floor(p.memoryUsage * MEM_RATIOS.COMMIT_RATIO),
    });
    updateRecStatus();
  }, interval);
}

function stopRecording() {
  if (activeRecordingTimer) {
    clearInterval(activeRecordingTimer);
    activeRecordingTimer = null;
  }
  if (activeRecording) {
    activeRecording.status = 'completed';
    activeRecording.endTime = Date.now();
  }
  activeRecording = null;
  els.recStart.disabled = false;
  els.recStop.disabled = true;
  updateRecStatus();
  renderRecordings();
  renderChartPage();
  showToast('录制完成', 'info');
}

function updateRecStatus() {
  if (activeRecording) {
    const elapsed = ((Date.now() - activeRecording.startTime) / 1000).toFixed(1);
    const total = (activeRecording.duration).toFixed(0);
    els.recStatus.className = 'recording';
    els.recStatus.textContent = `录制中: ${activeRecording.processName} | 已采集 ${activeRecording.data.length} 个点 | ${elapsed}s / ${total}s`;
  } else {
    const last = recordings[recordings.length - 1];
    if (last) {
      els.recStatus.className = 'completed';
      els.recStatus.textContent = `最近录制完成: ${last.processName} - ${last.data.length} 个数据点`;
    } else {
      els.recStatus.className = 'idle';
      els.recStatus.textContent = '未在录制';
    }
  }
}

function renderRecordings() {
  if (recordings.length === 0) {
    els.recTbody.innerHTML = '<tr><td colspan="5" class="empty">暂无录制</td></tr>';
    return;
  }
  els.recTbody.innerHTML = recordings.map(r => `<tr>
    <td style="font-family:monospace;font-size:11px">${r.id}</td>
    <td>${new Date(r.startTime).toLocaleString()}</td>
    <td>${r.data.length}</td>
    <td>${r.status === 'recording' ? '<span style="color:#faad14">录制中</span>' : '<span style="color:#52c41a">已完成</span>'}</td>
    <td><button class="btn btn-danger" data-del-rec="${r.id}">删除</button></td>
  </tr>`).join('');
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
  if (e.target.dataset.delRec) {
    recordings = recordings.filter(r => r.id !== e.target.dataset.delRec);
    renderRecordings();
  }
});
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

refresh();
refreshTimer = setInterval(refresh, 2000);
