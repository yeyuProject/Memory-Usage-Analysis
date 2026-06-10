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
/**
 * Resolve (and memoize) the absolute path to config.json inside userData.
 * Cached on first call since app.getPath('userData') is stable for the
 * process lifetime. Exported for tests that want to inspect the file.
 * @returns {string}
 */
function getConfigPath() {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json');
  return configPath;
}

/**
 * Validate a config patch: only accept known keys, clamp to safe ranges.
 * Defensive against malformed renderer input. Drops keys that fail
 * validation (NaN, Infinity, out-of-range, wrong type) silently rather
 * than throwing — partial saves are still useful.
 * @param {object} patch - candidate config fields from the UI
 * @returns {object} sanitized patch (subset of input)
 */
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

/**
 * Load the user config from disk, merged with DEFAULT_CONFIG.
 * Returns defaults if the file is missing or corrupt — never throws.
 * @returns {object} merged config (always has all 5 keys)
 */
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

/**
 * Merge patch with current config and persist to disk.
 * @param {object} patch - partial config to merge
 * @returns {{ok: true, config: object}|{ok: false, error: string}}
 */
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

/**
 * Overwrite config.json with DEFAULT_CONFIG (factory reset).
 * @returns {{ok: true, config: object}|{ok: false, error: string}}
 */
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
