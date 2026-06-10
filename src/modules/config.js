// Config module — bridges between the user-config UI and the main-process
// config service. Owns the in-memory thresholds (SPIKE_THRESHOLD,
// LEAK_THRESHOLD) that the dashboard cards consult, and pushes changes
// back to disk via IPC.

const state = require('./state');
const { el, showToast } = require('./utils');
const processTable = require('./process-table');
const { latencyColor } = require('./theme');

const REFRESH_INTERVAL_MS = 2000;

/**
 * Load config from main process and apply to UI + shared state.
 * Called once on startup.
 */
async function loadConfig() {
  const cfg = await state.api.getConfig();
  applyConfig(cfg);
}

/**
 * Apply a config object to UI inputs, recording defaults, and the
 * spike/leak thresholds in process-table module.
 */
function applyConfig(cfg) {
  state.currentConfig = cfg;
  // Push thresholds into process-table module
  processTable.setThresholds(cfg.spikeThreshold, cfg.leakThreshold);
  // Sync inputs
  if (el('cfgSpikeThreshold')) el('cfgSpikeThreshold').value = cfg.spikeThreshold;
  if (el('cfgLeakThreshold')) el('cfgLeakThreshold').value = cfg.leakThreshold;
  if (el('cfgRecordingTopN')) el('cfgRecordingTopN').value = cfg.recordingTopN;
  // Update leak card hint
  if (el('leakThresholdHint')) el('leakThresholdHint').textContent = cfg.leakThreshold;
  // Sync recording defaults
  if (el('recTopN')) el('recTopN').value = cfg.recordingTopN;
  if (el('recInterval')) el('recInterval').value = cfg.recordingInterval;
  // Re-render dashboard cards so thresholds take effect immediately
  processTable.renderSpikes();
  processTable.renderLeaks();
}

/**
 * Read the three UI inputs and send a partial-update patch to the
 * main process.
 */
async function saveConfigFromUI() {
  const patch = {
    spikeThreshold: Number(el('cfgSpikeThreshold').value),
    leakThreshold: Number(el('cfgLeakThreshold').value),
    recordingTopN: Number(el('cfgRecordingTopN').value),
  };
  const result = await state.api.setConfig(patch);
  if (result.ok) {
    applyConfig(result.config);
    const status = el('cfgStatus');
    if (status) {
      status.textContent = '已保存 ✓';
      setTimeout(() => { status.textContent = ''; }, 2000);
    }
    showToast('设置已保存', 'info');
  } else {
    const status = el('cfgStatus');
    if (status) {
      status.textContent = '保存失败';
      status.style.color = '#ff4d4f';
    }
    showToast('保存失败: ' + result.error, 'error');
  }
}

/**
 * Reset all settings to defaults.
 */
async function resetConfig() {
  const result = await state.api.resetConfig();
  if (result.ok) {
    applyConfig(result.config);
    const status = el('cfgStatus');
    if (status) {
      status.textContent = '已恢复默认 ✓';
      setTimeout(() => { status.textContent = ''; }, 2000);
    }
    showToast('已恢复默认设置', 'info');
  }
}

/**
 * Live collector stats from the main-process PowerShell session.
 * Updates the "PS: 75ms | 请求 42" indicator in the footer.
 */
async function updateCollectorStats() {
  const status = el('collectorStats');
  if (!status) return;
  try {
    const stats = await state.api.getCollectorStats();
    if (!stats.alive) {
      status.textContent = 'PS: 未启动';
      status.style.color = '#999';
      return;
    }
    const lat = stats.lastDurationMs != null ? stats.lastDurationMs + 'ms' : '--';
    const errSuffix = stats.errors > 0 ? ' | 错误 ' + stats.errors : '';
    const pendSuffix = stats.pending ? ' | 处理中' : '';
    const qSuffix = stats.queueLength > 0 ? ' | 队列 ' + stats.queueLength : '';
    status.textContent = 'PS: ' + lat + ' | 请求 ' + stats.requests + errSuffix + pendSuffix + qSuffix;
    const d = stats.lastDurationMs;
    status.style.color = latencyColor(d);
  } catch (e) {
    status.textContent = 'PS: 错误';
    status.style.color = latencyColor(null);
  }
}

/**
 * Wire click handlers for the config card.
 */
function bindConfigEvents() {
  const save = el('cfgSave');
  if (save) save.addEventListener('click', saveConfigFromUI);
  const reset = el('cfgReset');
  if (reset) reset.addEventListener('click', resetConfig);
}

module.exports = {
  loadConfig,
  applyConfig,
  saveConfigFromUI,
  resetConfig,
  updateCollectorStats,
  bindConfigEvents,
  REFRESH_INTERVAL_MS,
};