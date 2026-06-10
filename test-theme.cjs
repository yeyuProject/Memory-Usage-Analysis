// Tests for the unified theme module (src/modules/theme.js).
//
// Why this exists: before theme.js, hex colors were hardcoded across 6
// files (renderer, config, notifications, charts, export, index.html).
// A single source of truth means changing the palette is a 1-line edit.
// These tests guard the two public helpers (latencyColor, loadColor)
// against regressions in the boundary conditions.

const { test, assert, assertEq, passed, failed } = require('./test-helpers.cjs');
const { COLORS, latencyColor, loadColor, LATENCY_GREEN_MS, LATENCY_ORANGE_MS } = require('./src/modules/theme.js');

console.log('\n=== test-theme ===\n');

// ===== latencyColor: null / undefined / NaN =====
test('latencyColor: null returns TEXT_DIM (grey)', () => {
  assertEq(latencyColor(null), COLORS.TEXT_DIM);
});
test('latencyColor: undefined returns TEXT_DIM (grey)', () => {
  assertEq(latencyColor(undefined), COLORS.TEXT_DIM);
});
test('latencyColor: NaN returns TEXT_DIM (grey)', () => {
  assertEq(latencyColor(NaN), COLORS.TEXT_DIM);
});
test('latencyColor: missing argument returns TEXT_DIM (grey)', () => {
  assertEq(latencyColor(), COLORS.TEXT_DIM);
});

// ===== latencyColor: fast (green) =====
test('latencyColor: 0ms returns SUCCESS (green)', () => {
  assertEq(latencyColor(0), COLORS.SUCCESS);
});
test('latencyColor: 1ms returns SUCCESS (green)', () => {
  assertEq(latencyColor(1), COLORS.SUCCESS);
});
test('latencyColor: 100ms returns SUCCESS (green)', () => {
  assertEq(latencyColor(100), COLORS.SUCCESS);
});
test(`latencyColor: ${LATENCY_GREEN_MS - 1}ms returns SUCCESS (green)`, () => {
  assertEq(latencyColor(LATENCY_GREEN_MS - 1), COLORS.SUCCESS);
});

// ===== latencyColor: slow (orange) — boundary =====
test(`latencyColor: ${LATENCY_GREEN_MS}ms returns WARNING (orange, boundary)`, () => {
  assertEq(latencyColor(LATENCY_GREEN_MS), COLORS.WARNING);
});
test('latencyColor: 300ms returns WARNING (orange)', () => {
  assertEq(latencyColor(300), COLORS.WARNING);
});
test(`latencyColor: ${LATENCY_ORANGE_MS - 1}ms returns WARNING (orange)`, () => {
  assertEq(latencyColor(LATENCY_ORANGE_MS - 1), COLORS.WARNING);
});

// ===== latencyColor: broken (red) — boundary =====
test(`latencyColor: ${LATENCY_ORANGE_MS}ms returns DANGER (red, boundary)`, () => {
  assertEq(latencyColor(LATENCY_ORANGE_MS), COLORS.DANGER);
});
test('latencyColor: 1000ms returns DANGER (red)', () => {
  assertEq(latencyColor(1000), COLORS.DANGER);
});
test('latencyColor: 60000ms returns DANGER (red)', () => {
  assertEq(latencyColor(60000), COLORS.DANGER);
});

// ===== loadColor: normal (blue) =====
test('loadColor: 0% returns PRIMARY (blue)', () => {
  assertEq(loadColor(0), COLORS.PRIMARY);
});
test('loadColor: 30% returns PRIMARY (blue)', () => {
  assertEq(loadColor(30), COLORS.PRIMARY);
});
test('loadColor: 60% returns PRIMARY (blue, boundary)', () => {
  assertEq(loadColor(60), COLORS.PRIMARY);
});

// ===== loadColor: high (orange) =====
test('loadColor: 61% returns WARNING (orange, boundary)', () => {
  assertEq(loadColor(61), COLORS.WARNING);
});
test('loadColor: 70% returns WARNING (orange)', () => {
  assertEq(loadColor(70), COLORS.WARNING);
});
test('loadColor: 80% returns WARNING (orange, boundary)', () => {
  assertEq(loadColor(80), COLORS.WARNING);
});

// ===== loadColor: critical (red) =====
test('loadColor: 81% returns DANGER (red, boundary)', () => {
  assertEq(loadColor(81), COLORS.DANGER);
});
test('loadColor: 95% returns DANGER (red)', () => {
  assertEq(loadColor(95), COLORS.DANGER);
});
test('loadColor: 100% returns DANGER (red)', () => {
  assertEq(loadColor(100), COLORS.DANGER);
});

// ===== COLORS palette integrity =====
test('COLORS: has all expected semantic keys', () => {
  for (const k of ['PRIMARY', 'SUCCESS', 'WARNING', 'DANGER', 'TEXT_DIM', 'TEXT_MUTED']) {
    assert(typeof COLORS[k] === 'string' && COLORS[k].startsWith('#'), `missing ${k}`);
  }
});
test('COLORS: has spike card semantics', () => {
  assertEq(COLORS.SPIKE_HOT,  COLORS.DANGER);
  assertEq(COLORS.SPIKE_WARM, COLORS.WARNING);
  assertEq(COLORS.SPIKE_COOL, COLORS.SUCCESS);
});
test('COLORS: chart series has 7 distinct hex colors', () => {
  assert(Array.isArray(COLORS.CHART_SERIES), 'CHART_SERIES not array');
  assertEq(COLORS.CHART_SERIES.length, 7);
  const unique = new Set(COLORS.CHART_SERIES);
  assertEq(unique.size, 7, 'duplicates in CHART_SERIES');
  for (const c of COLORS.CHART_SERIES) {
    assert(typeof c === 'string' && c.startsWith('#'), `bad color: ${c}`);
  }
});
test('COLORS: chart axis/grid colors present', () => {
  assertEq(COLORS.AXIS_COLOR, '#d9d9d9');
  assertEq(COLORS.GRID_COLOR, '#f0f0f0');
});

(async () => {
  // Wait for any pending promises
  await new Promise(r => setTimeout(r, 50));
  console.log(`\n通过: ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
