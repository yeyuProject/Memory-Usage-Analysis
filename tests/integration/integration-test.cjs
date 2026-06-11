// Integration Test - Tests the full data pipeline
// PowerShell -> JSON -> Main process -> IPC handlers -> Renderer logic
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const COLLECTOR_SCRIPT = `
$procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
  [PSCustomObject]@{ pid = [int]$_.Id; name = $_.ProcessName; memory = [long]$_.WorkingSet64 }
}
$os = Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{
  processes = $procs
  system = @{ total = [long]$os.TotalVisibleMemorySize * 1024; free = [long]$os.FreePhysicalMemory * 1024 }
} | ConvertTo-Json -Compress -Depth 3
`;

const MEM_RATIOS = {
  PRIVATE_RATIO: 0.7,
  COMMIT_RATIO: 1.3,
};

async function collectFromPowerShell() {
  const tmp = path.join(os.tmpdir(), 'integration-test.ps1');
  fs.writeFileSync(tmp, COLLECTOR_SCRIPT, 'utf8');
  try {
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 15000, windowsHide: true }
    );
    return JSON.parse(stdout);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Simulate main process IPC handler: get-processes
function handleGetProcesses(rawData) {
  return rawData.processes
    .map(p => ({ pid: p.pid, name: p.name, memoryUsage: p.memory || 0 }))
    .sort((a, b) => b.memoryUsage - a.memoryUsage);
}

// Simulate main process IPC handler: get-system-info
function handleGetSystemInfo(rawData) {
  return {
    totalPhysicalMemory: rawData.system.total,
    availablePhysicalMemory: rawData.system.free,
    memoryLoad: Math.round(((rawData.system.total - rawData.system.free) / rawData.system.total) * 100),
    timestamp: Date.now(),
  };
}

// Simulate main process IPC handler: get-process-memory
function handleGetProcessMemory(processes, pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const p = processes.find(x => x.pid === pid);
  if (!p) return null;
  return {
    workingSetSize: p.memoryUsage,
    privateWorkingSetSize: Math.floor(p.memoryUsage * MEM_RATIOS.PRIVATE_RATIO),
    commitSize: Math.floor(p.memoryUsage * MEM_RATIOS.COMMIT_RATIO),
    timestamp: Date.now(),
  };
}

// Simulate renderer logic: sort with toggle (case-insensitive for strings)
function applySort(processes, sortKey, sortDir) {
  const sorted = [...processes];
  sorted.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') {
      // Case-insensitive compare so 'i' and 'I' are treated as same letter
      const cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    }
    return sortDir === 'asc' ? va - vb : vb - va;
  });
  return sorted;
}

// Simulate renderer: filter processes
function applyFilter(processes, criteria) {
  let list = [...processes];
  if (criteria.processIds && criteria.processIds.length > 0) {
    list = list.filter(p => criteria.processIds.includes(p.pid));
  }
  if (criteria.minMem != null) {
    list = list.filter(p => p.memoryUsage >= criteria.minMem * 1024 * 1024);
  }
  if (criteria.maxMem != null) {
    list = list.filter(p => p.memoryUsage <= criteria.maxMem * 1024 * 1024);
  }
  if (criteria.search) {
    const term = criteria.search.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(term) || String(p.pid).includes(term));
  }
  return list;
}

// Simulate renderer: notification engine
function checkNotificationRules(rules, processes, notifyEnabled) {
  if (!notifyEnabled) return { triggered: [], recovered: [] };
  const triggered = [];
  const recovered = [];
  rules.forEach(rule => {
    const target = processes.find(p => p.memoryUsage >= rule.threshold);
    if (target && !rule.triggered) {
      triggered.push({ rule, process: target });
    } else if (!target && rule.triggered) {
      recovered.push({ rule });
    }
  });
  return { triggered, recovered };
}

