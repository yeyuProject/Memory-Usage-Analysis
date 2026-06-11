// Integration test for memory leak detection feature
const fs = require('fs');
const path = require('path');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// Replicate computeLeakPercent from electron/main.cjs (verbatim)
function computeLeakPercent(samples) {
  if (!samples || samples.length < 5) return 0;
  const n = samples.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += samples[i];
    sumXY += i * samples[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const mean = sumY / n;
  if (mean === 0) return 0;
  return Math.round((slope / mean) * 60 * 100);
}

// Replicate the threshold constant from src/renderer.js
const LEAK_THRESHOLD = 30;

(async () => {
  console.log('\n=== 内存泄漏检测测试 ===\n');

  // ============ Algorithm correctness (8 cases) ============
  console.log('-- 算法核心 --');
  await test('空数组返回 0', () => {
    assertEq(computeLeakPercent([]), 0);
  });
  await test('少于5个样本返回 0', () => {
    assertEq(computeLeakPercent([100, 101, 102]), 0);
    assertEq(computeLeakPercent([100, 101, 102, 103, 104].slice(0, 4)), 0);
  });
  await test('恒定值返回 0 (无斜率)', () => {
    const flat = Array(20).fill(100);
    assertEq(computeLeakPercent(flat), 0);
  });
  await test('全 0 返回 0 (除零保护)', () => {
    const zeros = Array(20).fill(0);
    assertEq(computeLeakPercent(zeros), 0);
  });
  await test('持续线性增长 → 高正值 (检测为泄漏)', () => {
    // 60 samples from 100MB to 200MB = clear leak
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(100 + i * 5); // 100,105,110,...,395
    const pct = computeLeakPercent(samples);
    assert(pct >= LEAK_THRESHOLD, `expected leak pct >= ${LEAK_THRESHOLD}, got ${pct}`);
    assert(pct <= 200, `should not exceed 200, got ${pct}`);
  });
  await test('缓慢增长但稳定 → 仍可检测', () => {
    // 60 samples from 100MB to 130MB = slow leak
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(100 + i * 0.5);
    const pct = computeLeakPercent(samples);
    assert(pct >= 10, `expected leak pct >= 10, got ${pct}`);
    assert(pct <= 100, `slow leak should be < 100, got ${pct}`);
  });
  await test('震荡数据 → 接近 0 (不是泄漏)', () => {
    // Oscillating around 100
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(100 + (i % 2 === 0 ? 5 : -5));
    const pct = computeLeakPercent(samples);
    assert(Math.abs(pct) < 10, `oscillating should be near 0, got ${pct}`);
  });
  await test('持续下降 → 负值 (内存释放)', () => {
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(200 - i * 2);
    const pct = computeLeakPercent(samples);
    assert(pct < 0, `expected negative, got ${pct}`);
    assert(pct <= -20, `clear release should be <= -20, got ${pct}`);
  });

  // ============ Threshold logic (5 cases) ============
  console.log('\n-- 阈值判定 --');
  await test('leakPercent = 29 < 30 不算泄漏', () => {
    // Construct samples that yield ~29%
    // slope/mean * 60 * 100 = 29 → slope = 29*mean/(60*100)
    const mean = 100, slope = 29 * 100 / (60 * 100);
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(mean - slope * 30 + slope * i);
    const pct = computeLeakPercent(samples);
    assert(pct < LEAK_THRESHOLD, `expected < ${LEAK_THRESHOLD}, got ${pct}`);
  });
  await test('leakPercent = 50 >= 30 是泄漏', () => {
    const mean = 100, slope = 50 * 100 / (60 * 100);
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(mean - slope * 30 + slope * i);
    const pct = computeLeakPercent(samples);
    assert(pct >= LEAK_THRESHOLD, `expected >= ${LEAK_THRESHOLD}, got ${pct}`);
  });
  await test('波动 ±20% 不会误判为泄漏', () => {
    // Random-ish but bounded noise
    const samples = [100, 110, 95, 105, 90, 115, 100, 105, 95, 100, 110, 95,
                     105, 100, 110, 95, 105, 100, 110, 95, 105, 100, 110, 95,
                     105, 100, 110, 95, 105, 100];
    const pct = computeLeakPercent(samples);
    assert(Math.abs(pct) < LEAK_THRESHOLD, `noise should be < threshold, got ${pct}`);
  });
  await test('小样本(5)刚好够', () => {
    const samples = [100, 110, 120, 130, 140];
    const pct = computeLeakPercent(samples);
    assert(pct > 0, `growing samples should yield positive, got ${pct}`);
  });
  await test('4样本不够 → 强制 0', () => {
    const samples = [100, 200, 300, 400]; // would be huge leak but <5 samples
    const pct = computeLeakPercent(samples);
    assertEq(pct, 0);
  });

  // ============ HTML structure (3 cases) ============
  console.log('\n-- HTML 结构 --');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
  await test('HTML 包含 leakTbody', () => {
    assert(html.includes('id="leakTbody"'), 'missing leakTbody id');
  });
  await test('HTML 包含"疑似内存泄漏"卡片标题', () => {
    assert(html.includes('疑似内存泄漏'), 'missing leak card title');
  });
  await test('HTML 提示阈值说明', () => {
    // Threshold is now in a span that's populated from config; verify hint structure
    assert(html.includes('leakThresholdHint'), 'missing threshold hint span');
  });

  // ============ Renderer code (4 cases) ============
  console.log('\n-- 渲染器代码 --');
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 renderLeaks 函数', () => {
    assert(/function\s+renderLeaks\s*\(/.test(renderer), 'renderLeaks not defined');
  });
  await test('renderer 调用了 computeLeakPercent 的结果字段 leakPercent', () => {
    assert(/leakPercent/.test(renderer), 'leakPercent not referenced');
  });
  await test('renderer 在 refresh() 中调用 renderLeaks', () => {
    // Find refresh() body and check it contains renderLeaks
    assert(/refresh[\s\S]*?renderLeaks\s*\(\)/.test(renderer), 'renderLeaks not called in refresh');
  });
  await test('renderer leakTbody 点击跳转', () => {
    assert(/leakTbody\.addEventListener/.test(renderer), 'leakTbody click handler missing');
  });

  // ============ Main process IPC (3 cases) ============
  console.log('\n-- 主进程 IPC --');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.cjs'), 'utf8');
  await test('main.cjs 包含 computeLeakPercent 函数', () => {
    assert(/function\s+computeLeakPercent\s*\(/.test(main), 'computeLeakPercent not in main.cjs');
  });
  await test('get-process-history 返回 leakPercent 字段', () => {
    // Look at the IPC handler body for leakPercent
    const handlerBlock = main.match(/ipcMain\.handle\(['"]get-process-history['"][\s\S]*?\}\);/);
    assert(handlerBlock, 'get-process-history handler not found');
    assert(/leakPercent/.test(handlerBlock[0]), 'leakPercent missing from response');
  });
  await test('computeLeakPercent 使用最小二乘法', () => {
    // Verify the algorithm shape
    const fnBody = main.match(/function\s+computeLeakPercent[\s\S]*?\n\}/);
    assert(fnBody, 'function body not found');
    assert(/sumXX/.test(fnBody[0]) && /sumXY/.test(fnBody[0]), 'least-squares not implemented');
    assert(/denom/.test(fnBody[0]), 'denom calculation missing');
  });

  // ============ Syntax (3 cases) ============
  console.log('\n-- 语法检查 --');
  await test('main.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/main.cjs', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
  await test('renderer.js 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c src/renderer.js', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
  await test('preload.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/preload.cjs', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
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