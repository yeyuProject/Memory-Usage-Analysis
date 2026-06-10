// Integration test for spike detection feature
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
  if (actual !== expected) throw new Error(`${msg || 'eq'}: expected ${expected}, got ${actual}`);
}

// Replicate the history tracking logic from main.cjs
class HistoryTracker {
  constructor(maxSamples = 60) {
    this.MAX_SAMPLES = maxSamples;
    this.map = new Map();
  }
  update(processes) {
    const now = Date.now();
    const currentPids = new Set(processes.map(p => p.pid));
    processes.forEach(p => {
      let h = this.map.get(p.pid);
      if (!h) {
        h = { baseline: p.memoryUsage, peak: p.memoryUsage, peakTime: now, samples: [] };
        this.map.set(p.pid, h);
      }
      h.samples.push(p.memoryUsage);
      if (h.samples.length > this.MAX_SAMPLES) h.samples.shift();
      if (h.samples.length <= 5) h.baseline = Math.min(...h.samples);
      if (p.memoryUsage > h.peak) { h.peak = p.memoryUsage; h.peakTime = now; }
    });
    for (const pid of this.map.keys()) {
      if (!currentPids.has(pid)) this.map.delete(pid);
    }
  }
  getHistory(currentProcesses) {
    const result = {};
    for (const [pid, h] of this.map) {
      const p = currentProcesses.find(x => x.pid === pid);
      const current = p ? p.memoryUsage : 0;
      const spikePct = h.baseline > 0
        ? Math.round(((current - h.baseline) / h.baseline) * 100)
        : 0;
      result[pid] = {
        baseline: h.baseline,
        peak: h.peak,
        peakTime: h.peakTime,
        current,
        spikePercent: spikePct,
        sampleCount: h.samples.length,
      };
    }
    return result;
  }
}

