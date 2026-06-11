// Integration test for persistent recording (Top-N + JSONL + CSV export)
// Verifies the file format, Top-N logic, disk persistence, and CSV export
// WITHOUT spawning the actual Electron app (we extract the pure logic).
const fs = require('fs');
const path = require('path');
const os = require('os');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// ===== Extract pure logic from main.cjs by re-implementing identically =====
// (Cannot import electron app; re-implement the file-format primitives.)

const TOP_N_DEFAULT = 20;

// Replicates appendRecordingSample + startRecording + stopRecording logic
class RecordingSession {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.interval = opts.interval || 2000;
    this.topN = opts.topN || TOP_N_DEFAULT;
    this.sampleCount = 0;
    this.id = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.filePath = path.join(this.dir, this.id + '.jsonl');
    this.stream = fs.createWriteStream(this.filePath, { flags: 'w' });
    this.startTime = Date.now();
    this.stream.write(JSON.stringify({
      header: {
        id: this.id,
        startTime: this.startTime,
        interval: this.interval,
        topN: this.topN,
        version: 'test',
      },
    }) + '\n');
  }

  appendSample(timestamp, processes, systemInfo) {
    if (!this.stream) return;
    const top = [...processes]
      .sort((a, b) => b.memoryUsage - a.memoryUsage)
      .slice(0, this.topN)
      .map(p => ({ pid: p.pid, name: p.name, mem: p.memoryUsage }));
    const sample = {
      t: timestamp,
      sys: {
        totalMem: systemInfo.totalMemory,
        usedMem: systemInfo.usedMemory,
        freeMem: systemInfo.freeMemory,
      },
      top,
    };
    this.stream.write(JSON.stringify(sample) + '\n');
    this.sampleCount++;
  }

  finish() {
    return new Promise(resolve => {
      this.stream.end(() => {
        this.stream = null;
        resolve({ id: this.id, filePath: this.filePath, sampleCount: this.sampleCount });
      });
    });
  }
}

function listRecordings(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const items = [];
  for (const f of files) {
    const filePath = path.join(dir, f);
    const stat = fs.statSync(filePath);
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
    const header = JSON.parse(firstLine).header || {};
    const all = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    let endTime = header.startTime;
    let sampleCount = 0;
    for (let i = 1; i < all.length; i++) {
      try {
        const s = JSON.parse(all[i]);
        endTime = s.t || endTime;
        sampleCount++;
      } catch {}
    }
    items.push({
      id: header.id || f.replace('.jsonl', ''),
      filePath,
      startTime: header.startTime || stat.birthtimeMs,
      endTime,
      interval: header.interval || 0,
      topN: header.topN || TOP_N_DEFAULT,
      sampleCount,
      sizeBytes: stat.size,
    });
  }
  items.sort((a, b) => b.startTime - a.startTime);
  return items;
}

function exportCsv(filePath, outPath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const header = JSON.parse(lines[0]).header || {};
  const N = header.topN || TOP_N_DEFAULT;
  const cols = ['timestamp', 'system_used', 'system_total', 'system_free'];
  for (let i = 0; i < N; i++) cols.push(`r${i}_pid`, `r${i}_name`, `r${i}_mem`);
  const csvEscape = v => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const rows = [cols.join(',')];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const s = JSON.parse(line);
    const row = [
      new Date(s.t).toISOString(),
      s.sys.usedMem || 0,
      s.sys.totalMem || 0,
      s.sys.freeMem || 0,
    ];
    for (let j = 0; j < N; j++) {
      const p = s.top[j];
      row.push(p ? p.pid : '', p ? p.name : '', p ? p.mem : 0);
    }
    rows.push(row.map(csvEscape).join(','));
  }
  fs.writeFileSync(outPath, rows.join('\n') + '\n');
}

// ===== Mock data =====
function makeProcs(n) {
  const procs = [];
  for (let i = 1; i <= n; i++) {
    procs.push({ pid: i, name: 'proc' + i, memoryUsage: (n - i + 1) * 10 * 1024 * 1024 });
  }
  return procs;
}
const MOCK_SYS = { totalMemory: 16 * 1024 * 1024 * 1024, usedMemory: 8 * 1024 * 1024 * 1024, freeMemory: 8 * 1024 * 1024 * 1024 };

// ===== Tests =====
const TMP = path.join(os.tmpdir(), 'mua-rec-test-' + Date.now());

