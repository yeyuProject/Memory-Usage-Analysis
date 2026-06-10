// Process table rendering: main table, spike dashboard card, leak dashboard card.
//
// All three render functions share the same data flow:
//   1. Read shared state (allProcesses, processHistory, selectedPid)
//   2. Filter/sort the data
//   3. Build HTML strings (escaped via escapeHtml)
//   4. Write to tbody.innerHTML
//
// Hot path — called every REFRESH_INTERVAL_MS. Optimizations preserved
// from the original renderer.js refactor:
//   - Single processHistory lookup per row (was 3x)
//   - No spread on each row
//   - Pre-computed sortKey/sortDir outside the loop
//   - Cached highlight RegExp by term
//   - Reused isSelected check via selectedPid global

const state = require('./state');
const { el, escapeHtml, formatBytes } = require('./utils');
const { compileSearchMatcher, getHighlightRe, highlight } = require('./search');

// ===== Thresholds (loaded from config; defaults here) =====
const SPIKE_THRESHOLD_DEFAULT = 50;
const LEAK_THRESHOLD_DEFAULT = 30;
const SPIKE_MIN_SAMPLES = 5;
const LEAK_MIN_SAMPLES = 10;
const SPIKE_HOT = 50;
const SPIKE_WARM = 20;
const SPIKE_COOL = -20;

let SPIKE_THRESHOLD = SPIKE_THRESHOLD_DEFAULT;
let LEAK_THRESHOLD  = LEAK_THRESHOLD_DEFAULT;

// Display limits
const PROCESS_TABLE_LIMIT = 200;
const DASHBOARD_LIMIT = 10;

// Theme colors
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

function setThresholds(spike, leak) {
  SPIKE_THRESHOLD = spike;
  LEAK_THRESHOLD = leak;
}

/**
 * Apply the search box and filter criteria to produce the final process list
 * for the main table. Filters are applied cheapest-first: search -> PID
 * whitelist -> min mem -> max mem.
 * @returns {Array<object>}
 */
function getFilteredProcesses() {
  let list = state.allProcesses;
  const matcher = compileSearchMatcher(el('searchInput').value.trim().toLowerCase());
  if (matcher) {
    list = list.filter(matcher);
  }
  if (state.filterCriteria.processIds.length > 0) {
    list = list.filter(p => state.filterCriteria.processIds.includes(p.pid));
  }
  if (state.filterCriteria.minMem != null) {
    list = list.filter(p => p.memoryUsage >= state.filterCriteria.minMem * 1024 * 1024);
  }
  if (state.filterCriteria.maxMem != null) {
    list = list.filter(p => p.memoryUsage <= state.filterCriteria.maxMem * 1024 * 1024);
  }
  return list;
}

/**
 * Build the inline-colored spike-percentage cell used in the main process table.
 * Returns "--" (dim) if there aren't enough samples to establish a baseline.
 */
function renderSpikeCell(spike, sampleCount) {
  if (sampleCount <= SPIKE_MIN_SAMPLES) {
    return '<span style="color:' + COLORS.TEXT_DIM + '">--</span>';
  }
  if (spike >= SPIKE_HOT) {
    return '<span style="color:' + COLORS.SPIKE_HOT + ';font-weight:600">↑' + spike + '%</span>';
  }
  if (spike >= SPIKE_WARM) {
    return '<span style="color:' + COLORS.SPIKE_WARM + '">↑' + spike + '%</span>';
  }
  if (spike <= SPIKE_COOL) {
    return '<span style="color:' + COLORS.SPIKE_COOL + '">↓' + (-spike) + '%</span>';
  }
  return '<span style="color:' + COLORS.TEXT_DIM + '">' + (spike >= 0 ? '+' : '') + spike + '%</span>';
}

/**
 * Build a single <tr> for the main process table. Single history lookup per row.
 */
