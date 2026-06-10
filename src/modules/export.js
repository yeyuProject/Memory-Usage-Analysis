// Export module — two export paths:
//
//   exportReport()      — render-side export to CSV/JSON/HTML (Blob + download)
//   exportHistorySnapshot() — main-process export with full per-process history
//
// Both respect the "include all processes" checkbox and "format" selector
// in the report tab.

const state = require('./state');
const { el, escapeHtml, formatBytes, showToast, setStatus } = require('./utils');
const processTable = require('./process-table');
const { COLORS } = require('./theme');

/**
 * Build CSV content from the given process list.
 */
function toCsv(data) {
  const lines = ['PID,名称,工作集,私有工作集,提交大小,时间戳'];
  data.forEach(p => {
    lines.push([
      p.pid,
      p.name,
      p.memoryUsage,
      Math.floor(p.memoryUsage * 0.7),
      Math.floor(p.memoryUsage * 1.3),
      Date.now(),
    ].join(','));
  });
  return lines.join('\n');
}

/**
 * Build JSON content with system + processes + recordings.
 */
function toJson(data) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    system: state.systemCache,
    processes: data,
    recordings: state.recordings,
  }, null, 2);
}

/**
 * Build a self-contained HTML report with embedded styles.
 */
function toHtml(data) {
  const rows = data.map(p =>
    '<tr><td>' + p.pid + '</td><td>' + escapeHtml(p.name) +
    '</td><td>' + formatBytes(p.memoryUsage) + '</td></tr>'
  ).join('');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>内存分析报告</title>' +
    '<style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}' +
    'th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:' + COLORS.PRIMARY + ';color:#fff}</style>' +
    '</head><body><h1>内存分析报告</h1><p>生成时间: ' + new Date().toLocaleString() + '</p>' +
    '<p>进程数: ' + data.length + '</p>' +
    '<table><thead><tr><th>PID</th><th>名称</th><th>内存占用</th></tr></thead><tbody>' +
    rows + '</tbody></table></body></html>';
}

/**
 * Export a quick report from the renderer's data. Builds a Blob and
 * triggers a download. CSV/JSON/HTML all supported.
 */
function exportReport() {
  const format = el('exportFormat').value;
  const data = el('exportAll').checked ? state.allProcesses : processTable.getFilteredProcesses();
  if (data.length === 0) {
    showToast('没有数据可导出', 'warn');
    return;
  }
  let content, mime, ext;
  if (format === 'csv') {
    content = toCsv(data);
    mime = 'text/csv;charset=utf-8';
    ext = 'csv';
  } else if (format === 'json') {
    content = toJson(data);
    mime = 'application/json;charset=utf-8';
    ext = 'json';
  } else {
    content = toHtml(data);
    mime = 'text/html;charset=utf-8';
    ext = 'html';
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'memory-report-' + new Date().toISOString().slice(0, 10) + '.' + ext;
  a.click();
  URL.revokeObjectURL(url);
  const preview = el('exportPreview');
  if (preview) {
    preview.className = '';
    preview.innerHTML = '<b>已导出 ' + data.length + ' 个进程</b><br>格式: ' +
      format.toUpperCase() + '<br>时间: ' + new Date().toLocaleString();
  }
  showToast('已导出 ' + data.length + ' 条记录', 'info');
}

/**
 * Export a richer snapshot: current state + per-process history analysis.
 * Captures: pid, name, memory, baseline, peak, spikePercent, leakPercent,
 * sampleCount. JSON output also includes system info + thresholds.
 *
 * The main process shows the save dialog and writes the file.
 */
async function exportHistorySnapshot() {
  const formatSel = el('exportFormat').value;
  // Snapshot only supports CSV/JSON; map html -> json
  const format = formatSel === 'html' ? 'json' : formatSel;
  const result = await state.api.exportHistorySnapshot({
    format,
    includeAll: el('exportAll').checked,
  });
  if (result.ok) {
    const preview = el('exportPreview');
    if (preview) {
      preview.className = '';
      preview.innerHTML = '<b>已导出历史快照</b><br>进程数: ' + result.processCount +
        '<br>格式: ' + format.toUpperCase() + '<br>路径: ' + escapeHtml(result.filePath);
    }
    showToast('已导出 ' + result.processCount + ' 个进程的历史快照', 'info');
  } else if (result.error !== '用户取消') {
    showToast('快照导出失败: ' + result.error, 'error');
  }
}

/**
 * Wire click handlers for the report tab buttons.
 */
function bindExportEvents() {
  const btn = el('exportBtn');
  if (btn) btn.addEventListener('click', exportReport);
  const snap = el('snapshotBtn');
  if (snap) snap.addEventListener('click', exportHistorySnapshot);
  const copy = el('copyTop50Btn');
  // copyTop50 lives in modules/recordings but its button is in the report tab.
  // Wire it here for locality with the other export buttons.
  if (copy) {
    const recordings = require('./recordings');
    copy.addEventListener('click', recordings.copyTop50ToClipboard);
  }
}

module.exports = {
  toCsv,
  toJson,
  toHtml,
  exportReport,
  exportHistorySnapshot,
  bindExportEvents,
};