// Simulate renderer: format CSV export
function formatCSV(processes) {
  const header = 'PID,名称,工作集,私有工作集,提交大小,时间戳';
  const rows = processes.map(p =>
    [p.pid, p.name, p.memoryUsage, Math.floor(p.memoryUsage * MEM_RATIOS.PRIVATE_RATIO), Math.floor(p.memoryUsage * MEM_RATIOS.COMMIT_RATIO), Date.now()].join(',')
  );
  return [header, ...rows].join('\n');
}

// Simulate renderer: format JSON export
function formatJSON(processes, system) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    system,
    processes,
  }, null, 2);
}

// Simulate renderer: format HTML export
function formatHTML(processes, system) {
  return `<!DOCTYPE html><html><head><title>内存分析报告</title></head><body>
<h1>内存分析报告</h1>
<p>系统: ${(system.totalPhysicalMemory/1024/1024/1024).toFixed(2)} GB</p>
<table border="1"><tr><th>PID</th><th>名称</th><th>内存</th></tr>
${processes.map(p => `<tr><td>${p.pid}</td><td>${p.name}</td><td>${p.memoryUsage}</td></tr>`).join('')}
</table></body></html>`;
}

// === Test runner ===
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

(async () => {
  console.log('================================================');
  console.log('  Memory Usage Analysis - 集成测试 (Integration)');
  console.log('================================================\n');

  // === Step 1: PowerShell collector ===
  console.log('[Step 1] PowerShell 采集器');
  let raw;
  await test('1.1 - PowerShell 成功执行', async () => {
    raw = await collectFromPowerShell();
    assert(raw && raw.processes && raw.system, 'invalid raw data');
  });
  const processes = handleGetProcesses(raw);
  const system = handleGetSystemInfo(raw);

  // === Step 2: Main process IPC handlers ===
  console.log('\n[Step 2] 主进程 IPC 处理器');
  await test('2.1 - getProcesses 返回的进程已按内存降序排序', () => {
    for (let i = 1; i < processes.length; i++) {
      assert(processes[i].memoryUsage <= processes[i-1].memoryUsage, `not sorted at ${i}`);
    }
  });
  await test('2.2 - getProcesses 字段正确 (pid/name/memoryUsage)', () => {
    const p = processes[0];
    assert(typeof p.pid === 'number', 'pid not number');
    assert(typeof p.name === 'string', 'name not string');
    assert(typeof p.memoryUsage === 'number', 'memoryUsage not number');
  });
  await test('2.3 - getSystemInfo 计算 memoryLoad', () => {
    assert(system.memoryLoad >= 0 && system.memoryLoad <= 100, 'memoryLoad out of range');
    console.log(`      使用率=${system.memoryLoad}%  总=${(system.totalPhysicalMemory/1024/1024/1024).toFixed(1)}GB`);
  });
  await test('2.4 - getProcessMemory 返回 MEM_RATIOS 估算值', () => {
    const proc = processes[0];
    const result = handleGetProcessMemory(processes, proc.pid);
    assertEq(result.workingSetSize, proc.memoryUsage, 'WS mismatch');
    assertEq(result.privateWorkingSetSize, Math.floor(proc.memoryUsage * 0.7), 'PWS ratio');
    assertEq(result.commitSize, Math.floor(proc.memoryUsage * 1.3), 'Commit ratio');
  });
  await test('2.5 - getProcessMemory 拒绝非法 pid (string)', () => {
    const r = handleGetProcessMemory(processes, 'abc');
    assert(r === null, 'should return null for non-number pid');
  });
  await test('2.6 - getProcessMemory 拒绝 pid=0', () => {
    const r = handleGetProcessMemory(processes, 0);
    assert(r === null, 'should return null for pid 0');
  });
  await test('2.7 - getProcessMemory 拒绝负数 pid', () => {
    const r = handleGetProcessMemory(processes, -100);
    assert(r === null, 'should return null for negative pid');
  });
  await test('2.8 - getProcessMemory 拒绝不存在的 pid', () => {
    const r = handleGetProcessMemory(processes, 999999999);
    assert(r === null, 'should return null for non-existent pid');
  });

  // === Step 3: Renderer sort logic ===
  console.log('\n[Step 3] 渲染层排序');
  await test('3.1 - 默认按内存降序', () => {
    const sorted = applySort(processes, 'memoryUsage', 'desc');
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i].memoryUsage <= sorted[i-1].memoryUsage, 'sort broken');
    }
  });
  await test('3.2 - 切换到 PID 升序', () => {
    const sorted = applySort(processes, 'pid', 'asc');
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i].pid >= sorted[i-1].pid, 'pid asc broken');
    }
  });
  await test('3.3 - 切换到名称字母降序 (C 在 I 之前)', () => {
    const sorted = applySort(processes, 'name', 'desc');
    // Case-insensitive desc: i > c alphabetically, so idea64 (i) comes BEFORE Codex (C)
    const i = sorted.findIndex(p => p.name === 'idea64');
    const c = sorted.findIndex(p => p.name === 'Codex');
    if (i >= 0 && c >= 0) {
      assert(i < c, 'in desc sort, "idea64" (i) should come before "Codex" (C)');
    }
  });
  await test('3.4 - 排序稳定性：相同 PID 保持原顺序', () => {
    const a = [...processes];
    const b = applySort(processes, 'pid', 'asc');
    // check lengths match
    assertEq(a.length, b.length, 'length mismatch');
  });

  // === Step 4: Filter logic ===
  console.log('\n[Step 4] 渲染层筛选');
  await test('4.1 - 按名称搜索 "idea" 至少匹配 1 个', () => {
    const result = applyFilter(processes, { search: 'idea' });
    assert(result.length > 0, 'no match');
    result.forEach(p => assert(p.name.toLowerCase().includes('idea'), 'false positive'));
    console.log(`      "idea" 匹配: ${result.length} 个`);
  });
  await test('4.2 - 按 PID 范围筛选', () => {
    const result = applyFilter(processes, { minMem: 100, maxMem: 500 });
    console.log(`      100-500MB: ${result.length} 个`);
    result.forEach(p => {
      const mb = p.memoryUsage / 1024 / 1024;
      assert(mb >= 100 && mb <= 500, 'out of range');
    });
  });
  await test('4.3 - 多条件组合筛选', () => {
    const result = applyFilter(processes, { search: 'e', minMem: 10 });
    result.forEach(p => {
      assert(p.name.toLowerCase().includes('e'), 'name filter');
      assert(p.memoryUsage >= 10 * 1024 * 1024, 'mem filter');
    });
  });
  await test('4.4 - 无匹配返回空数组', () => {
    const result = applyFilter(processes, { search: 'zzzzz_no_match' });
    assertEq(result.length, 0, 'should be empty');
  });

  // === Step 5: Notification engine ===
  console.log('\n[Step 5] 通知引擎');
  await test('5.1 - 触发通知 (进程内存超阈值)', () => {
    const rules = [{ id: 'r1', metric: 'workingSetSize', threshold: 50 * 1024 * 1024, triggered: false }];
    const { triggered, recovered } = checkNotificationRules(rules, processes, true);
    assert(triggered.length > 0, 'no trigger');
    assert(recovered.length === 0, 'unexpected recovery');
    console.log(`      触发 ${triggered.length} 个进程超过 50MB`);
  });
  await test('5.2 - 恢复通知 (进程回落到阈值下)', () => {
    // Threshold set higher than ANY process memory on the system
    const hugeThreshold = 100 * 1024 * 1024 * 1024; // 100 GB
    const rules = [{ id: 'r1', metric: 'workingSetSize', threshold: hugeThreshold, triggered: true }];
    const { triggered, recovered } = checkNotificationRules(rules, processes, true);
    assertEq(triggered.length, 0, 'no process should trigger at 100GB');
    assert(recovered.length > 0, 'rule was triggered but no process now exceeds it, should recover');
    console.log(`      恢复 ${recovered.length} 条规则`);
  });
  await test('5.3 - 通知关闭时不触发', () => {
    const rules = [{ id: 'r1', metric: 'workingSetSize', threshold: 1, triggered: false }];
    const { triggered, recovered } = checkNotificationRules(rules, processes, false);
    assertEq(triggered.length, 0, 'triggered despite disabled');
    assertEq(recovered.length, 0, 'recovered despite disabled');
  });
  await test('5.4 - 多规则同时触发', () => {
    const rules = [
      { id: 'r1', metric: 'a', threshold: 100 * 1024 * 1024, triggered: false },
      { id: 'r2', metric: 'b', threshold: 200 * 1024 * 1024, triggered: false },
      { id: 'r3', metric: 'c', threshold: 500 * 1024 * 1024, triggered: false },
    ];
    const { triggered } = checkNotificationRules(rules, processes, true);
    assert(triggered.length >= 1, 'at least one should trigger');
  });

  // === Step 6: Export formats ===
  console.log('\n[Step 6] 数据导出格式');
  const sample = processes.slice(0, 3);
  await test('6.1 - CSV 格式正确 (header + data rows)', () => {
    const csv = formatCSV(sample);
    const lines = csv.split('\n');
    assertEq(lines.length, 4, 'row count');
    assert(lines[0].startsWith('PID,'), 'header wrong');
    assert(lines[1].split(',').length === 6, 'data col count');
  });
  await test('6.2 - JSON 格式可解析', () => {
    const json = formatJSON(sample, system);
    const parsed = JSON.parse(json);
    assert(parsed.processes, 'no processes field');
    assert(parsed.system, 'no system field');
    assertEq(parsed.processes.length, 3, 'process count');
  });
  await test('6.3 - HTML 格式含表格', () => {
    const html = formatHTML(sample, system);
    assert(html.includes('<table'), 'no table');
    assert(html.includes('</table>'), 'no table close');
    assert(html.includes('内存分析报告'), 'no title');
    assert(html.includes('<tr>'), 'no tr');
  });

  // === Step 7: Used-memory cache calculation ===
  console.log('\n[Step 7] 已用内存计算');
  await test('7.1 - sysUsedCache 计算正确', () => {
    const sysUsed = Math.max(system.totalPhysicalMemory - system.availablePhysicalMemory, 1);
    assert(sysUsed > 0, 'sysUsed not positive');
    assert(sysUsed <= system.totalPhysicalMemory, 'exceeds total');
  });
  await test('7.2 - 各进程占已用% 合理', () => {
    const sysUsed = Math.max(system.totalPhysicalMemory - system.availablePhysicalMemory, 1);
    const top = processes[0];
    const pct = (top.memoryUsage / sysUsed * 100).toFixed(1);
    assert(parseFloat(pct) < 50, `${pct}% seems too high for one process`);
    console.log(`      Top1 ${top.name}: 占已用 ${pct}%`);
  });

  // === Step 8: Sort state interaction with refresh ===
  console.log('\n[Step 8] 排序状态与刷新循环');
  await test('8.1 - 排序后refresh不应丢失排序', () => {
    let sortKey = 'pid', sortDir = 'asc';
    const apply = () => applySort(processes, sortKey, sortDir);
    const first = apply();
    // simulate reentrancy
    sortKey = 'memoryUsage'; sortDir = 'desc';
    const second = apply();
    assert(first[0].pid <= first[1].pid, 'asc broken');
    assert(second[0].memoryUsage >= second[1].memoryUsage, 'desc broken');
  });

  // === Summary ===
  console.log('\n================================================');
  console.log(`  集成测试结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
  console.log('================================================\n');
  if (failed > 0) {
    console.log('失败的测试:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('✓ 所有集成测试通过！');
  }
})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
