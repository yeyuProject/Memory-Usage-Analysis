// Recording module — controls the persistent recording feature.
//
// Talks to the main process via IPC:
//   start-recording, stop-recording, get-recording-status
//   list-recordings, delete-recording, export-recording-csv
//
// UI mirrors main-process state via `activeRecording` in state.js.
// While recording, a timer polls status every interval to update the
// live counter in the footer.

const state = require('./state');
const { el, showToast, setStatus, escapeHtml, formatBytes } = require('./utils');
const processTable = require('./process-table');

/**
 * Start a new system-wide recording. Reads TopN + interval from the
 * form, sends IPC, mirrors status in shared state.
 */
async function startRecording() {
  const interval = Math.max(1000, Number(el('recInterval').value) || 2000);
  const topN = Math.min(50, Math.max(5, Number(el('recTopN').value) || 20));
  const result = await state.api.startRecording({ interval, topN });
  if (!result.ok) {
    showToast(result.error || '启动录制失败', 'error');
    return;
  }
  el('recStart').disabled = true;
  el('recStop').disabled = false;
  if (state.statusPollTimer) clearInterval(state.statusPollTimer);
  state.statusPollTimer = setInterval(updateRecStatus, interval);
  await updateRecStatus();
  await loadRecordings();
  showToast('录制已开始 (Top ' + topN + ', 间隔 ' + interval + 'ms)', 'info');
}

/**
 * Stop the active recording. Mirrors status (now {active:false}).
 */
