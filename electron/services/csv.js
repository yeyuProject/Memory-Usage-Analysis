// Shared CSV utilities for the main process.
//
// The main process and the renderer run in isolated runtimes (Node vs
// Chromium) and cannot share a module. This file is the main-process
// counterpart of csvEscape in src/modules/utils.js. They MUST stay
// in sync — both implement RFC 4180 quote-doubling for the 3 trigger
// chars: comma, double-quote, newline.

/**
 * Escape a value for inclusion in a CSV cell. Wraps in double quotes and
 * doubles internal quotes per RFC 4180 when the value contains a comma,
 * quote, or newline. Used by recording exportCsv + history snapshot CSV.
 * @param {any} v
 * @returns {string}
 */
function csvEscape(v) {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = { csvEscape };
