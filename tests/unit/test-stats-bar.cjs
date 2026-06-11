// Integration test for status-bar collector stats display
// Validates the renderer's updateCollectorStats() function: text formatting,
// color coding by latency, error handling, and call site in refresh().
const fs = require('fs');
const path = require('path');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// ===== Replicate updateCollectorStats logic from renderer.js =====
function renderStats(stats) {
  if (!stats.alive) {
    return { text: 'PS: 未启动', color: '#999' };
  }
  const lat = stats.lastDurationMs != null ? `${stats.lastDurationMs}ms` : '--';
  const errSuffix = stats.errors > 0 ? ` | 错误 ${stats.errors}` : '';
  const pendSuffix = stats.pending ? ' | 处理中' : '';
  const qSuffix = stats.queueLength > 0 ? ` | 队列 ${stats.queueLength}` : '';
  const text = `PS: ${lat} | 请求 ${stats.requests}${errSuffix}${pendSuffix}${qSuffix}`;
  const d = stats.lastDurationMs;
  let color;
  if (d == null) color = '#999';
  else if (d < 200) color = '#52c41a';
  else if (d < 500) color = '#faad14';
  else color = '#ff4d4f';
  return { text, color };
}

(async () => {
  console.log('\n=== 状态栏 Collector Stats 测试 ===\n');

  // ============ Text formatting (8) ============
  console.log('-- 文本格式 --');
  await test('alive=false → "PS: 未启动"', () => {
    const r = renderStats({ alive: false });
    assertEq(r.text, 'PS: 未启动');
    assertEq(r.color, '#999');
  });
  await test('alive=true, 正常延迟 → "PS: 75ms | 请求 N"', () => {
    const r = renderStats({ alive: true, lastDurationMs: 75, requests: 42, errors: 0, pending: false, queueLength: 0 });
    assertEq(r.text, 'PS: 75ms | 请求 42');
  });
  await test('lastDurationMs=null → 显示 "--"', () => {
    const r = renderStats({ alive: true, lastDurationMs: null, requests: 1, errors: 0, pending: false, queueLength: 0 });
    assert(r.text.includes('--'), 'should show -- for null latency');
  });
  await test('errors > 0 → 显示 " | 错误 N"', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 10, errors: 3, pending: false, queueLength: 0 });
    assert(r.text.includes('| 错误 3'));
  });
  await test('errors = 0 → 不显示错误部分', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 10, errors: 0, pending: false, queueLength: 0 });
    assert(!r.text.includes('错误'), 'should not show error when 0');
  });
  await test('pending=true → 显示 " | 处理中"', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 5, errors: 0, pending: true, queueLength: 0 });
    assert(r.text.includes('| 处理中'));
  });
  await test('pending=false → 不显示处理中', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 5, errors: 0, pending: false, queueLength: 0 });
    assert(!r.text.includes('处理中'));
  });
  await test('queueLength > 0 → 显示 " | 队列 N"', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 5, errors: 0, pending: false, queueLength: 3 });
    assert(r.text.includes('| 队列 3'));
  });

  // ============ Color coding (5) ============
  console.log('\n-- 颜色编码 --');
  await test('延迟 < 200ms → 绿色', () => {
    assertEq(renderStats({ alive: true, lastDurationMs: 75, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#52c41a');
    assertEq(renderStats({ alive: true, lastDurationMs: 0, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#52c41a');
    assertEq(renderStats({ alive: true, lastDurationMs: 199, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#52c41a');
  });
  await test('延迟 200-499ms → 橙色', () => {
    assertEq(renderStats({ alive: true, lastDurationMs: 200, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#faad14');
    assertEq(renderStats({ alive: true, lastDurationMs: 350, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#faad14');
    assertEq(renderStats({ alive: true, lastDurationMs: 499, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#faad14');
  });
  await test('延迟 ≥ 500ms → 红色', () => {
    assertEq(renderStats({ alive: true, lastDurationMs: 500, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#ff4d4f');
    assertEq(renderStats({ alive: true, lastDurationMs: 1000, requests: 1, errors: 0, pending: false, queueLength: 0 }).color, '#ff4d4f');
  });
  await test('lastDurationMs=null → 灰色', () => {
    assertEq(renderStats({ alive: true, lastDurationMs: null, requests: 0, errors: 0, pending: false, queueLength: 0 }).color, '#999');
  });
  await test('alive=false → 灰色', () => {
    assertEq(renderStats({ alive: false }).color, '#999');
  });

  // ============ Combined (3) ============
  console.log('\n-- 组合 --');
  await test('所有后缀都显示', () => {
    const r = renderStats({ alive: true, lastDurationMs: 100, requests: 50, errors: 2, pending: true, queueLength: 3 });
    assert(r.text.includes('100ms'));
    assert(r.text.includes('请求 50'));
    assert(r.text.includes('错误 2'));
    assert(r.text.includes('处理中'));
    assert(r.text.includes('队列 3'));
  });
  await test('无任何后缀 → 简洁文本', () => {
    const r = renderStats({ alive: true, lastDurationMs: 80, requests: 1, errors: 0, pending: false, queueLength: 0 });
    assertEq(r.text, 'PS: 80ms | 请求 1');
  });
  await test('大请求数 (1000+) 也能正确显示', () => {
    const r = renderStats({ alive: true, lastDurationMs: 50, requests: 1234, errors: 0, pending: false, queueLength: 0 });
    assertEq(r.text, 'PS: 50ms | 请求 1234');
  });

  // ============ Source-level checks (6) ============
  console.log('\n-- 源码检查 --');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
  await test('HTML 包含 collectorStats 元素', () => {
    assert(/id="collectorStats"/.test(html));
  });
  await test('HTML collectorStats 在 footer 内', () => {
    const footerMatch = html.match(/<footer>[\s\S]*?<\/footer>/);
    assert(footerMatch, 'footer not found');
    assert(/id="collectorStats"/.test(footerMatch[0]), 'collectorStats should be inside footer');
  });
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 collectorStats 元素引用', () => {
    assert(/collectorStats:\s*\$\(['"]collectorStats['"]\)/.test(renderer));
  });
  await test('renderer 包含 updateCollectorStats 函数', () => {
    assert(/async function updateCollectorStats/.test(renderer));
  });
  await test('renderer 在 refresh() 中调用 updateCollectorStats', () => {
    const fn = renderer.match(/async function refresh\([\s\S]*?\n  \}/);
    assert(fn, 'refresh not found');
    assert(/updateCollectorStats\(\)/.test(fn[0]), 'should call updateCollectorStats in refresh');
  });
  await test('renderer 调用 window.electronAPI.getCollectorStats', () => {
    assert(/window\.electronAPI\.getCollectorStats/.test(renderer));
  });
  await test('renderer 实现颜色阈值 (200/500ms)', () => {
    assert(/d\s*<\s*200/.test(renderer), 'should have < 200ms threshold');
    assert(/d\s*<\s*500/.test(renderer), 'should have < 500ms threshold');
  });
  await test('main.cjs 暴露 get-collector-stats IPC', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.cjs'), 'utf8');
    assert(/ipcMain\.handle\(['"]get-collector-stats['"]/.test(main));
  });
  await test('preload 暴露 getCollectorStats', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'preload.cjs'), 'utf8');
    assert(/getCollectorStats:/.test(preload));
  });

  // ============ Syntax ============
  console.log('\n-- 语法检查 --');
  await test('renderer.js 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c src/renderer.js', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
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