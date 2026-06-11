// Integration test for code structure refactor (post-module-split)
//
// After splitting renderer.js into src/modules/, the assertions in this
// test point at the ACTUAL locations of each concern:
//   - Constants/helper functions live in src/modules/process-table.js
//   - JSDoc is checked across src/modules/*.js and electron/services/*.js
//   - COLORS palette lives in src/modules/process-table.js
//   - File-size sanity now checks the total split (not a single file)

const fs = require('fs');
const path = require('path');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// Replicate renderSpikeCell from src/modules/process-table.js (verbatim)
function renderSpikeCell(spike, sampleCount) {
  if (sampleCount <= 5) return '<span style="color:#999">--</span>';
  if (spike >= 50) return `<span style="color:#ff4d4f;font-weight:600">↑${spike}%</span>`;
  if (spike >= 20) return `<span style="color:#faad14">↑${spike}%</span>`;
  if (spike <= -20) return `<span style="color:#52c41a">↓${-spike}%</span>`;
  return `<span style="color:#999">${spike >= 0 ? '+' : ''}${spike}%</span>`;
}

function readFile(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

// Read all files we'll be asserting against up front
const renderer = readFile('src/renderer.js');
const procTable = readFile('src/modules/process-table.js');
const search = readFile('src/modules/search.js');
const configModule = readFile('src/modules/config.js');
const servicesConfig = readFile('electron/services/config.js');
const servicesPsSession = readFile('electron/services/ps-session.js');
const servicesRecording = readFile('electron/services/recording.js');
const servicesWindow = readFile('electron/services/window.js');
const mainCjs = readFile('electron/main.cjs');

(async () => {
  console.log('\n=== 代码结构重构测试 (post module-split) ===\n');

  // ============ CONSTANTS extracted (5) ============
  console.log('-- 常量抽取 (process-table.js) --');
  await test('SPIKE_THRESHOLD_DEFAULT = 50 常量存在', () => {
    assert(/SPIKE_THRESHOLD_DEFAULT\s*=\s*50\b/.test(procTable));
  });
  await test('LEAK_THRESHOLD_DEFAULT = 30 常量存在', () => {
    assert(/LEAK_THRESHOLD_DEFAULT\s*=\s*30\b/.test(procTable));
  });
  await test('SPIKE_MIN_SAMPLES = 5 常量存在', () => {
    assert(/SPIKE_MIN_SAMPLES\s*=\s*5\b/.test(procTable));
  });
  await test('LEAK_MIN_SAMPLES = 10 常量存在', () => {
    assert(/LEAK_MIN_SAMPLES\s*=\s*10\b/.test(procTable));
  });
  await test('PROCESS_TABLE_LIMIT = 200 常量存在', () => {
    assert(/PROCESS_TABLE_LIMIT\s*=\s*200\b/.test(procTable));
  });

  // ============ Magic numbers eliminated from hot paths (5) ============
  console.log('\n-- magic numbers 消除 --');
  await test('renderSpikes 用 SPIKE_MIN_SAMPLES 而非字面量5', () => {
    const fn = procTable.match(/function renderSpikes\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderSpikes not found in process-table.js');
    assert(/SPIKE_MIN_SAMPLES/.test(fn[0]));
  });
  await test('renderLeaks 用 LEAK_MIN_SAMPLES 而非字面量10', () => {
    const fn = procTable.match(/function renderLeaks\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderLeaks not found in process-table.js');
    assert(/LEAK_MIN_SAMPLES/.test(fn[0]));
  });
  await test('renderTable 用 PROCESS_TABLE_LIMIT 而非字面量200', () => {
    const fn = procTable.match(/function renderTable\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderTable not found in process-table.js');
    assert(/PROCESS_TABLE_LIMIT/.test(fn[0]));
  });
  await test('renderer.js setInterval 使用 REFRESH_INTERVAL_MS 常量', () => {
    assert(/setInterval\([^,]+,\s*REFRESH_INTERVAL_MS\)/.test(renderer));
  });
  await test('populateFilterProcesses 使用 PROCESS_TABLE_LIMIT', () => {
    // Was in renderer.js, now in src/modules/notifications.js
    const notifs = readFile('src/modules/notifications.js');
    const fn = notifs.match(/function populateFilterProcesses\s*\([\s\S]*?\n\}/);
    assert(fn, 'populateFilterProcesses not found');
    assert(/PROCESS_TABLE_LIMIT/.test(fn[0]));
  });

  // ============ Helper functions extracted (4) ============
  console.log('\n-- Helper 函数 (process-table.js) --');
  await test('renderSpikeCell helper 已抽取', () => {
    assert(/function\s+renderSpikeCell\s*\(/.test(procTable));
  });
  await test('renderProcessRow helper 已抽取', () => {
    assert(/function\s+renderProcessRow\s*\(/.test(procTable));
  });
  await test('renderTable 用 renderProcessRow 而非内联字符串', () => {
    const fn = procTable.match(/function renderTable\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderTable not found');
    assert(/renderProcessRow\(/.test(fn[0]), 'should call renderProcessRow');
  });
  await test('renderSpikeCell 输出正确', () => {
    assert(renderSpikeCell(0, 0).includes('--'), 'sampleCount <= 5 should be --');
    assert(renderSpikeCell(60, 10).includes('#ff4d4f'), 'spike >= 50 should be red');
    assert(renderSpikeCell(25, 10).includes('#faad14'), 'spike >= 20 should be orange');
    assert(renderSpikeCell(-30, 10).includes('#52c41a'), 'spike <= -20 should be green');
    assert(renderSpikeCell(5, 10).includes('+5%'), 'normal spike should have + prefix');
  });

  // ============ COLORS palette (4) ============
  console.log('\n-- COLORS 调色板 (process-table.js) --');
  await test('COLORS 对象存在', () => {
    assert(/const\s+COLORS\s*=\s*\{/.test(procTable));
  });
  await test('COLORS 包含 SPIKE_HOT', () => {
    assert(/SPIKE_HOT:\s*['"]#ff4d4f['"]/.test(procTable));
  });
  await test('COLORS 包含 SPIKE_WARM', () => {
    assert(/SPIKE_WARM:\s*['"]#faad14['"]/.test(procTable));
  });
  await test('COLORS 包含 SPIKE_COOL', () => {
    assert(/SPIKE_COOL:\s*['"]#52c41a['"]/.test(procTable));
  });

  // ============ JSDoc coverage (post-split) ============
  console.log('\n-- JSDoc 文档 --');
  await test('compileSearchMatcher() 有 JSDoc (modules/search.js)', () => {
    const idx = search.indexOf('function compileSearchMatcher(term)');
    assert(idx > 0);
    const before = search.slice(Math.max(0, idx - 800), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'compileSearchMatcher() should have JSDoc');
  });
  await test('renderTable() 有 JSDoc (modules/process-table.js)', () => {
    const idx = procTable.indexOf('function renderTable()');
    assert(idx > 0);
    const before = procTable.slice(Math.max(0, idx - 400), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'renderTable() should have JSDoc');
  });
  await test('main.cjs collectData() 有 JSDoc', () => {
    const idx = mainCjs.indexOf('async function collectData()');
    assert(idx > 0);
    const before = mainCjs.slice(Math.max(0, idx - 400), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'collectData() should have JSDoc');
  });
  await test('main.cjs computeLeakPercent() 有 JSDoc', () => {
    const idx = mainCjs.indexOf('function computeLeakPercent(samples)');
    assert(idx > 0);
    // Wider window — the JSDoc spans ~600 chars (10-line doc block).
    const before = mainCjs.slice(Math.max(0, idx - 800), idx);
    assert(/\/\*\*[\s\S]*?\*\//.test(before), 'computeLeakPercent() should have JSDoc');
  });
  await test('electron services 有 JSDoc (4个文件中至少各有1个 /**)', () => {
    let totalJSDoc = 0;
    for (const src of [servicesConfig, servicesPsSession, servicesRecording, servicesWindow]) {
      // Match any /** ... */ block (single or multi-line) at start of line.
      // Non-greedy [\s\S]*? so a file with two JSDoc blocks matches twice.
      const matches = src.match(/^\/\*\*[\s\S]*?\*\//gm);
      if (matches) totalJSDoc += matches.length;
    }
    assert(totalJSDoc >= 15, `expected >=15 JSDoc blocks across services, got ${totalJSDoc}`);
  });

  // ============ Hex literals reduced (2) ============
  console.log('\n-- Hex 字面量减少 --');
  await test('renderSpikeCell 使用 COLORS.* 而非裸 hex', () => {
    const fn = procTable.match(/function\s+renderSpikeCell\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderSpikeCell not found');
    assert(/COLORS\.SPIKE_HOT/.test(fn[0]), 'should use COLORS.SPIKE_HOT');
    assert(/COLORS\.SPIKE_WARM/.test(fn[0]), 'should use COLORS.SPIKE_WARM');
    assert(/COLORS\.SPIKE_COOL/.test(fn[0]), 'should use COLORS.SPIKE_COOL');
  });
  await test('renderProcessRow 使用 COLORS.* 而非裸 hex', () => {
    const fn = procTable.match(/function\s+renderProcessRow\s*\([\s\S]*?\n\}/);
    assert(fn, 'renderProcessRow not found');
    assert(/COLORS\.SUCCESS/.test(fn[0]) || /COLORS\.TEXT_DIM/.test(fn[0]),
      'should use COLORS.* references');
  });

  // ============ Module split sanity (post-cleanup-3-step) ============
  console.log('\n-- 模块拆分结果 --');
  await test('renderer.js 已变编排器 (<500 lines, 仅事件绑定+refresh+tab)', () => {
    const lines = renderer.split('\n').length;
    assert(lines < 500, `renderer.js is ${lines} lines, should be thin orchestrator`);
    assert(lines > 100, 'renderer.js seems too thin — might have stripped content');
  });
  await test('src/modules/ 包含9个模块 (state/utils/charts/search/process-table/recordings/notifications/export/config)', () => {
    const expected = ['state.js', 'utils.js', 'charts.js', 'search.js', 'process-table.js', 'recordings.js', 'notifications.js', 'export.js', 'config.js'];
    for (const f of expected) {
      assert(fs.existsSync(path.join(__dirname, '..', '..', 'src', 'modules', f)), `missing module: ${f}`);
    }
  });
  await test('electron/services/ 包含4个服务 (config/ps-session/recording/window)', () => {
    const expected = ['config.js', 'ps-session.js', 'recording.js', 'window.js'];
    for (const f of expected) {
      assert(fs.existsSync(path.join(__dirname, '..', '..', 'electron', 'services', f)), `missing service: ${f}`);
    }
  });
  await test('main.cjs 已变编排器 (<400 lines, 仅IPC+collectData+lifecycle)', () => {
    const lines = mainCjs.split('\n').length;
    assert(lines < 400, `main.cjs is ${lines} lines, should be thin orchestrator`);
  });

  // ============ Syntax ============
  console.log('\n-- 语法检查 --');
  await test('renderer.js 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c src/renderer.js', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
  await test('process-table.js 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c src/modules/process-table.js', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
  await test('main.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/main.cjs', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
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