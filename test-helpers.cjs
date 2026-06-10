// Shared test infrastructure for all test-*.cjs and bench-*.cjs files.
//
// Exports:
//   test(name, fn)     — async test runner with PASS/FAIL accounting
//   assert(cond, msg)  — assertion with optional message
//   assertEq(a, b, msg) — deep-equality assertion
//   passed, failed, results — global counters and result log
//
// Usage in a test file:
//   const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');
//
// At end of file:
//   console.log(`\n通过: ${passed} / ${passed + failed}`);
//   process.exit(failed > 0 ? 1 : 0);
//
// This module is intentionally tiny (no deps) and self-contained.

let passed = 0;
let failed = 0;
const results = [];

/**
 * Run a single test. The function may be sync or return a Promise.
 * Returns false to mark a "manual" failure.
 * @param {string} name - human-readable test name
 * @param {() => any|Promise<any>} fn - test body; returning false fails it
 */
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(result => {
      if (result === false) throw new Error('Test returned false');
      console.log(`  [PASS] ${name}`);
      passed++;
      results.push({ name, status: 'PASS' });
    })
    .catch(err => {
      console.log(`  [FAIL] ${name}: ${err.message}`);
      failed++;
      results.push({ name, status: 'FAIL', error: err.message });
    });
}

/** Boolean assertion with optional custom message. */
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/** Deep-equality assertion (===). */
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Reset counters — useful if a single file runs multiple test groups. */
function reset() {
  passed = 0;
  failed = 0;
  results.length = 0;
}

module.exports = { test, assert, assertEq, passed, failed, results, reset };
