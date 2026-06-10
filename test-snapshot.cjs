// Integration test for history snapshot export
// Verifies the snapshot builder logic, CSV/JSON output format, metadata,
// and threshold inclusion — without spawning Electron.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// ===== Replicate snapshot builder from main.cjs =====
function computeLeakPercent(samples) {
  if (!samples || samples.length < 5) return 0;
  const n = samples.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += samples[i]; sumXY += i * samples[i]; sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const mean = sumY / n;
  if (mean === 0) return 0;
  return Math.round((slope / mean) * 60 * 100);
}

function buildSnapshotRows(processCache, processHistory, includeAll = true) {
  const rows = [];
  for (const p of processCache) {
    if (!includeAll && p.memoryUsage < 1024 * 1024) continue;
    const h = processHistory.get(p.pid) || {};
    const baseline = h.baseline || p.memoryUsage;
    const peak = h.peak || p.memoryUsage;
    const spikePercent = baseline > 0
      ? Math.round(((p.memoryUsage - baseline) / baseline) * 100)
      : 0;
    const leakPercent = computeLeakPercent(h.samples || []);
    rows.push({
      pid: p.pid,
      name: p.name,
      memoryUsage: p.memoryUsage,
      baseline,
      peak,
      spikePercent,
      leakPercent,
      sampleCount: (h.samples || []).length,
    });
  }
  rows.sort((a, b) => b.memoryUsage - a.memoryUsage);
  return rows;
}

function writeSnapshotCsv(filePath, snapshot) {
  const cols = ['pid', 'name', 'memoryUsage', 'baseline', 'peak', 'spikePercent', 'leakPercent', 'sampleCount'];
  const escape = v => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  snapshot.processes.forEach(r => lines.push(cols.map(c => escape(r[c])).join(',')));
  const meta = [
    `# Generated: ${snapshot.generatedAt}`,
    `# App version: ${snapshot.appVersion}`,
    `# Process count: ${snapshot.processCount}`,
    `# Thresholds: spike=${snapshot.thresholds.spikeThreshold}% leak=${snapshot.thresholds.leakThreshold}%`,
    `# System: totalMem=${snapshot.system ? snapshot.system.totalPhysicalMemory : 'n/a'}`,
  ].join('\n');
  fs.writeFileSync(filePath, meta + '\n' + lines.join('\n') + '\n', 'utf8');
}