function renderProcessRow(p, hl, totalMem) {
  const h = state.processHistory[p.pid];
  const spikeCell = renderSpikeCell(h ? h.spikePercent : 0, h ? h.sampleCount : 0);
  const selCls = state.selectedPid === p.pid ? ' class="selected"' : '';
  const statusCell = state.selectedPid === p.pid
    ? '<span style="color:' + COLORS.SUCCESS + ';font-weight:500">已选择</span>'
    : '<span style="color:' + COLORS.TEXT_DIM + '">运行中</span>';
  return '<tr data-pid="' + p.pid + '"' + selCls + '><td>' + hl(p.pid) + '</td><td>' + hl(p.name) +
    '</td><td>' + formatBytes(p.memoryUsage) + '</td><td>' +
    ((p.memoryUsage / totalMem) * 100).toFixed(2) + '%</td><td>' + spikeCell + '</td><td>' + statusCell + '</td></tr>';
}

/**
 * Render the main process table (Dashboard / Processes tab). Hot path —
 * called every REFRESH_INTERVAL_MS while visible.
 */
function renderTable() {
  const matched = getFilteredProcesses();
  const term = el('searchInput').value.trim();
  updateSearchUI(term, matched.length);
  if (matched.length === 0) {
    renderEmptyTable();
    return;
  }
  sortProcessesIfChanged(matched);
  renderTableRows(matched, term);
  updateSortIndicatorsIfDirty();
}

/** Show the clear button and the "X / Y" match counter. */
function updateSearchUI(term, matchedCount) {
  const clearBtn = el('searchClear');
  const matchCount = el('searchMatchCount');
  const total = state.allProcesses.length;
  if (clearBtn) clearBtn.style.display = term ? 'inline-block' : 'none';
  if (matchCount) {
    if (term) {
      matchCount.textContent = matchedCount + ' / ' + total;
      matchCount.style.color = matchedCount === 0 ? COLORS.DANGER : COLORS.PRIMARY;
    } else {
      matchCount.textContent = total > 0 ? '共 ' + total + ' 个' : '';
    }
  }
}

/** Render the "暂无数据" / "无匹配结果" empty-state row. */
function renderEmptyTable() {
  const msg = state.allProcesses.length === 0 ? '暂无数据' : '无匹配结果';
  el('tbody').innerHTML = '<tr><td colspan="6" class="empty">' + msg + '</td></tr>';
}

/** Sort the matched array in place; skip work if sort key/dir unchanged. */
function sortProcessesIfChanged(matched) {
  const sortKey = state.sortKey;
  const sortDir = state.sortDir;
  if (state._lastSortKey === sortKey && state._lastSortDir === sortDir) return;
  matched.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortDir === 'asc' ? va - vb : vb - va;
  });
  state._lastSortKey = sortKey;
  state._lastSortDir = sortDir;
  state._sortIndicatorsDirty = true;
}

/** Render the top-N rows + the "仅显示前 N 个" overflow footer row. */
function renderTableRows(matched, term) {
  const slice = matched.slice(0, PROCESS_TABLE_LIMIT);
  const re = term ? getHighlightRe(term) : null;
  const hl = s => highlight(s, re);
  const totalMem = state.sysTotalCache || 1;
  el('tbody').innerHTML = slice.map(p => renderProcessRow(p, hl, totalMem)).join('');
  if (matched.length > PROCESS_TABLE_LIMIT) {
    el('tbody').insertAdjacentHTML('beforeend',
      '<tr><td colspan="6" class="empty">仅显示前' + PROCESS_TABLE_LIMIT + '个，共 ' +
      matched.length + ' 个匹配</td></tr>');
  }
}

/** Update the up/down chevron indicators on sortable column headers. */
function updateSortIndicatorsIfDirty() {
  if (!state._sortIndicatorsDirty) return;
  const sortKey = state.sortKey;
  const sortDir = state.sortDir;
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
  state._sortIndicatorsDirty = false;
}

/**
 * Render the "突变进程" dashboard card (spike anomalies).
 * Optimization: single pass over allProcesses collects both spikes AND
 * total sample count (was two passes).
 */
