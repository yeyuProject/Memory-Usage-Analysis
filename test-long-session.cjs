// Integration test for PowerShell long-session protocol
// Validates the REPL state machine (request queuing, JSON accumulation,
// READY/ERR handling) without spawning real PowerShell.
// The actual benchmark (real PS) lives in bench-powershell.cjs.

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

// Mock session (mirrors main.cjs structure but with a fake stdin/stdout)
function createMockSession() {
  return {
    buffer: '',
    jsonAccum: [],
    pending: null,
    queue: [],
    alive: true,
    stats: { requests: 0, errors: 0, lastDurationMs: 0 },
    // Fake stdin - records writes
    stdinWrites: [],
    write: function(cmd) { this.stdinWrites.push(cmd); },
  };
}

// Replicate the handlePsLine logic from main.cjs (verbatim where possible)
function handlePsLine(session, line) {
  if (line === 'READY') {
    if (session.pending) {
      const p = session.pending;
      session.pending = null;
      const text = session.jsonAccum.join('\n').trim();
      session.jsonAccum = [];
      session.stats.lastDurationMs = Date.now() - p.startedAt;
      session.stats.requests++;
      if (!text) { p.resolve(null); }
      else {
        try { p.resolve(JSON.parse(text)); }
        catch (e) { p.reject(new Error('JSON parse failed: ' + e.message)); }
      }
    }
    drainQueue(session);
    return;
  }
  if (line.startsWith('ERR: ')) {
    if (session.pending) {
      const p = session.pending;
      session.pending = null;
      session.jsonAccum = [];
      session.stats.errors++;
      p.reject(new Error(line.slice(5)));
    }
    // Do NOT drain here — wait for the next READY. (matches main.cjs fix)
    return;
  }
  if (session.pending) session.jsonAccum.push(line);
}

function drainQueue(session) {
  while (session.queue.length > 0 && session.alive && !session.pending) {
    const next = session.queue.shift();
    sendCollectRequest(session, next);
  }
}

function sendCollectRequest(session, req) {
  session.pending = { resolve: req.resolve, reject: req.reject, startedAt: Date.now() };
  session.jsonAccum = [];
  session.write('COLLECT\n');
}

function feed(session, chunk) {
  session.buffer += chunk;
  let nl;
  while ((nl = session.buffer.indexOf('\n')) >= 0) {
    const line = session.buffer.slice(0, nl).replace(/\r$/, '');
    session.buffer = session.buffer.slice(nl + 1);
    handlePsLine(session, line);
  }
}

function request(session) {
  return new Promise((resolve, reject) => {
    if (session.pending) {
      session.queue.push({ resolve, reject });
      return;
    }
    sendCollectRequest(session, { resolve, reject });
  });
}

