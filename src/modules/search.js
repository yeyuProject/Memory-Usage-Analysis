// Search helpers: smart process name matching + HTML highlight regex.
//
// Both compile per-term (not per-process) for performance. Calling
// compileSearchMatcher(term) parses the term ONCE and returns a closure
// that runs in O(orParts) per process — see the 4.7x speedup in
// bench-renderer.cjs.

const { escapeHtml } = require('./utils');

/**
 * Smart process name matcher (pre-compiled). Splits the term on ';' for OR,
 * normalizes each part once, then returns a closure that runs in O(orParts)
 * per process instead of re-parsing the term for every process on every render.
 *
 * Supports:
 *   "chrome"        - substring match (default, backward compatible)
 *   "chrome*"       - prefix match (must start with "chrome")
 *   "chrome;code"   - OR match (any of the terms matches)
 *   "chrome*;code"  - prefix + OR combined
 *
 * @param {string} term - raw search term (already lowercased by caller)
 * @returns {((p:object)=>boolean)|null} matcher closure, or null if term is empty
 */
function compileSearchMatcher(term) {
  if (!term) return null;
  const orParts = term.split(';').map(s => s.trim()).filter(Boolean);
  if (orParts.length === 0) return null;
  const compiled = orParts.map(part => {
    if (part.endsWith('*')) {
      return { kind: 'prefix', value: part.slice(0, -1) };
    }
    return { kind: 'substring', value: part };
  });
  return (p) => {
    const name = p.name.toLowerCase();
    const pidStr = String(p.pid);
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (c.kind === 'prefix') {
        if (name.startsWith(c.value) || pidStr.startsWith(c.value)) return true;
      } else {
        if (name.includes(c.value) || pidStr.includes(c.value)) return true;
      }
    }
    return false;
  };
}

// Cached highlight regex — rebuilt only when term changes (avoids the
// `new RegExp()` cost on every render).
let _cachedHlTerm = null;
let _cachedHlRe = null;

/**
 * Get a case-insensitive global RegExp for highlighting the search term.
 * Cached by term string — call site passes the raw search term.
 *
 * @param {string} term - raw search term (will be regex-escaped internally)
 * @returns {RegExp|null}
 */
function getHighlightRe(term) {
  if (!term) return null;
  if (term === _cachedHlTerm) return _cachedHlRe;
  const escTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  _cachedHlRe = new RegExp('(' + escTerm + ')', 'gi');
  _cachedHlTerm = term;
  return _cachedHlRe;
}

/**
 * Highlight matches in a string by wrapping them with <mark> tags.
 * Escapes HTML first so user input can't inject markup.
 *
 * @param {any} s - the value to highlight (will be coerced to string)
 * @param {RegExp|null} re - from getHighlightRe()
 * @returns {string} HTML-safe string with <mark> wrapping matches
 */
function highlight(s, re) {
  if (!re || s == null) return escapeHtml(String(s));
  return escapeHtml(String(s)).replace(re, '<mark class="search-hl">$1</mark>');
}

module.exports = { compileSearchMatcher, getHighlightRe, highlight };