function renderSpikes() {
  const spikes = [];
  let totalSamples = 0;
  for (const p of state.allProcesses) {
    const h = state.processHistory[p.pid];
    if (!h) continue;
    totalSamples += h.sampleCount;
    if (h.sampleCount <= SPIKE_MIN_SAMPLES) continue;
    if (Math.abs(h.spikePercent) >= SPIKE_THRESHOLD) {
      spikes.push({ pid: p.pid, name: p.name, h });
    }
  }
  spikes.sort((a, b) => Math.abs(b.h.spikePercent) - Math.abs(a.h.spikePercent));

  const avgSamples = state.allProcesses.length ? Math.floor(totalSamples / state.allProcesses.length) : 0;
  const hint = el('spikeHint');
  if (hint) hint.textContent = '需积累样本后检测 (当前平均 ' + avgSamples + ' 个/进程, 阈值 ' + SPIKE_THRESHOLD + '%)';

  if (spikes.length === 0) {
    const emptyMsg = avgSamples < SPIKE_MIN_SAMPLES + 1
      ? '样本不足 (需>' + SPIKE_MIN_SAMPLES + '个)'
      : '暂无明显突变 (≥' + SPIKE_THRESHOLD + '%)';
    el('spikeTbody').innerHTML = '<tr><td colspan="6" class="empty">' + emptyMsg + '</td></tr>';
    return;
  }
  el('spikeTbody').innerHTML = spikes.slice(0, DASHBOARD_LIMIT).map(s => {
    const pct = s.h.spikePercent;
    const arrow = pct >= 0 ? '↑' : '↓';
    return '<tr data-pid="' + s.pid + '" style="cursor:pointer">' +
      '<td>' + s.pid + '</td><td>' + escapeHtml(s.name) + '</td>' +
      '<td>' + formatBytes(s.h.current) + '</td>' +
      '<td style="color:' + COLORS.TEXT_DIM + '">' + formatBytes(s.h.baseline) + '</td>' +
      '<td style="color:' + COLORS.SPIKE_WARM + '">' + formatBytes(s.h.peak) + '</td>' +
      '<td style="color:' + COLORS.SPIKE_HOT + ';font-weight:600">' + arrow + Math.abs(pct) + '%</td></tr>';
  }).join('');
}

/**
 * Render the "疑似内存泄漏" dashboard card (sustained upward trends).
 */
function renderLeaks() {
  const leaks = [];
  for (const p of state.allProcesses) {
    const h = state.processHistory[p.pid];
    if (!h || h.sampleCount < LEAK_MIN_SAMPLES) continue;
    if (h.leakPercent >= LEAK_THRESHOLD) {
      leaks.push({ pid: p.pid, name: p.name, h });
    }
  }
  leaks.sort((a, b) => b.h.leakPercent - a.h.leakPercent);

  if (leaks.length === 0) {
    el('leakTbody').innerHTML = '<tr><td colspan="5" class="empty">暂无内存泄漏迹象 (需≥' +
      LEAK_MIN_SAMPLES + '个样本+≥' + LEAK_THRESHOLD + '%增长)</td></tr>';
    return;
  }
  el('leakTbody').innerHTML = leaks.slice(0, DASHBOARD_LIMIT).map(l => {
    const pct = l.h.leakPercent;
    return '<tr data-pid="' + l.pid + '" style="cursor:pointer">' +
      '<td>' + l.pid + '</td><td>' + escapeHtml(l.name) + '</td>' +
      '<td>' + formatBytes(l.h.current) + '</td>' +
      '<td style="color:' + COLORS.TEXT_DIM + '">' + formatBytes(l.h.baseline) + '</td>' +
      '<td style="color:' + COLORS.SPIKE_HOT + ';font-weight:600">↗ +' + pct + '%/窗</td></tr>';
  }).join('');
}

/**
 * Render the system memory summary (top of dashboard).
 */