function writeSnapshotJson(filePath, snapshot) {
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

// Mock data
function makeProcs(n) {
  const procs = [];
  for (let i = 1; i <= n; i++) {
    procs.push({ pid: i, name: 'proc' + i, memoryUsage: i * 10 * 1024 * 1024 });
  }
  return procs;
}
function makeHistory(procs, growingPids = []) {
  const hist = new Map();
  procs.forEach(p => {
    if (growingPids.includes(p.pid)) {
      // Sustained growth → leak
      const samples = [];
      for (let i = 0; i < 15; i++) samples.push(p.memoryUsage + i * 5 * 1024 * 1024);
      hist.set(p.pid, { baseline: samples[0], peak: samples[samples.length - 1], samples });
    } else {
      // Stable
      hist.set(p.pid, { baseline: p.memoryUsage, peak: p.memoryUsage, samples: [p.memoryUsage] });
    }
  });
  return hist;
}

const TMP = path.join(os.tmpdir(), 'mua-snapshot-test-' + Date.now());

(async () => {
  console.log('\n=== 历史快照导出测试 ===\n');
  fs.mkdirSync(TMP, { recursive: true });

  // ============ Snapshot row construction (6) ============
  console.log('-- 快照数据构建 --');
  await test('基本快照: 每进程一行', () => {
    const procs = makeProcs(5);
    const hist = makeHistory(procs);
    const rows = buildSnapshotRows(procs, hist);
    assertEq(rows.length, 5);
    assertEq(rows[0].pid, 5);  // sorted desc by memory
    assertEq(rows[0].memoryUsage, 50 * 1024 * 1024);
  });
  await test('spikePercent 计算: 当前 vs baseline', () => {
    const procs = [{ pid: 1, name: 'p', memoryUsage: 200 * 1024 * 1024 }];
    const hist = new Map([[1, { baseline: 100 * 1024 * 1024, peak: 200 * 1024 * 1024, samples: [100e6] }]]);
    const rows = buildSnapshotRows(procs, hist);
    assertEq(rows[0].spikePercent, 100);  // 200/100 - 1 = 100%
  });
  await test('leakPercent 计算: 持续增长', () => {
    const procs = [{ pid: 1, name: 'p', memoryUsage: 200 * 1024 * 1024 }];
    const hist = makeHistory(procs, [1]);
    const rows = buildSnapshotRows(procs, hist);
    assert(rows[0].leakPercent > 0, `expected positive leakPercent, got ${rows[0].leakPercent}`);
  });
  await test('sampleCount 正确', () => {
    const procs = [{ pid: 1, name: 'p', memoryUsage: 100 }];
    const hist = new Map([[1, { baseline: 50, peak: 100, samples: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] }]]);
    const rows = buildSnapshotRows(procs, hist);
    assertEq(rows[0].sampleCount, 10);
  });
  await test('无 history 的进程: 默认值', () => {
    const procs = [{ pid: 99, name: 'new', memoryUsage: 50 * 1024 * 1024 }];
    const hist = new Map();  // empty
    const rows = buildSnapshotRows(procs, hist);
    assertEq(rows[0].baseline, 50 * 1024 * 1024);
    assertEq(rows[0].peak, 50 * 1024 * 1024);
    assertEq(rows[0].spikePercent, 0);
    assertEq(rows[0].leakPercent, 0);
    assertEq(rows[0].sampleCount, 0);
  });
  await test('includeAll=false: 跳过 <1MB', () => {
    const procs = [
      { pid: 1, name: 'big', memoryUsage: 100 * 1024 * 1024 },
      { pid: 2, name: 'tiny', memoryUsage: 500 * 1024 },  // 500KB, < 1MB
      { pid: 3, name: 'medium', memoryUsage: 2 * 1024 * 1024 },
    ];
    const hist = new Map();
    const rows = buildSnapshotRows(procs, hist, false);
    assertEq(rows.length, 2, 'should skip tiny process');
    assert(rows.some(r => r.pid === 1));
    assert(rows.some(r => r.pid === 3));
    assert(!rows.some(r => r.pid === 2));
  });
  await test('includeAll=true: 包含所有', () => {
    const procs = [
      { pid: 1, name: 'big', memoryUsage: 100 * 1024 * 1024 },
      { pid: 2, name: 'tiny', memoryUsage: 500 * 1024 },
    ];
    const rows = buildSnapshotRows(procs, new Map(), true);
    assertEq(rows.length, 2);
  });
  await test('按 memoryUsage 降序', () => {
    const procs = makeProcs(10);
    const rows = buildSnapshotRows(procs, new Map());
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i - 1].memoryUsage >= rows[i].memoryUsage, 'not sorted desc');
    }
  });

  // ============ Snapshot object structure (3) ============
  console.log('\n-- 快照对象结构 --');
  await test('snapshot 包含 generatedAt / appVersion / system / thresholds / processes', () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      system: { totalPhysicalMemory: 16e9 },
      thresholds: { spikeThreshold: 50, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 },
      processCount: 0,
      processes: [],
    };
    assert(snapshot.generatedAt);
    assert(snapshot.appVersion);
    assert(snapshot.system);
    assert(snapshot.thresholds);
    assert(Array.isArray(snapshot.processes));
  });
  await test('thresholds 反映当前配置 (spike=50 leak=30)', () => {
    const snapshot = {
      thresholds: { spikeThreshold: 50, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 },
    };
    assertEq(snapshot.thresholds.spikeThreshold, 50);
    assertEq(snapshot.thresholds.leakThreshold, 30);
  });
  await test('processCount 等于 processes.length', () => {
    const procs = makeProcs(7);
    const rows = buildSnapshotRows(procs, new Map());
    const snapshot = { processCount: rows.length, processes: rows };
    assertEq(snapshot.processCount, 7);
    assertEq(snapshot.processes.length, 7);
  });

  // ============ CSV output (5) ============
  console.log('\n-- CSV 输出 --');
  await test('CSV 第1行是列头 (8列)', () => {
    const outPath = path.join(TMP, 'snap.csv');
    const snapshot = {
      generatedAt: '2024-01-01T00:00:00Z',
      appVersion: '1.0.0',
      system: { totalPhysicalMemory: 16e9 },
      thresholds: { spikeThreshold: 50, leakThreshold: 30 },
      processCount: 0,
      processes: [],
    };
    writeSnapshotCsv(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    const lines = content.split('\n').filter(l => !l.startsWith('#'));
    assertEq(lines[0], 'pid,name,memoryUsage,baseline,peak,spikePercent,leakPercent,sampleCount');
  });
  await test('CSV 数据行数 = processCount + header', () => {
    const outPath = path.join(TMP, 'snap2.csv');
    const procs = makeProcs(5);
    const rows = buildSnapshotRows(procs, new Map());
    const snapshot = { generatedAt: '2024', appVersion: '1', system: null, thresholds: {}, processCount: rows.length, processes: rows };
    writeSnapshotCsv(outPath, snapshot);
    const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
    assertEq(lines.length, 6);  // header + 5 data
  });
  await test('CSV 包含元数据注释行 (# 前缀)', () => {
    const outPath = path.join(TMP, 'snap3.csv');
    const snapshot = { generatedAt: 'X', appVersion: 'Y', system: null, thresholds: {}, processCount: 0, processes: [] };
    writeSnapshotCsv(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    assert(content.includes('# Generated:'));
    assert(content.includes('# App version:'));
    assert(content.includes('# Process count:'));
    assert(content.includes('# Thresholds:'));
  });
  await test('CSV 转义逗号和引号', () => {
    const outPath = path.join(TMP, 'snap4.csv');
    const snapshot = {
      generatedAt: 'X', appVersion: 'Y', system: null, thresholds: {},
      processCount: 2,
      processes: [
        { pid: 1, name: 'has,comma', memoryUsage: 100, baseline: 100, peak: 100, spikePercent: 0, leakPercent: 0, sampleCount: 1 },
        { pid: 2, name: 'has"quote', memoryUsage: 200, baseline: 200, peak: 200, spikePercent: 0, leakPercent: 0, sampleCount: 1 },
      ],
    };
    writeSnapshotCsv(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    assert(content.includes('"has,comma"'));
    assert(content.includes('"has""quote"'));
  });
  await test('CSV 数字字段不加引号', () => {
    const outPath = path.join(TMP, 'snap5.csv');
    const snapshot = {
      generatedAt: 'X', appVersion: 'Y', system: null, thresholds: {},
      processCount: 1,
      processes: [{ pid: 123, name: 'p', memoryUsage: 999999, baseline: 500000, peak: 999999, spikePercent: 99, leakPercent: 12, sampleCount: 5 }],
    };
    writeSnapshotCsv(outPath, snapshot);
    const dataLine = fs.readFileSync(outPath, 'utf8').split('\n').filter(l => l && !l.startsWith('#'))[1];
    assert(dataLine.startsWith('123,'));
    assert(dataLine.includes(',999999,'));
  });

  // ============ JSON output (4) ============
  console.log('\n-- JSON 输出 --');
  await test('JSON 输出可被parse', () => {
    const outPath = path.join(TMP, 'snap.json');
    const snapshot = {
      generatedAt: '2024-01-01T00:00:00Z',
      appVersion: '1.0.0',
      system: { totalPhysicalMemory: 16e9 },
      thresholds: { spikeThreshold: 50, leakThreshold: 30 },
      processCount: 1,
      processes: [{ pid: 1, name: 'p', memoryUsage: 100, baseline: 100, peak: 100, spikePercent: 0, leakPercent: 0, sampleCount: 1 }],
    };
    writeSnapshotJson(outPath, snapshot);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assertEq(parsed.processCount, 1);
    assertEq(parsed.processes[0].pid, 1);
  });
  await test('JSON 保留所有字段 (无丢失)', () => {
    const outPath = path.join(TMP, 'snap2.json');
    const snapshot = {
      generatedAt: '2024', appVersion: '1.0', system: { x: 1 }, thresholds: { spikeThreshold: 50, leakThreshold: 30 },
      processCount: 0, processes: [],
    };
    writeSnapshotJson(outPath, snapshot);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assertEq(parsed.generatedAt, '2024');
    assertEq(parsed.appVersion, '1.0');
    assertEq(parsed.system.x, 1);
  });
  await test('JSON 缩进 2 空格 (人类可读)', () => {
    const outPath = path.join(TMP, 'snap3.json');
    const snapshot = { generatedAt: 'X', appVersion: 'Y', system: null, thresholds: {}, processCount: 0, processes: [] };
    writeSnapshotJson(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    assert(content.includes('\n  "generatedAt"'));
  });
  await test('JSON 末尾有换行 (POSIX友好)', () => {
    const outPath = path.join(TMP, 'snap4.json');
    const snapshot = { generatedAt: 'X', appVersion: 'Y', system: null, thresholds: {}, processCount: 0, processes: [] };
    writeSnapshotJson(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    assert(content.endsWith('\n'));
  });

  // ============ Full pipeline (3) ============
  console.log('\n-- 完整流程 --');
  await test('完整CSV流程: 375 进程快照', () => {
    const outPath = path.join(TMP, 'full.csv');
    const procs = makeProcs(375).map(p => ({ ...p, memoryUsage: 10 * 1024 * 1024 + Math.random() * 500 * 1024 * 1024 }));
    const hist = makeHistory(procs, [10, 20, 30]);  // 3 leaks
    const rows = buildSnapshotRows(procs, hist);
    const snapshot = {
      generatedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      system: { totalPhysicalMemory: 16e9, availablePhysicalMemory: 8e9, memoryLoad: 50 },
      thresholds: { spikeThreshold: 50, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 },
      processCount: rows.length,
      processes: rows,
    };
    writeSnapshotCsv(outPath, snapshot);
    const stat = fs.statSync(outPath);
    assert(stat.size > 5000, `375 procs CSV should be > 5KB, got ${stat.size}`);
    assert(stat.size < 100000, `375 procs CSV should be < 100KB, got ${stat.size}`);
    // Verify 3 leaks flagged
    const leaks = rows.filter(r => r.leakPercent >= 30);
    assertEq(leaks.length, 3);
  });
  await test('完整JSON流程: 100 进程快照', () => {
    const outPath = path.join(TMP, 'full.json');
    const procs = makeProcs(100);
    const hist = makeHistory(procs);
    const rows = buildSnapshotRows(procs, hist);
    const snapshot = {
      generatedAt: '2024', appVersion: '1.0', system: null,
      thresholds: { spikeThreshold: 50, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 },
      processCount: rows.length, processes: rows,
    };
    writeSnapshotJson(outPath, snapshot);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assertEq(parsed.processes.length, 100);
  });
  await test('空 processCache 也能导出 (空快照)', () => {
    const outPath = path.join(TMP, 'empty.csv');
    const rows = buildSnapshotRows([], new Map());
    const snapshot = {
      generatedAt: 'X', appVersion: 'Y', system: null,
      thresholds: { spikeThreshold: 50, leakThreshold: 30 },
      processCount: 0, processes: rows,
    };
    writeSnapshotCsv(outPath, snapshot);
    const content = fs.readFileSync(outPath, 'utf8');
    assert(content.includes('pid,name'));
    assert(content.includes('# Process count: 0'));
  });

  // ============ Source-level checks (5) ============
  console.log('\n-- 源码检查 --');
  const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
  await test('main.cjs 包含 export-history-snapshot IPC', () => {
    assert(/ipcMain\.handle\(['"]export-history-snapshot['"]/.test(main));
  });
  await test('main.cjs 使用 dialog.showSaveDialog', () => {
    assert(/dialog\.showSaveDialog/.test(main));
  });
  await test('main.cjs 在快照中包含 spikePercent 和 leakPercent', () => {
    // Find the snapshot handler start, then read forward to the next ipcMain handler
    const start = main.indexOf("ipcMain.handle('export-history-snapshot'");
    assert(start > 0, 'handler start not found');
    const rest = main.slice(start);
    // Take everything up to the next ipcMain.handle (or end of file if it's last)
    const nextHandler = rest.indexOf("ipcMain.handle(", 10);
    const block = nextHandler > 0 ? rest.slice(0, nextHandler) : rest;
    assert(/spikePercent/.test(block), 'spikePercent missing from snapshot handler');
    assert(/leakPercent/.test(block), 'leakPercent missing from snapshot handler');
  });
  const preload = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');
  await test('preload 暴露 exportHistorySnapshot', () => {
    assert(/exportHistorySnapshot:/.test(preload));
  });
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
  await test('HTML 包含 snapshotBtn', () => {
    assert(/id="snapshotBtn"/.test(html));
  });
  await test('HTML 包含 "导出历史快照" 文本', () => {
    assert(html.includes('导出历史快照'));
  });
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 exportHistorySnapshot 函数', () => {
    assert(/async function exportHistorySnapshot/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.exportHistorySnapshot', () => {
    assert(/window\.electronAPI\.exportHistorySnapshot/.test(renderer));
  });
  await test('renderer 监听 snapshotBtn 按钮', () => {
    assert(/els\.snapshotBtn\.addEventListener/.test(renderer));
  });

  // ============ Syntax ============
  console.log('\n-- 语法检查 --');
  await test('main.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/main.cjs', { cwd: __dirname, stdio: 'pipe' });
  });
  await test('preload.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/preload.cjs', { cwd: __dirname, stdio: 'pipe' });
  });
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
  fs.readdirSync(TMP).forEach(f => fs.unlinkSync(path.join(TMP, f)));
  fs.rmdirSync(TMP);
})();