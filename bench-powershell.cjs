// Benchmark: PowerShell long-session optimization
//
// Compares cold-start (every 2s spawn new powershell.exe) vs warm session
// (single REPL process, REPL protocol over stdin/stdout).
//
// We exercise the EXACT same REPL protocol from main.cjs against the same
// powershell.exe binary — just without Electron — so the timing data is
// representative of what production will see.

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLD_SCRIPT = `
$procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
  [PSCustomObject]@{ pid = [int]$_.Id; name = $_.ProcessName; memory = [long]$_.WorkingSet64 }
}
$os = Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{
  processes = $procs
  system = @{ total = [long]$os.TotalVisibleMemorySize * 1024; free = [long]$os.FreePhysicalMemory * 1024 }
} | ConvertTo-Json -Compress -Depth 3
`;

const REPL_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Collect {
  $procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
    [PSCustomObject]@{ pid = [int]$_.Id; name = $_.ProcessName; memory = [long]$_.WorkingSet64 }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  [PSCustomObject]@{
    processes = $procs
    system = @{ total = [long]$os.TotalVisibleMemorySize * 1024; free = [long]$os.FreePhysicalMemory * 1024 }
  } | ConvertTo-Json -Compress -Depth 3
}
Write-Output 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'COLLECT') {
    try {
      $json = Collect
      if ($null -eq $json) { $json = '' }
      Write-Output $json
    } catch {
      Write-Output "ERR: $($_.Exception.Message)"
    }
    Write-Output 'READY'
  } elseif ($line.Trim() -eq 'EXIT') {
    break
  }
}
`;

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function benchColdStart(iterations = 5) {
  const tmpScript = path.join(os.tmpdir(), 'mua-bench-cold.ps1');
  fs.writeFileSync(tmpScript, COLD_SCRIPT, 'utf8');
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now();
    try {
      await execAsync(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 15000, windowsHide: true }
      );
    } catch (e) { console.error('cold iter failed:', e.message); }
    samples.push(Date.now() - t0);
  }
  try { fs.unlinkSync(tmpScript); } catch {}
  return samples;
}

// Replicates the REPL session from main.cjs
function startReplSession() {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', REPL_SCRIPT,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { proc, buffer: '', jsonAccum: [], pending: null, alive: true, ready: false };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', chunk => {
      session.buffer += chunk;
      let nl;
      while ((nl = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, nl).replace(/\r$/, '');
        session.buffer = session.buffer.slice(nl + 1);
        if (line === 'READY') {
          if (!session.ready) {
            session.ready = true;
            resolve(session);
            return;
          }
          if (session.pending) {
            const p = session.pending;
            session.pending = null;
            const text = session.jsonAccum.join('\n').trim();
            session.jsonAccum = [];
            try { p.resolve(JSON.parse(text)); }
            catch (e) { p.reject(new Error('parse: ' + e.message)); }
          }
        } else if (line.startsWith('ERR: ')) {
          if (session.pending) {
            const p = session.pending;
            session.pending = null;
            p.reject(new Error(line.slice(5)));
          }
        } else if (session.pending) {
          session.jsonAccum.push(line);
        }
      }
    });
    proc.stderr.on('data', d => {});
    proc.on('exit', () => { session.alive = false; });
    proc.on('error', err => reject(err));
  });
}

async function benchWarmSession(iterations = 10) {
  const session = await startReplSession();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const result = await new Promise((resolve, reject) => {
      session.pending = { resolve, reject };
      session.jsonAccum = [];
      try { session.proc.stdin.write('COLLECT\n'); }
      catch (e) { reject(e); }
    });
    const t0 = Date.now();
    // We already measured above; just record zero for the protocol overhead
    // Actually re-measure properly: each iteration only the COLLECT roundtrip
    samples.push(Date.now() - t0);
  }
  // Re-measure properly: each call's latency from write to resolve
  const properSamples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      session.pending = { resolve, reject };
      session.jsonAccum = [];
      try { session.proc.stdin.write('COLLECT\n'); }
      catch (e) { reject(e); }
    });
    properSamples.push(Date.now() - t0);
  }
  session.proc.stdin.write('EXIT\n');
  return properSamples;
}

(async () => {
  console.log('\n=== PowerShell 长连接优化 基准测试 ===\n');
  console.log('环境: Node.js', process.version, '/', os.platform(), os.release());
  console.log('CPU: 测量 5-10 次取平均值\n');

  // Warmup (first PS start is always slower; user gets that cost ONCE now)
  console.log('Warmup: 预热 PowerShell 运行时...');
  await execAsync('powershell.exe -NoProfile -Command "exit 0"', { windowsHide: true });

  console.log('\n[1/2] 旧方式 (每次都起新进程)...');
  const cold = await benchColdStart(5);
  console.log(`  样本: ${cold.map(x => x + 'ms').join(', ')}`);
  console.log(`  平均: ${avg(cold).toFixed(0)}ms  中位数: ${median(cold).toFixed(0)}ms  最小: ${Math.min(...cold)}ms`);

  console.log('\n[2/2] 新方式 (长连接 REPL)...');
  console.log('  启动 session (一次性)...');
  const sessionStart = Date.now();
  const session = await startReplSession();
  const startupMs = Date.now() - sessionStart;
  console.log(`  Session 启动耗时: ${startupMs}ms (一次性成本)`);

  const warm = await benchWarmSession(10);
  console.log(`  样本: ${warm.map(x => x + 'ms').join(', ')}`);
  console.log(`  平均: ${avg(warm).toFixed(0)}ms  中位数: ${median(warm).toFixed(0)}ms  最小: ${Math.min(...warm)}ms`);

  session.proc.stdin.write('EXIT\n');

  // Analysis
  console.log('\n=== 分析 ===');
  const coldAvg = avg(cold);
  const warmAvg = avg(warm);
  const speedup = (coldAvg / warmAvg).toFixed(1);
  const savedPerTick = (coldAvg - warmAvg).toFixed(0);
  const savedPerMin = (savedPerTick * 30).toFixed(0);  // 30 ticks/min @ 2s
  const savedPerHour = (savedPerTick * 30 * 60 / 1000).toFixed(1);

  console.log(`旧方式每次: ${coldAvg.toFixed(0)}ms`);
  console.log(`新方式每次: ${warmAvg.toFixed(0)}ms (REPL 往返)`);
  console.log(`加速比: ${speedup}x`);
  console.log(`每次节省: ${savedPerTick}ms`);
  console.log(`每分钟节省: ${savedPerMin}ms (= ${(savedPerMin / 1000).toFixed(1)}s)`);
  console.log(`每小时节省: ${savedPerHour}s 的 CPU 时间`);

  // Per-tick breakdown:
  // - old: cold-start every 2s = 430ms * 30 = 12.9s/min = 64.5% of one core
  // - new: warm session + cheap COLLECT = ~50ms * 30 = 1.5s/min = 2.5% of one core
  console.log('\n=== 影响 (每2秒1次) ===');
  console.log(`旧方式: ${(coldAvg * 30 / 1000).toFixed(1)}s CPU/分钟 ≈ ${(coldAvg * 30 / 1000 / 60 * 100).toFixed(1)}% 单核`);
  console.log(`新方式: ${(warmAvg * 30 / 1000).toFixed(1)}s CPU/分钟 ≈ ${(warmAvg * 30 / 1000 / 60 * 100).toFixed(1)}% 单核`);

  // Sanity: collect a sample to verify JSON shape unchanged
  console.log('\n=== 验证: JSON 输出兼容性 ===');
  const session2 = await startReplSession();
  const data = await new Promise((resolve, reject) => {
    session2.pending = { resolve, reject };
    session2.jsonAccum = [];
    session2.proc.stdin.write('COLLECT\n');
  });
  session2.proc.stdin.write('EXIT\n');

  if (Array.isArray(data.processes) && data.processes.length > 0) {
    console.log(`  ✓ 返回 ${data.processes.length} 个进程`);
    console.log(`  ✓ 示例: pid=${data.processes[0].pid} name=${data.processes[0].name} mem=${data.processes[0].memory}`);
    console.log(`  ✓ system.total=${data.system.total} system.free=${data.system.free}`);
  } else {
    console.log('  ✗ JSON shape mismatch:', JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }
})();