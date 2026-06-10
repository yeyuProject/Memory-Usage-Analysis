// DOM helpers and formatters used across the renderer.
//
// Pure functions only — no state. Safe to import from any module.

const $ = (id) => document.getElementById(id);

// Cache of element references keyed by id. Populated lazily on first use.
const _elCache = {};
function el(id) {
  if (!_elCache[id]) _elCache[id] = document.getElementById(id);
  return _elCache[id];
}

/**
 * Format a byte count as a human-readable string.
 * @param {number} b - bytes
 * @returns {string} e.g. "512 B", "1.5 KB", "2.0 MB", "16.00 GB"
 */
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * Short form for axis labels (no decimals, larger units).
 * @param {number} b - bytes
 */
function formatShort(b) {
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + 'K';
  if (b < 1024 * 1024 * 1024) return Math.round(b / 1024 / 1024) + 'M';
  return (b / 1024 / 1024 / 1024).toFixed(1) + 'G';
}

/**
 * Escape user-controlled strings before inserting into innerHTML.
 * Always use this — never trust process names, file paths, or search terms.
 * @param {any} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Show a transient toast notification.
 * @param {string} msg
 * @param {'info'|'warn'|'error'} type
 */
function showToast(msg, type = 'info') {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast'; }, 2500);
}

/**
 * Set the status bar text in the footer.
 * @param {string} msg
 */
function setStatus(msg) {
  const s = el('status');
  if (s) s.textContent = msg;
}

/**
 * Set transient text on an element that auto-clears after a delay.
 * Used by the config save/reset buttons to show "已保存 ✓" then clear.
 * @param {string} id - element id
 * @param {string} text - text to show
 * @param {number} ms - how long to show before clearing (default 2000)
 */
function setTransientText(id, text, ms = 2000) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  setTimeout(() => { node.textContent = ''; }, ms);
}

module.exports = { $, el, formatBytes, formatShort, escapeHtml, showToast, setStatus, setTransientText };