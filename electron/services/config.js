// User config persistence.
//
// Persists spike/leak thresholds and recording defaults to userData/config.json.
// Schema is flat (one level deep) for readability and safe partial updates.
//
// Functions:
//   getConfig()              -> merged config object
//   saveConfig(patch)        -> merge with existing, persist
//   resetConfig()            -> write defaults
//   getConfigPath()          -> absolute path (testability)

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  spikeThreshold: 50,        // % deviation that triggers spike card
  leakThreshold: 30,         // % slope/window that flags a leak
  recordingTopN: 20,         // default Top-N for new recordings
  recordingInterval: 2000,   // default sample interval in ms
  notificationCooldown: 60,  // seconds between same-process notifications
};

let configPath = null;
function getConfigPath() {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json');
  return configPath;
}

// Validate a config patch: only accept known keys, clamp to safe ranges.
// Defensive against malformed renderer input.
function sanitizeConfig(patch) {
  const out = {};
  if (typeof patch.spikeThreshold === 'number' && Number.isFinite(patch.spikeThreshold)) {
    out.spikeThreshold = Math.min(500, Math.max(5, Math.round(patch.spikeThreshold)));
  }
  if (typeof patch.leakThreshold === 'number' && Number.isFinite(patch.leakThreshold)) {
    out.leakThreshold = Math.min(500, Math.max(1, Math.round(patch.leakThreshold)));
  }
  if (typeof patch.recordingTopN === 'number' && Number.isFinite(patch.recordingTopN)) {
    out.recordingTopN = Math.min(50, Math.max(5, Math.round(patch.recordingTopN)));
  }
  if (typeof patch.recordingInterval === 'number' && Number.isFinite(patch.recordingInterval)) {
    out.recordingInterval = Math.min(60000, Math.max(1000, Math.round(patch.recordingInterval)));
  }
  if (typeof patch.notificationCooldown === 'number' && Number.isFinite(patch.notificationCooldown)) {
    out.notificationCooldown = Math.min(3600, Math.max(0, Math.round(patch.notificationCooldown)));
  }
  return out;
}

function loadConfig() {
  try {
    if (!fs.existsSync(getConfigPath())) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Merge: defaults first, then saved values (only known keys survive via sanitizeConfig)
    return { ...DEFAULT_CONFIG, ...sanitizeConfig(parsed) };
  } catch (e) {
    // Corrupt config: fall back to defaults, do not crash app
    console.error('[loadConfig] error:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  const clean = sanitizeConfig(patch);
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: '没有可保存的有效字段' };
  }
  const current = loadConfig();
  const next = { ...current, ...clean };
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return { ok: true, config: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resetConfig() {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    return { ok: true, config: { ...DEFAULT_CONFIG } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  sanitizeConfig,
  loadConfig,
  saveConfig,
  resetConfig,
  getConfigPath,
};