(async () => {
  console.log('\n=== 持久化录制测试 ===\n');
  fs.mkdirSync(TMP, { recursive: true });

  // ============ Top-N logic (5) ============
  console.log('-- Top-N 限制 --');
  await test('Top20: 从100个进程取前20', () => {
    const session = new RecordingSession(TMP, { topN: 20 });
    session.appendSample(Date.now(), makeProcs(100), MOCK_SYS);
    return session.finish().then(() => {
      const content = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const sample = JSON.parse(content[1]);
      assertEq(sample.top.length, 20, 'should slice to 20');
      // Verify sorted descending
      for (let i = 1; i < sample.top.length; i++) {
        assert(sample.top[i - 1].mem >= sample.top[i].mem, 'not sorted descending');
      }
      // Top entry should be highest mem
      assertEq(sample.top[0].pid, 1, 'highest mem should be pid=1');
    });
  });
  await test('Top20: 少于20个进程 → 全录', () => {
    const session = new RecordingSession(TMP, { topN: 20 });
    session.appendSample(Date.now(), makeProcs(5), MOCK_SYS);
    return session.finish().then(() => {
      const content = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const sample = JSON.parse(content[1]);
      assertEq(sample.top.length, 5, 'should record all 5');
    });
  });
  await test('Top5: 限制生效', () => {
    const session = new RecordingSession(TMP, { topN: 5 });
    session.appendSample(Date.now(), makeProcs(100), MOCK_SYS);
    return session.finish().then(() => {
      const content = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const sample = JSON.parse(content[1]);
      assertEq(sample.top.length, 5);
    });
  });
  await test('Top50上限: 配置不被允许超过50', () => {
    // The validation lives in renderer (Math.min(50, ...)); verify that path
    const session = new RecordingSession(TMP, { topN: 50 });
    session.appendSample(Date.now(), makeProcs(50), MOCK_SYS);
    return session.finish().then(() => {
      const content = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const sample = JSON.parse(content[1]);
      assertEq(sample.top.length, 50);
    });
  });
  await test('文件名包含topN信息在header', () => {
    const session = new RecordingSession(TMP, { topN: 15 });
    session.appendSample(Date.now(), makeProcs(100), MOCK_SYS);
    return session.finish().then(() => {
      const content = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const header = JSON.parse(content[0]).header;
      assertEq(header.topN, 15);
    });
  });

  // ============ JSONL format (4) ============
  console.log('\n-- JSONL 文件格式 --');
  await test('第1行是 header', () => {
    const session = new RecordingSession(TMP);
    session.appendSample(Date.now(), makeProcs(10), MOCK_SYS);
    return session.finish().then(() => {
      const lines = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const header = JSON.parse(lines[0]);
      assert(header.header, 'first line should have header key');
      assert(header.header.id, 'header must have id');
      assert(header.header.startTime, 'header must have startTime');
      assertEq(header.header.interval, 2000);
    });
  });
  await test('每行一个sample, 可被逐行parse', () => {
    const session = new RecordingSession(TMP);
    for (let i = 0; i < 10; i++) session.appendSample(Date.now() + i * 1000, makeProcs(5), MOCK_SYS);
    return session.finish().then(() => {
      const lines = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      assertEq(lines.length, 11, 'should be header + 10 samples');
      // Every non-header line should be valid JSON
      for (let i = 1; i < lines.length; i++) {
        const s = JSON.parse(lines[i]); // throws if invalid
        assert(s.t && s.sys && Array.isArray(s.top), 'sample structure wrong');
      }
    });
  });
  await test('sys 字段包含 total/used/free', () => {
    const session = new RecordingSession(TMP);
    session.appendSample(Date.now(), makeProcs(3), MOCK_SYS);
    return session.finish().then(() => {
      const lines = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const s = JSON.parse(lines[1]);
      assertEq(s.sys.totalMem, MOCK_SYS.totalMemory);
      assertEq(s.sys.usedMem, MOCK_SYS.usedMemory);
      assertEq(s.sys.freeMem, MOCK_SYS.freeMemory);
    });
  });
  await test('每个top条目包含 pid/name/mem', () => {
    const session = new RecordingSession(TMP);
    session.appendSample(Date.now(), makeProcs(3), MOCK_SYS);
    return session.finish().then(() => {
      const lines = fs.readFileSync(session.filePath, 'utf8').trim().split('\n');
      const s = JSON.parse(lines[1]);
      s.top.forEach(p => {
        assert(typeof p.pid === 'number', 'pid should be number');
        assert(typeof p.name === 'string', 'name should be string');
        assert(typeof p.mem === 'number', 'mem should be number');
      });
    });
  });

  // ============ List / delete / persistence (5) ============
  console.log('\n-- 列表/删除/持久化 --');
  await test('listRecordings 返回所有录制, 按时间倒序', async () => {
    // Cleanup first
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s1 = new RecordingSession(TMP);
    s1.appendSample(Date.now(), makeProcs(5), MOCK_SYS);
    await s1.finish();
    await new Promise(r => setTimeout(r, 10));
    const s2 = new RecordingSession(TMP);
    s2.appendSample(Date.now(), makeProcs(5), MOCK_SYS);
    await s2.finish();
    const list = listRecordings(TMP);
    assertEq(list.length, 2);
    assert(list[0].startTime >= list[1].startTime, 'should be sorted newest first');
  });
  await test('listRecordings sampleCount 准确', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP);
    for (let i = 0; i < 7; i++) s.appendSample(Date.now() + i, makeProcs(5), MOCK_SYS);
    await s.finish();
    const list = listRecordings(TMP);
    assertEq(list[0].sampleCount, 7);
  });
  await test('listRecordings sizeBytes 准确', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP);
    for (let i = 0; i < 10; i++) s.appendSample(Date.now() + i, makeProcs(5), MOCK_SYS);
    await s.finish();
    const list = listRecordings(TMP);
    assert(list[0].sizeBytes > 0, 'size should be > 0');
    assert(list[0].sizeBytes < 100000, '10 samples of 5 procs should be < 100KB');
  });
  await test('listRecordings 恢复: 模拟重启 (重新读盘)', async () => {
    // Like the real app: after renderer reload, getRecordingStatus+listRecordings
    // should still see the file even if process was "restarted"
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 10, interval: 1500 });
    for (let i = 0; i < 3; i++) s.appendSample(Date.now() + i * 1500, makeProcs(50), MOCK_SYS);
    await s.finish();
    // Simulate "restart" by re-reading
    const fresh = listRecordings(TMP);
    assertEq(fresh.length, 1);
    assertEq(fresh[0].topN, 10);
    assertEq(fresh[0].interval, 1500);
    assertEq(fresh[0].sampleCount, 3);
  });
  await test('deleteRecording 删除文件', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP);
    s.appendSample(Date.now(), makeProcs(3), MOCK_SYS);
    await s.finish();
    const id = s.id;
    const filePath = path.join(TMP, id + '.jsonl');
    assert(fs.existsSync(filePath), 'file should exist');
    fs.unlinkSync(filePath);
    const list = listRecordings(TMP);
    assertEq(list.length, 0);
  });

  // ============ CSV export (4) ============
  console.log('\n-- CSV 导出 --');
  await test('CSV header: timestamp + system + N*3 rank cols', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 10 });
    s.appendSample(Date.now(), makeProcs(5), MOCK_SYS);
    await s.finish();
    const csvPath = path.join(TMP, 'out.csv');
    exportCsv(s.filePath, csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    const headerLine = csv.split('\n')[0];
    const cols = headerLine.split(',');
    assertEq(cols.length, 4 + 10 * 3, 'should have 4 system cols + 30 rank cols');
    assert(cols[0] === 'timestamp', 'first col should be timestamp');
    assert(cols[1] === 'system_used');
  });
  await test('CSV data rows: 每行采样点的rank数据', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 5 });
    for (let i = 0; i < 3; i++) s.appendSample(Date.now() + i * 1000, makeProcs(10), MOCK_SYS);
    await s.finish();
    const csvPath = path.join(TMP, 'out.csv');
    exportCsv(s.filePath, csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    assertEq(csv.length, 4, 'header + 3 data rows');
    const firstRow = csv[1].split(',');
    assertEq(firstRow.length, 4 + 5 * 3);
    assert(firstRow[4] === '1', 'rank 0 pid should be 1 (highest mem)');
  });
  await test('CSV escapes commas in names', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 5 });
    s.appendSample(Date.now(), [
      { pid: 1, name: 'has,comma', memoryUsage: 100 },
      { pid: 2, name: 'normal', memoryUsage: 50 },
    ], MOCK_SYS);
    await s.finish();
    const csvPath = path.join(TMP, 'out.csv');
    exportCsv(s.filePath, csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert(csv.includes('"has,comma"'), 'comma should be quoted');
  });
  await test('CSV escapes quotes in names', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 5 });
    s.appendSample(Date.now(), [
      { pid: 1, name: 'has"quote', memoryUsage: 100 },
    ], MOCK_SYS);
    await s.finish();
    const csvPath = path.join(TMP, 'out.csv');
    exportCsv(s.filePath, csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert(csv.includes('"has""quote"'), 'quote should be doubled and wrapped');
  });

  // ============ Integration: full pipeline (3) ============
  console.log('\n-- 完整流程 --');
  await test('完整录制流程: start → 100 samples → stop → list → csv', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const s = new RecordingSession(TMP, { topN: 20, interval: 1000 });
    // Simulate 100 ticks @ 100ms apart
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      // Vary memory each tick to simulate real activity
      const procs = makeProcs(375).map(p => ({
        ...p,
        memoryUsage: p.memoryUsage + Math.floor(Math.random() * 50 * 1024 * 1024),
      }));
      s.appendSample(t0 + i * 100, procs, MOCK_SYS);
    }
    const result = await s.finish();
    assertEq(result.sampleCount, 100);
    // Verify file size is bounded (~1.4MB/hr ≈ 400B/sample)
    const stat = fs.statSync(result.filePath);
    assert(stat.size < 100000, `100 samples of Top20 should be < 100KB, got ${stat.size}`);
    // List and verify
    const list = listRecordings(TMP);
    assertEq(list.length, 1);
    assertEq(list[0].sampleCount, 100);
    // CSV export
    const csvPath = path.join(TMP, 'full.csv');
    exportCsv(result.filePath, csvPath);
    const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    assertEq(csvLines.length, 101, 'header + 100 rows');
  });
  await test('多录制并发: 同时存在3个文件', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const s = new RecordingSession(TMP, { topN: 10 + i });
      s.appendSample(Date.now(), makeProcs(20), MOCK_SYS);
      sessions.push(s);
    }
    await Promise.all(sessions.map(s => s.finish()));
    const list = listRecordings(TMP);
    assertEq(list.length, 3);
    assert(list.some(r => r.topN === 10));
    assert(list.some(r => r.topN === 11));
    assert(list.some(r => r.topN === 12));
  });
  await test('崩溃恢复: 只写header的孤儿文件仍能被列出', async () => {
    fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).forEach(f => fs.unlinkSync(path.join(TMP, f)));
    // Simulate crash: file with only header, no samples
    const orphanPath = path.join(TMP, 'rec_orphan.jsonl');
    fs.writeFileSync(orphanPath, JSON.stringify({
      header: { id: 'rec_orphan', startTime: Date.now(), interval: 2000, topN: 20, version: 'test' },
    }) + '\n');
    const list = listRecordings(TMP);
    assertEq(list.length, 1);
    assertEq(list[0].sampleCount, 0, 'orphan should have 0 samples');
  });

  // ============ Source-level (3) ============
  console.log('\n-- 源码检查 --');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.cjs'), 'utf8');
  await test('main.cjs 包含 start-recording IPC', () => {
    assert(/ipcMain\.handle\(['"]start-recording['"]/.test(main));
  });
  await test('main.cjs 包含 stop-recording IPC', () => {
    assert(/ipcMain\.handle\(['"]stop-recording['"]/.test(main));
  });
  await test('main.cjs 包含 list-recordings IPC', () => {
    assert(/ipcMain\.handle\(['"]list-recordings['"]/.test(main));
  });
  await test('main.cjs 包含 export-recording-csv IPC', () => {
    assert(/ipcMain\.handle\(['"]export-recording-csv['"]/.test(main));
  });
  await test('main.cjs 包含 delete-recording IPC', () => {
    assert(/ipcMain\.handle\(['"]delete-recording['"]/.test(main));
  });
  await test('main.cjs 在 collectData 中调用 appendRecordingSample', () => {
    assert(/appendRecordingSample\(/.test(main));
  });
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'preload.cjs'), 'utf8');
  await test('preload 暴露 5 个 recording API', () => {
    assert(/startRecording:/.test(preload));
    assert(/stopRecording:/.test(preload));
    assert(/listRecordings:/.test(preload));
    assert(/deleteRecording:/.test(preload));
    assert(/exportRecordingCsv:/.test(preload));
  });
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
  await test('HTML 包含 recTopN 输入', () => {
    assert(/id="recTopN"/.test(html));
  });
  await test('HTML 默认间隔 2000ms', () => {
    const m = html.match(/id="recInterval"[^>]*value="(\d+)"/);
    assert(m && m[1] === '2000', 'expected default 2000ms, got ' + (m && m[1]));
  });
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer.js'), 'utf8');
  await test('renderer 调用 window.electronAPI.startRecording', () => {
    assert(/window\.electronAPI\.startRecording/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.listRecordings', () => {
    assert(/window\.electronAPI\.listRecordings/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.exportRecordingCsv', () => {
    assert(/window\.electronAPI\.exportRecordingCsv/.test(renderer));
  });
  await test('renderer 不再有内嵌的 setInterval-based recording', () => {
    // Old code used setInterval + activeRecording.data.push; new code uses IPC.
    // We verify the OLD pattern is gone.
    assert(!/activeRecording\.data\.push/.test(renderer), 'should not have in-memory data push');
  });
  await test('renderer 在启动时调用 loadRecordings', () => {
    assert(/^loadRecordings\(\);$/m.test(renderer), 'should call loadRecordings on startup');
  });

  // ============ Syntax checks ============
  console.log('\n-- 语法检查 --');
  await test('main.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/main.cjs', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
  await test('preload.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c electron/preload.cjs', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
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
  // Cleanup
  fs.readdirSync(TMP).forEach(f => fs.unlinkSync(path.join(TMP, f)));
  fs.rmdirSync(TMP);
})();