async function stopRecording() {
  const result = await state.api.stopRecording();
  if (!result.ok) {
    showToast(result.error || '停止录制失败', 'error');
    return;
  }
  if (state.statusPollTimer) {
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
  el('recStart').disabled = false;
  el('recStop').disabled = true;
  state.activeRecording = null;
  await updateRecStatus();
  await loadRecordings();
  showToast('录制完成: ' + result.sampleCount + ' 个采样点', 'info');
}

/**
 * Poll the main process for current recording status and update UI.
 */
async function updateRecStatus() {
  const status = await state.api.getRecordingStatus();
  const statusEl = el('recStatus');
  if (!statusEl) return;
  if (status.active) {
    state.activeRecording = status;
    const elapsed = ((Date.now() - status.startTime) / 1000).toFixed(1);
    statusEl.className = 'recording';
    statusEl.textContent =
      '录制中: Top ' + status.topN + ' | 已采集 ' + status.sampleCount +
      ' 个点 | ' + elapsed + 's | 间隔 ' + status.interval + 'ms';
  } else {
    statusEl.className = 'idle';
    statusEl.textContent = '未在录制 (数据保存到本地 JSONL, 刷新不丢失)';
  }
}

/**
 * Load the list of recordings from disk and re-render the table.
 */
async function loadRecordings() {
  state.recordings = await state.api.listRecordings();
  renderRecordings();
}

/**
 * Render the recordings table (id, start time, sample count, size, actions).
 */
function renderRecordings() {
  const tbody = el('recTbody');
  if (!tbody) return;
  if (!state.recordings || state.recordings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无录制</td></tr>';
    return;
  }
  tbody.innerHTML = state.recordings.map(r => {
    const sizeKb = (r.sizeBytes / 1024).toFixed(1);
    const dur = r.sampleCount && r.interval
      ? (r.sampleCount * r.interval / 1000).toFixed(0) + 's'
      : '-';
    return '<tr>' +
      '<td style="font-family:monospace;font-size:11px" title="' + escapeHtml(r.id) + '">' + escapeHtml(r.id) + '</td>' +
      '<td>' + new Date(r.startTime).toLocaleString() + '</td>' +
      '<td>' + (r.sampleCount || 0) + ' <span style="color:' + processTable.COLORS.TEXT_DIM + ';font-size:11px">(' + dur + ')</span></td>' +
      '<td>' + r.interval + 'ms</td>' +
      '<td>' + sizeKb + ' KB</td>' +
      '<td>' +
        '<button class="btn btn-export-csv" data-export-rec="' + r.id + '" title="导出为CSV">CSV</button>' +
        '<button class="btn btn-danger" data-del-rec="' + r.id + '" title="删除录制">删除</button>' +
      '</td></tr>';
  }).join('');
}

/**
 * Delete a recording by id.
 */
async function deleteRecording(id) {
  const result = await state.api.deleteRecording(id);
  if (result.ok) {
    await loadRecordings();
    showToast('已删除', 'info');
  } else {
    showToast('删除失败: ' + result.error, 'error');
  }
}

/**
 * Export a recording to CSV (main process shows save dialog).
 */
async function exportRecordingCsv(id) {
  const result = await state.api.exportRecordingCsv(id);
  if (result.ok) {
    showToast('已导出: ' + result.filePath, 'info');
  } else if (result.error !== '用户取消') {
    showToast('导出失败: ' + result.error, 'error');
  }
}

/**
 * Copy the top-50 processes (by memory) to the system clipboard as CSV.
 * Use case: paste into chat/ticket/issue tracker without saving a file first.
 */
async function copyTop50ToClipboard() {
  if (!state.allProcesses || state.allProcesses.length === 0) {
    showToast('暂无进程数据可复制', 'warn');
    return;
  }
  const top = state.allProcesses.slice(0, 50);
  const csvEscape = v => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const totalMem = state.systemCache ? state.systemCache.totalPhysicalMemory : 1;
  const lines = ['rank,pid,name,memoryMB,percentOfTotal'];
  top.forEach((p, i) => {
    lines.push([
      i + 1,
      p.pid,
      csvEscape(p.name),
      (p.memoryUsage / 1024 / 1024).toFixed(1),
      ((p.memoryUsage / totalMem) * 100).toFixed(2),
    ].join(','));
  });
  const summary = [
    '# Top ' + top.length + ' of ' + state.allProcesses.length + ' processes by memory',
    '# System total: ' + (totalMem / 1024 / 1024 / 1024).toFixed(1) + ' GB',
    '# System used: ' + (state.systemCache ? ((totalMem - state.systemCache.availablePhysicalMemory) / 1024 / 1024 / 1024).toFixed(1) : '?') + ' GB',
    '# Generated: ' + new Date().toISOString(),
  ].join('\n');
  const csv = summary + '\n' + lines.join('\n');

  const result = await state.api.writeClipboard(csv);
  if (result.success) {
    showToast('已复制 Top ' + top.length + ' 进程到剪贴板 (' + (csv.length / 1024).toFixed(1) + ' KB)', 'info');
    const preview = el('exportPreview');
    if (preview) {
      preview.className = '';
      preview.innerHTML = '<b>已复制 Top ' + top.length + ' 到剪贴板</b><br>格式: CSV (含系统内存摘要)<br>大小: ' +
        (csv.length / 1024).toFixed(1) + ' KB<br>时间: ' + new Date().toLocaleString();
    }
  } else {
    showToast('复制失败: ' + (result.error || '未知错误'), 'error');
  }
}

/**
 * Wire click handlers for the recordings table action buttons.
 * Called once from renderer.js on startup.
 */
function bindRecordingsEvents() {
  const tbody = el('recTbody');
  if (!tbody) return;
  tbody.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.delRec) deleteRecording(t.dataset.delRec);
    else if (t.dataset.exportRec) exportRecordingCsv(t.dataset.exportRec);
  });
  const startBtn = el('recStart');
  const stopBtn = el('recStop');
  if (startBtn) startBtn.addEventListener('click', startRecording);
  if (stopBtn) stopBtn.addEventListener('click', stopRecording);
}

module.exports = {
  startRecording,
  stopRecording,
  updateRecStatus,
  loadRecordings,
  renderRecordings,
  deleteRecording,
  exportRecordingCsv,
  copyTop50ToClipboard,
  bindRecordingsEvents,
};