function renderSystem(sys) {
  if (!sys) return;
  const totalGB = (sys.totalPhysicalMemory / 1024 / 1024 / 1024).toFixed(1);
  const usedGB = ((sys.totalPhysicalMemory - sys.availablePhysicalMemory) / 1024 / 1024 / 1024).toFixed(1);
  el('totalMem').textContent = totalGB + ' GB';
  el('freeMem').textContent = (sys.availablePhysicalMemory / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  el('memLoad').textContent = sys.memoryLoad + '%';
  el('procCount').textContent = state.allProcesses.length;
  el('memDetail').textContent = usedGB + ' / ' + totalGB + ' GB';
}

/**
 * Render the charts tab (line chart of a process's memory history).
 */
function renderChartPage() {
  const charts = require('./charts');
  const selectEl = el('chartProcess');
  const pid = Number(selectEl.value);
  const proc = pid ? state.allProcesses.find(p => p.pid === pid) : null;
  const pieData = proc
    ? [
        { name: '已用', value: state.sysUsedCache, color: COLORS.SPIKE_HOT },
        { name: '空闲', value: Math.max(state.sysTotalCache - state.sysUsedCache, 0), color: COLORS.TEXT_DIM },
      ]
    : [
        { name: '已用', value: state.systemCache ? state.systemCache.totalPhysicalMemory - state.systemCache.availablePhysicalMemory : 0, color: COLORS.SPIKE_HOT },
        { name: '空闲', value: state.systemCache ? state.systemCache.availablePhysicalMemory : 0, color: COLORS.TEXT_DIM },
      ];
  charts.drawPieChart(el('chartPie'), pieData);
  if (proc) {
    const h = state.processHistory[proc.pid];
    if (h && h.samples && h.samples.length > 0) {
      const points = h.samples.map((v, i) => ({ x: i, y: v }));
      charts.drawLineChart(el('chartLine'), [{ label: proc.name, color: COLORS.PRIMARY, points }]);
    } else {
      charts.drawLineChart(el('chartLine'), []);
    }
  } else {
    charts.drawLineChart(el('chartLine'), []);
  }
}

/**
 * Populate the chart-process <select> with currently-available processes.
 */
function populateChartProcesses() {
  const selectEl = el('chartProcess');
  if (!selectEl) return;
  const previousValue = selectEl.value;
  selectEl.innerHTML = '<option value="">-- 选择进程 --</option>' +
    state.allProcesses.slice(0, PROCESS_TABLE_LIMIT).map(p =>
      '<option value="' + p.pid + '">' + escapeHtml(p.name) + ' (' + p.pid + ')</option>'
    ).join('');
  if (previousValue) selectEl.value = previousValue;
}

/**
 * Show the detail panel for a process (called from table row click).
 */
function showDetail(pid) {
  state.selectedPid = pid;
  const proc = state.allProcesses.find(p => p.pid === pid);
  const h = state.processHistory[pid] || {};
  const panel = el('detail');
  if (!panel) return;
  if (!proc) {
    panel.innerHTML = '<p style="color:' + COLORS.TEXT_DIM + '">进程已退出</p>';
    return;
  }
  panel.innerHTML =
    '<h3>' + escapeHtml(proc.name) + ' <span style="color:' + COLORS.TEXT_DIM + ';font-size:12px">PID ' + pid + '</span></h3>' +
    '<table><tr><th>当前</th><td>' + formatBytes(proc.memoryUsage) + '</td></tr>' +
    (h.baseline ? '<tr><th>基线</th><td>' + formatBytes(h.baseline) + '</td></tr>' : '') +
    (h.peak ? '<tr><th>峰值</th><td>' + formatBytes(h.peak) + '</td></tr>' : '') +
    (h.spikePercent != null ? '<tr><th>突变</th><td>' + h.spikePercent + '%</td></tr>' : '') +
    (h.leakPercent != null ? '<tr><th>泄漏</th><td>' + h.leakPercent + '%</td></tr>' : '') +
    '<tr><th>样本数</th><td>' + (h.sampleCount || 0) + '</td></tr></table>' +
    '<p style="margin-top:12px;font-size:12px;color:' + COLORS.TEXT_DIM + '">右键点击进程表行可执行操作</p>';
  renderTable(); // re-render to show selection highlight
}

module.exports = {
  setThresholds,
  getFilteredProcesses,
  renderSpikeCell,
  renderProcessRow,
  renderTable,
  renderSpikes,
  renderLeaks,
  renderSystem,
  renderChartPage,
  populateChartProcesses,
  showDetail,
  COLORS,
};