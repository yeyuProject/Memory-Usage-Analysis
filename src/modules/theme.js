// Unified theme: colors, latency helper, and shared style tokens.
//
// Before this module, hex colors were hardcoded in 6 files:
//   - process-table.js: named COLORS palette (SPIKE_HOT, etc.)
//   - charts.js: array COLORS for chart series + separate TEXT/GRID/AXIS
//   - renderer.js: 3 inline hex literals for system load + pie chart
//   - config.js: 3 inline hex literals for latency indicator
//   - notifications.js: 2 inline hex literals for triggered/ok status
//   - export.js: 3 inline hex literals in a giant HTML template
//
// This module consolidates all of them. Modules import named colors
// instead of writing hex strings; the latencyColor() helper centralizes
// the <200ms=green / 200-500=orange / >500=red rule (previously duplicated
// as inline if/else chains in 2 places).

// ===== Named palette =====
// Single source of truth for semantic colors. Matches Ant Design's
// red/orange/green/blue palette. Reused by status indicators, charts,
// and the notification feed.
const COLORS = {
  // Semantic (theme)
  PRIMARY:   '#1890ff',
  SUCCESS:   '#52c41a',
  WARNING:   '#faad14',
  DANGER:    '#ff4d4f',
  TEXT_DIM:  '#999',
  TEXT_MUTED: '#666',

  // Spike-card semantics
  SPIKE_HOT:  '#ff4d4f',
  SPIKE_WARM: '#faad14',
  SPIKE_COOL: '#52c41a',

  // Chart series (categorical palette, ordered by prominence)
  CHART_SERIES: [
    '#1890ff', // blue
    '#52c41a', // green
    '#faad14', // orange
    '#ff4d4f', // red
    '#722ed1', // purple
    '#13c2c2', // cyan
    '#eb2f96', // magenta
  ],

  // Chart axes / grid
  AXIS_COLOR: '#d9d9d9',
  GRID_COLOR: '#f0f0f0',
};

// ===== Latency color helper =====
// Used by the status-bar "PS: 75ms" indicator and could be reused for
// any other latency gauge. Returns a hex color for a given ms value.
const LATENCY_GREEN_MS  = 200;
const LATENCY_ORANGE_MS = 500;

/**
 * Map a latency in milliseconds to a status color.
 *   null/undefined/NaN → grey  (no data yet)
 *   < 200ms             → green  (fast)
 *   200-499ms           → orange (slow, investigate)
 *   >= 500ms            → red    (broken or very slow)
 *
 * @param {number|null|undefined} latencyMs
 * @returns {string} hex color
 */
function latencyColor(latencyMs) {
  if (latencyMs == null || Number.isNaN(latencyMs)) return COLORS.TEXT_DIM;
  if (latencyMs < LATENCY_GREEN_MS) return COLORS.SUCCESS;
  if (latencyMs < LATENCY_ORANGE_MS) return COLORS.WARNING;
  return COLORS.DANGER;
}

/**
 * Map a percentage (0-100) to a memory-load color.
 *   <= 60%   → blue   (normal)
 *   61-80%   → orange (high)
 *   > 80%    → red    (critical)
 *
 * @param {number} percent - 0-100
 * @returns {string} hex color
 */
function loadColor(percent) {
  if (percent > 80) return COLORS.DANGER;
  if (percent > 60) return COLORS.WARNING;
  return COLORS.PRIMARY;
}

module.exports = {
  COLORS,
  latencyColor,
  loadColor,
  LATENCY_GREEN_MS,
  LATENCY_ORANGE_MS,
};