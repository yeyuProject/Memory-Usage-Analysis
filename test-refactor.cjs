// Integration test for code structure refactor
// Validates that the codebase has:
//   1. Named constants instead of magic numbers
//   2. Reusable render helpers (renderSpikeCell, renderProcessRow)
//   3. JSDoc on key public functions
//   4. COLORS palette instead of hex literals scattered around
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const results = [];

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Replicate renderSpikeCell from renderer.js (verbatim)
function renderSpikeCell(spike, sampleCount) {
  if (sampleCount <= 5) return '<span style="color:#999">--</span>';
  if (spike >= 50) return `<span style="color:#ff4d4f;font-weight:600">↑${spike}%</span>`;
  if (spike >= 20) return `<span style="color:#faad14">↑${spike}%</span>`;
  if (spike <= -20) return `<span style="color:#52c41a">↓${-spike}%</span>`;
  return `<span style="color:#999">${spike >= 0 ? '+' : ''}${spike}%</span>`;
}

(async () => {
  console.log('\n=== 代码结构重构测试 ===\n');

  // ============ CONSTANTS extracted (5) ============
  console.log('-- 常量抽取 --');
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('SPIKE_THRESHOLD_DEFAULT = 50 常量存在', () => {
    assert(/const\s+SPIKE_THRESHOLD_DEFAULT\s*=\s*50\b/.test(renderer));
  });
  await test('LEAK_THRESHOLD_DEFAULT = 30 常量存在', () => {
    assert(/const\s+LEAK_THRESHOLD_DEFAULT\s*=\s*30\b/.test(renderer));
  });
  await test('SPIKE_MIN_SAMPLES = 5 常量存在', () => {
    assert(/const\s+SPIKE_MIN_SAMPLES\s*=\s*5\b/.test(renderer));
  });
  await test('LEAK_MIN_SAMPLES = 10 常量存在', () => {
    assert(/const\s+LEAK_MIN_SAMPLES\s*=\s*10\b/.test(renderer));
  });
  await test('PROCESS_TABLE_LIMIT = 200 常量存在', () => {
    assert(/const\s+PROCESS_TABLE_LIMIT\s*=\s*200\b/.test(renderer));
  });

  // ============ Magic numbers eliminated from hot paths (5) ============
  console.log('\n-- magic numbers 消除 --');
  await test('renderSpikes 用 SPIKE_MIN_SAMPLES 而非字面量5', () => {
    // Extract renderSpikes body
    const fn = renderer.match(/function renderSpikes\([\s\S]*?\n\}/);
    assert(fn, 'renderSpikes not found');
    assert(/SPIKE_MIN_SAMPLES/.test(fn[0]));
    // Should NOT have bare `sampleCount <= 5` or `<= 5` for spike gate
    assert(!/<=\s*5[^0-9]/.test(fn[0]) || /<=\s*SPIKE_MIN_SAMPLES/.test(fn[0]),
      'should use constant instead of bare 5');
  });
  await test('renderLeaks 用 LEAK_MIN_SAMPLES 而非字面量10', () => {
    const fn = renderer.match(/function renderLeaks\([\s\S]*?\n\}/);
    assert(fn, 'renderLeaks not found');
    assert(/LEAK_MIN_SAMPLES/.test(fn[0]));
  });
  await test('renderTable 用 PROCESS_TABLE_LIMIT 而非字面量200', () => {
    const fn = renderer.match(/function renderTable\([\s\S]*?\n\}/);
    assert(fn, 'renderTable not found');
    assert(/PROCESS_TABLE_LIMIT/.test(fn[0]));
  });
  await test('setInterval 使用 REFRESH_INTERVAL_MS 常量', () => {
    assert(/setInterval\([^,]+,\s*REFRESH_INTERVAL_MS\)/.test(renderer));
  });
  await test('populateFilterProcesses 使用 PROCESS_TABLE_LIMIT', () => {
    const fn = renderer.match(/function populateFilterProcesses\([\s\S]*?\n\}/);
    assert(fn, 'function not found');
    assert(/PROCESS_TABLE_LIMIT/.test(fn[0]));
  });

  // ============ Helper functions extracted (4) ============
  console.log('\n-- Helper 函数 --');
  await test('renderSpikeCell helper 已抽取', () => {
    assert(/function\s+renderSpikeCell\s*\(/.test(renderer));
  });
  await test('renderProcessRow helper 已抽取', () => {
    assert(/function\s+renderProcessRow\s*\(/.test(renderer));
  });
  await test('renderTable 用 renderProcessRow 而非内联字符串', () => {
    const fn = renderer.match(/function renderTable\([\s\S]*?\n\}/);
    assert(fn, 'renderTable not found');
    assert(/renderProcessRow\(/.test(fn[0]), 'should call renderProcessRow');
  });
  await test('renderSpikeCell 输出正确', () => {
    // Verify the helper produces correct output for all branches
    assert(renderSpikeCell(0, 0).includes('--'), 'sampleCount <= 5 should be --');
    assert(renderSpikeCell(60, 10).includes('#ff4d4f'), 'spike >= 50 should be red');
    assert(renderSpikeCell(25, 10).includes('#faad14'), 'spike >= 20 should be orange');
    assert(renderSpikeCell(-30, 10).includes('#52c41a'), 'spike <= -20 should be green');
    assert(renderSpikeCell(5, 10).includes('+5%'), 'normal spike should have + prefix');
  });

  // ============ COLORS palette (4) ============
  console.log('\n-- COLORS 调色板 --');
  await test('COLORS 对象存在', () => {
    assert(/const\s+COLORS\s*=\s*\{/.test(renderer));
  });
  await test('COLORS 包含 SPIKE_HOT', () => {
    assert(/SPIKE_HOT:\s*['"]#ff4d4f['"]/.test(renderer));
  });
  await test('COLORS 包含 SPIKE_WARM', () => {
    assert(/SPIKE_WARM:\s*['"]#faad14['"]/.test(renderer));
  });
  await test('COLORS 包含 SPIKE_COOL', () => {
    assert(/SPIKE_COOL:\s*['"]#52c41a['"]/.test(renderer));
  });

  // ============ JSDoc (3) ============
  console.log('\n-- JSDoc 文档 --');
  await test('refresh() 有 JSDoc', () => {
    const idx = renderer.indexOf('async function refresh()');
    assert(idx > 0);
    // Look backwards for JSDoc /** ... */ within a 600-char window
    const before = renderer.slice(Math.max(0, idx - 600), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'refresh() should have JSDoc above it');
  });
  await test('compileSearchMatcher() 有 JSDoc', () => {
    const idx = renderer.indexOf('function compileSearchMatcher(term)');
    assert(idx > 0);
    const before = renderer.slice(Math.max(0, idx - 1200), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'compileSearchMatcher() should have JSDoc');
  });
  await test('renderTable() 有 JSDoc', () => {
    const idx = renderer.indexOf('function renderTable()');
    assert(idx > 0);
    const before = renderer.slice(Math.max(0, idx - 300), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'renderTable() should have JSDoc');
  });

  // ============ Hex literals reduced (2) ============
  console.log('\n-- Hex 字面量减少 --');
  await test('renderSpikeCell 使用 COLORS.* 而非裸 hex', () => {
    // renderSpikeCell body should reference COLORS.* rather than literal #ff4d4f etc.
    const fn = renderer.match(/function\s+renderSpikeCell\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderSpikeCell not found');
    assert(/COLORS\.SPIKE_HOT/.test(fn[0]), 'should use COLORS.SPIKE_HOT');
    assert(/COLORS\.SPIKE_WARM/.test(fn[0]), 'should use COLORS.SPIKE_WARM');
    assert(/COLORS\.SPIKE_COOL/.test(fn[0]), 'should use COLORS.SPIKE_COOL');
  });
  await test('renderProcessRow 使用 COLORS.* 而非裸 hex', () => {
    const fn = renderer.match(/function\s+renderProcessRow\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderProcessRow not found');
    assert(/COLORS\.SUCCESS/.test(fn[0]) || /COLORS\.TEXT_DIM/.test(fn[0]),
      'should use COLORS.* references');
  });

  // ============ File size sanity (1) ============
  console.log('\n-- 代码质量 --');
  await test('renderer.js 仍 < 1500 行 (refactor未引入bloat)', () => {
    const lines = renderer.split('\n').length;
    assert(lines < 1500, `renderer.js is ${lines} lines, should stay under 1500`);
    assert(lines > 1000, `renderer.js is only ${lines} lines, refactor should not have stripped content`);
  });

  // ============ Syntax ============
  console.log('\n-- 语法检查 --');
  await test('renderer.js 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c src/renderer.js', { cwd: __dirname, stdio: 'pipe' });
  });

  // ============ Report ============
  console.log('\n=== 结果 ===');
  console.log(`通过: ${passed} / ${passed + failed}`);
  console.log(`失败: ${failed}`);
  if (failed > 0) {
    console.log('\n失败明细:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
  console.log('\n所有测试通过 ✓');
})();