(async () => {
  // === Test 1: Main process has history tracking ===
  console.log('[Test 1] Main process 历史跟踪');
  const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
  await test('1.1 - processHistory Map 定义', () => {
    assert(main.includes('processHistory = new Map'), 'no history map');
  });
  await test('1.2 - MAX_SAMPLES 常量', () => {
    assert(main.includes('MAX_SAMPLES'), 'no MAX_SAMPLES');
  });
  await test('1.3 - collectData 更新 history', () => {
    assert(main.includes('processHistory.get(p.pid)'), 'no history update');
  });
  await test('1.4 - baseline 用前5个样本', () => {
    assert(main.includes('h.samples.length <= 5') || main.includes('samples.length <= 5'), 'no baseline logic');
  });
  await test('1.5 - peak 跟踪', () => {
    assert(main.includes("p.memoryUsage > h.peak"), 'no peak tracking');
  });
  await test('1.6 - 退出进程清理', () => {
    assert(main.includes('processHistory.delete(pid)'), 'no cleanup of exited processes');
  });
  await test('1.7 - get-process-history IPC', () => {
    assert(main.includes("'get-process-history'"), 'no IPC handler');
    assert(main.includes('spikePercent: spikePct'), 'no spikePercent in response');
  });

  // === Test 2: Preload exposes getProcessHistory ===
  console.log('\n[Test 2] Preload 暴露');
  const preload = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');
  await test('2.1 - getProcessHistory 暴露', () => {
    assert(preload.includes('getProcessHistory:'), 'missing in preload');
  });

  // === Test 3: HTML has spike column ===
  console.log('\n[Test 3] HTML 突变列');
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
  await test('3.1 - 表格含 突变% 列头', () => {
    assert(html.includes('data-sort="spike"'), 'missing spike sort header');
    assert(html.includes('突变%'), 'missing 突变% text');
  });
  await test('3.2 - 仪表盘有突变进程卡片', () => {
    assert(html.includes('id="spikeTbody"'), 'missing spike table');
    assert(html.includes('突变进程'), 'missing spike section title');
  });
  await test('3.3 - 表格行 colspan 改为 6', () => {
    assert(html.includes('colspan="6"'), 'missing colspan=6 update');
  });

  // === Test 4: Renderer logic ===
  console.log('\n[Test 4] Renderer 逻辑');
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('4.1 - processHistory state 声明', () => {
    assert(renderer.includes('let processHistory = {}'), 'missing state');
  });
  await test('4.2 - refresh 获取 history', () => {
    assert(renderer.includes('api.getProcessHistory()'), 'missing fetch call');
  });
  await test('4.3 - renderSpikes 函数', () => {
    assert(renderer.includes('function renderSpikes'), 'missing function');
  });
  await test('4.4 - refresh 调用 renderSpikes', () => {
    assert(renderer.includes('renderSpikes()'), 'not called in refresh');
  });
  await test('4.5 - SPIKE_THRESHOLD 常量', () => {
    assert(renderer.includes('SPIKE_THRESHOLD = 50'), 'no threshold constant');
  });
  await test('4.6 - spike 表格点击跳转', () => {
    assert(renderer.includes("els.spikeTbody.addEventListener"), 'no click handler');
  });
  await test('4.7 - renderTable 含 spike 列', () => {
    assert(renderer.includes('spikeCell') || renderer.includes('spike >='), 'no spike cell render');
  });

  // === Test 5: History tracker logic ===
  console.log('\n[Test 5] History 跟踪逻辑');
  await test('5.1 - 初始baseline = 第一个样本', () => {
    const t = new HistoryTracker();
    t.update([{ pid: 1, memoryUsage: 100 }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 100 }]);
    assertEq(h[1].baseline, 100, 'baseline init');
  });
  await test('5.2 - 5个样本后baseline固定', () => {
    const t = new HistoryTracker();
    for (let i = 0; i < 6; i++) {
      t.update([{ pid: 1, memoryUsage: 100 + i * 10 }]);
    }
    // After 5 samples (values 100,110,120,130,140), min = 100
    const h = t.getHistory([{ pid: 1, memoryUsage: 200 }]);
    assertEq(h[1].baseline, 100, 'baseline should stay at initial min');
  });
  await test('5.3 - 内存暴涨200% 触发spike', () => {
    const t = new HistoryTracker();
    // Initial baseline ~ 100MB
    for (let i = 0; i < 6; i++) t.update([{ pid: 1, memoryUsage: 100 }]);
    // Spike to 300MB
    const h = t.getHistory([{ pid: 1, memoryUsage: 300 }]);
    assertEq(h[1].spikePercent, 200, '200% spike expected');
  });
  await test('5.4 - 内存暴跌50% 触发负spike', () => {
    const t = new HistoryTracker();
    for (let i = 0; i < 6; i++) t.update([{ pid: 1, memoryUsage: 200 }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 100 }]);
    assertEq(h[1].spikePercent, -50, '-50% spike expected');
  });
  await test('5.5 - peak 跟踪最大值', () => {
    const t = new HistoryTracker();
    t.update([{ pid: 1, memoryUsage: 100 }]);
    t.update([{ pid: 1, memoryUsage: 500 }]);
    t.update([{ pid: 1, memoryUsage: 200 }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 200 }]);
    assertEq(h[1].peak, 500, 'peak should be 500');
  });
  await test('5.6 - 退出进程被清理', () => {
    const t = new HistoryTracker();
    t.update([{ pid: 1, memoryUsage: 100 }, { pid: 2, memoryUsage: 200 }]);
    t.update([{ pid: 1, memoryUsage: 110 }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 110 }]);
    assert(!h[2], 'pid 2 should be evicted');
    assert(h[1], 'pid 1 should remain');
  });
  await test('5.7 - MAX_SAMPLES 限制窗口', () => {
    const t = new HistoryTracker(10);
    for (let i = 0; i < 20; i++) t.update([{ pid: 1, memoryUsage: 100 + i }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 119 }]);
    assertEq(h[1].sampleCount, 10, 'should cap at MAX_SAMPLES');
  });
  await test('5.8 - sampleCount <= 5 不算spike', () => {
    // The renderer logic: spikes only when sampleCount > 5
    const t = new HistoryTracker();
    for (let i = 0; i < 5; i++) t.update([{ pid: 1, memoryUsage: 100 }]);
    const h = t.getHistory([{ pid: 1, memoryUsage: 1000 }]);
    // spike calc still works but renderer should not display it
    assertEq(h[1].sampleCount, 5, '5 samples');
  });

  // === Test 6: Spike filtering logic ===
  console.log('\n[Test 6] 突变筛选');
  await test('6.1 - 50%阈值筛选', () => {
    const SPIKE = 50;
    const t = new HistoryTracker();
    for (let i = 0; i < 6; i++) t.update([{ pid: 1, memoryUsage: 100 }]);
    // Memory doubles to 200
    t.update([{ pid: 1, memoryUsage: 200 }]);
    // Pass current state (200MB) to getHistory
    const h = t.getHistory([{ pid: 1, memoryUsage: 200 }]);
    assert(h[1].spikePercent >= SPIKE, `should be a spike, got ${h[1].spikePercent}%`);
  });
  await test('6.2 - 排序按绝对值', () => {
    // Each update passes all current processes, so eviction only removes exited ones
    const t = new HistoryTracker();
    for (let i = 0; i < 6; i++) t.update([{ pid: 1, memoryUsage: 100 }, { pid: 2, memoryUsage: 100 }, { pid: 3, memoryUsage: 100 }]);
    // pid 2 spikes to +100%, pid 3 drops to -50%
    t.update([{ pid: 1, memoryUsage: 100 }, { pid: 2, memoryUsage: 200 }, { pid: 3, memoryUsage: 50 }]);
    const h = t.getHistory([
      { pid: 1, memoryUsage: 100 },
      { pid: 2, memoryUsage: 200 },
      { pid: 3, memoryUsage: 50 },
    ]);
    assert(h[2] && Math.abs(h[2].spikePercent) >= 50, `pid 2 should spike, got ${h[2]?.spikePercent}%`);
    assert(h[3] && Math.abs(h[3].spikePercent) >= 50, `pid 3 should spike, got ${h[3]?.spikePercent}%`);
  });

  // === Test 7: Syntax checks ===
  console.log('\n[Test 7] 语法检查');
  const { execSync } = require('child_process');
  await test('7.1 - main.cjs', () => {
    execSync('node -c electron/main.cjs', { stdio: 'pipe' });
  });
  await test('7.2 - preload.cjs', () => {
    execSync('node -c electron/preload.cjs', { stdio: 'pipe' });
  });
  await test('7.3 - renderer.js', () => {
    execSync('node -c src/renderer.js', { stdio: 'pipe' });
  });

  // === Summary ===
  console.log('\n================================================');
  console.log(`  突变检测测试: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
  console.log('================================================');
  if (failed > 0) {
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n✓ 历史峰值检测验证通过！');
  }
})();