(async () => {
  console.log('\n=== PowerShell 长连接协议测试 ===\n');

  // ============ Basic request/response (6) ============
  console.log('-- 基础请求/响应 --');
  await test('单次COLLECT返回解析后的JSON', async () => {
    const s = createMockSession();
    const p = request(s);
    assertEq(s.stdinWrites.length, 1);
    assertEq(s.stdinWrites[0], 'COLLECT\n');
    feed(s, '{"processes":[{"pid":1,"name":"x","memory":100}],"system":{"total":1000,"free":500}}\n');
    feed(s, 'READY\n');
    const result = await p;
    assertEq(result.processes[0].pid, 1);
    assertEq(result.system.total, 1000);
  });
  await test('JSON跨多行也能正确累积', async () => {
    // Valid JSON can span multiple lines (e.g., pretty-printed). Test that
    // lines between COLLECT and READY are reassembled correctly.
    const s = createMockSession();
    const p = request(s);
    feed(s, '{\n');
    feed(s, '  "processes": [{"pid": 1, "name": "x", "memory": 100}],\n');
    feed(s, '  "system": {"total": 1000, "free": 500}\n');
    feed(s, '}\n');
    feed(s, 'READY\n');
    const result = await p;
    assertEq(result.processes[0].pid, 1);
    assertEq(result.processes[0].name, 'x');
    assertEq(result.system.total, 1000);
  });
  await test('JSON分块到达 (多个data事件) 也能重组', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"processes":[{"pid":1,"nam');
    feed(s, 'e":"x","memory":100');
    feed(s, '}],"system":{"total":1');
    feed(s, '000,"free":500}}\nREADY\n');
    const result = await p;
    assertEq(result.processes[0].pid, 1);
    assertEq(result.system.total, 1000);
  });
  await test('响应为空 (null) 也正确处理', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, 'READY\n');
    const result = await p;
    assertEq(result, null);
  });
  await test('空响应+额外空行 不影响解析', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '\n');
    feed(s, 'READY\n');
    const result = await p;
    assertEq(result, null);
  });
  await test('stdin.write被调用一次 (无重试)', async () => {
    const s = createMockSession();
    request(s);
    assertEq(s.stdinWrites.length, 1);
    feed(s, 'READY\n');
    assertEq(s.stdinWrites.length, 1);
  });

  // ============ Queueing (5) ============
  console.log('\n-- 请求队列 --');
  await test('并发请求被自动排队', async () => {
    const s = createMockSession();
    const p1 = request(s);
    const p2 = request(s);  // queued
    const p3 = request(s);  // queued
    assertEq(s.stdinWrites.length, 1, 'only one COLLECT in flight');
    assertEq(s.queue.length, 2);
    // Finish first
    feed(s, '{"processes":[],"system":{}}\nREADY\n');
    await p1;
    assertEq(s.stdinWrites.length, 2, 'second COLLECT sent after first READY');
    assertEq(s.queue.length, 1);
    feed(s, '{"processes":[],"system":{}}\nREADY\n');
    await p2;
    assertEq(s.stdinWrites.length, 3);
    feed(s, '{"processes":[],"system":{}}\nREADY\n');
    await p3;
    assertEq(s.queue.length, 0);
  });
  await test('排队请求在session死亡时不会被发送', async () => {
    const s = createMockSession();
    const p1 = request(s);
    const p2 = request(s);  // queued
    s.alive = false;
    // Without drainQueue, queued requests just wait; that's the documented
    // behavior (caller should check alive before psCollect).
    assertEq(s.queue.length, 1);
    // When alive=true is restored and a READY comes, drainQueue fires p2.
    s.alive = true;
    feed(s, 'READY\n');
    await p1;
    assertEq(s.stdinWrites.length, 2);
    feed(s, 'READY\n');
    await p2;
  });
  await test('10个并发请求全部按序完成', async () => {
    const s = createMockSession();
    const promises = [];
    for (let i = 0; i < 10; i++) promises.push(request(s));
    assertEq(s.stdinWrites.length, 1);
    // Feed responses one at a time, checking the right promise resolves
    for (let i = 0; i < 10; i++) {
      feed(s, `{"processes":[],"system":{"i":${i}}}\nREADY\n`);
      const r = await promises[i];
      assertEq(r.system.i, i);
    }
  });
  await test('队列请求收到对应响应才能resolve', async () => {
    const s = createMockSession();
    const p1 = request(s);
    const p2 = request(s);
    feed(s, '{"processes":[],"system":{"who":"first"}}\nREADY\n');
    feed(s, '{"processes":[],"system":{"who":"second"}}\nREADY\n');
    const r1 = await p1;
    const r2 = await p2;
    assertEq(r1.system.who, 'first');
    assertEq(r2.system.who, 'second');
  });
  await test('空请求队列时drainQueue不发送任何东西', async () => {
    const s = createMockSession();
    feed(s, 'READY\n');  // no pending
    assertEq(s.stdinWrites.length, 0);
  });

  // ============ Error handling (5) ============
  console.log('\n-- 错误处理 --');
  await test('ERR: 行被正确传播为错误', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, 'ERR: Get-Process timed out\nREADY\n');
    try {
      await p;
      throw new Error('should have rejected');
    } catch (e) {
      assert(e.message.includes('Get-Process timed out'));
    }
    assertEq(s.stats.errors, 1);
  });
  await test('错误后队列中的下一个请求继续', async () => {
    const s = createMockSession();
    const p1 = request(s);
    const p2 = request(s);
    feed(s, 'ERR: boom\nREADY\n');
    try { await p1; } catch {}
    assertEq(s.stdinWrites.length, 2, 'p2 should be sent');
    feed(s, '{"processes":[],"system":{}}\nREADY\n');
    const r = await p2;
    assert(r.processes);
  });
  await test('JSON解析失败抛出错误', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, 'not valid json\nREADY\n');
    try {
      await p;
      throw new Error('should have rejected');
    } catch (e) {
      assert(e.message.includes('JSON parse failed'));
    }
  });
  await test('错误响应中夹杂的JSON行被忽略 (优先ERR)', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"processes":[{"pid":1}\n');
    feed(s, 'ERR: something\n');
    feed(s, 'READY\n');
    try {
      await p;
      throw new Error('should have rejected');
    } catch (e) {
      assert(e.message.includes('something'));
    }
  });
  await test('连续两个错误互不影响', async () => {
    const s = createMockSession();
    const p1 = request(s);
    feed(s, 'ERR: first\nREADY\n');
    try { await p1; } catch (e) { assert(e.message.includes('first')); }
    const p2 = request(s);
    feed(s, 'ERR: second\nREADY\n');
    try { await p2; } catch (e) { assert(e.message.includes('second')); }
  });

  // ============ Buffering edge cases (4) ============
  console.log('\n-- 缓冲边界 --');
  await test('单行跨越多个read (字节级分块)', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"processes":[{"pid":');
    feed(s, '1234,"name":"te');
    feed(s, 'st","memory":99}],"system":{"total":1000,"free":500}}\nR');
    feed(s, 'EADY\n');
    const r = await p;
    assertEq(r.processes[0].pid, 1234);
  });
  await test('\\r\\n 行尾被正确剥离', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"processes":[],"system":{}}\r\nREADY\r\n');
    const r = await p;
    assert(Array.isArray(r.processes));
  });
  await test('JSON后跟着非空字符串行 → 累积', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"processes":[{"pid":1,"name":"x","memory":100}\n');
    feed(s, ',{"pid":2,"name":"y","memory":200}],"system":{}}\n');
    feed(s, 'READY\n');
    const r = await p;
    assertEq(r.processes.length, 2);
    assertEq(r.processes[1].pid, 2);
  });
  await test('READY出现在第二个响应 (前一个还没处理) → 仍正确解析', async () => {
    const s = createMockSession();
    const p = request(s);
    feed(s, '{"a":1}\nREADY\n{"b":2}\nREADY\n');  // two responses back-to-back
    const r = await p;
    assertEq(r.a, 1);
  });

  // ============ Source-level checks (8) ============
  console.log('\n-- 源码检查 --');
  const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
  await test('main.cjs 包含 PS_READY 哨兵常量', () => {
    assert(/const PS_READY\s*=\s*['"]READY['"]/.test(main));
  });
  await test('main.cjs 包含 psSession 状态', () => {
    assert(/let psSession\s*=/.test(main));
  });
  await test('main.cjs 包含 psQueue 队列', () => {
    assert(/const psQueue\s*=/.test(main));
  });
  await test('main.cjs 包含 startPsSession 函数', () => {
    assert(/function startPsSession\(\)/.test(main));
  });
  await test('main.cjs 包含 stopPsSession 函数', () => {
    assert(/function stopPsSession\(\)/.test(main));
  });
  await test('main.cjs 包含 psCollect 函数', () => {
    assert(/function psCollect\(\)/.test(main));
  });
  await test('main.cjs 包含 handlePsLine 函数', () => {
    assert(/function handlePsLine\(/.test(main));
  });
  await test('main.cjs 包含 drainQueue 函数', () => {
    assert(/function drainQueue\(/.test(main));
  });
  await test('main.cjs 使用 child_process.spawn', () => {
    assert(/require\(['"]child_process['"]\)/.test(main));
    assert(/spawn\(/.test(main));
  });
  await test('main.cjs 仍然使用 Write-Output 哨兵 (REPL兼容)', () => {
    // Sentinel is written via template literal: Write-Output 'READY'
    assert(/Write-Output.*READY/.test(main), 'should write READY sentinel');
  });
  await test('main.cjs collectData 调用 psCollect', () => {
    const fn = main.match(/async function collectData\([\s\S]*?\n\}/);
    assert(fn, 'collectData not found');
    assert(/psCollect\(\)/.test(fn[0]));
  });
  await test('main.cjs 旧 COLLECTOR_SCRIPT + writeFileSync + 周期性execAsync 已被移除', () => {
    assert(!/const COLLECTOR_SCRIPT\s*=/.test(main), 'old COLLECTOR_SCRIPT should be gone');
    assert(!/writeFileSync\(scriptPath/.test(main), 'old writeFileSync should be gone');
    // collectData no longer uses execAsync (other ad-hoc uses like taskkill
    // and open-file-location legitimately still call execAsync for one-off commands)
    const fn = main.match(/async function collectData\([\s\S]*?\n\}/);
    assert(fn);
    assert(!/execAsync\(/.test(fn[0]), 'collectData should not use execAsync anymore');
  });
  await test('main.cjs 在 before-quit 中停止PS session', () => {
    const handler = main.match(/app\.on\(['"]before-quit['"][\s\S]*?\}\);/g);
    assert(handler && handler.length > 0, 'before-quit handler not found');
    const hasStopCall = handler.some(h => /stopPsSession\(\)/.test(h));
    assert(hasStopCall, 'stopPsSession not called on before-quit');
  });
  await test('main.cjs 暴露 get-collector-stats IPC', () => {
    assert(/ipcMain\.handle\(['"]get-collector-stats['"]/.test(main));
  });
  const preload = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');
  await test('preload 暴露 getCollectorStats', () => {
    assert(/getCollectorStats:/.test(preload));
  });

  // ============ Bench file present ============
  await test('bench-powershell.cjs 存在', () => {
    assert(fs.existsSync(path.join(__dirname, 'bench-powershell.cjs')));
  });
  const bench = fs.readFileSync(path.join(__dirname, 'bench-powershell.cjs'), 'utf8');
  await test('bench 使用真实的 REPL_SCRIPT', () => {
    assert(/REPL_SCRIPT\s*=/.test(bench));
    assert(/'READY'/.test(bench));
  });
  await test('bench 同时测量 cold 和 warm', () => {
    assert(/benchColdStart/.test(bench));
    assert(/benchWarmSession/.test(bench));
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
  await test('bench-powershell.cjs 语法正确', () => {
    const { execSync } = require('child_process');
    execSync('node -c bench-powershell.cjs', { cwd: __dirname, stdio: 'pipe' });
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