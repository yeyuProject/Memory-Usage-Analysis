// Integration test for "Copy Top-50 to clipboard" feature
// Validates the CSV builder logic, top-N selection, memory formatting,
// escaping, and metadata headers — without spawning Electron.
const fs = require('fs');
const path = require('path');

const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

// ===== Replicate copyTop50ToClipboard logic from renderer.js =====
function csvEscape(v) {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildTopCsv(allProcesses, systemCache, limit = 50) {
  if (!allProcesses || allProcesses.length === 0) return null;
  const top = allProcesses.slice(0, limit);
  const cols = ['rank', 'pid', 'name', 'memoryMB', 'percentOfTotal'];
  const totalMem = systemCache ? systemCache.totalPhysicalMemory : 1;
  const lines = [cols.join(',')];
  top.forEach((p, i) => {
    lines.push([
      i + 1,
      p.pid,
      csvEscape(p.name),
      (p.memoryUsage / 1024 / 1024).toFixed(1),
      ((p.memoryUsage / totalMem) * 100).toFixed(2),
    ].join(','));
  });
  const summary = [
    `# Top ${top.length} of ${allProcesses.length} processes by memory`,
    `# System total: ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
    `# System used: ${systemCache ? ((totalMem - systemCache.availablePhysicalMemory) / 1024 / 1024 / 1024).toFixed(1) : '?'} GB`,
    `# Generated: ISO_TIMESTAMP`,
  ].join('\n');
  return summary + '\n' + lines.join('\n');
}

// Mock data
function makeProcs(n) {
  const procs = [];
  for (let i = 1; i <= n; i++) {
    procs.push({
      pid: i,
      name: 'proc' + i,
      memoryUsage: (n - i + 1) * 10 * 1024 * 1024,  // sorted descending already
    });
  }
  return procs;
}
const MOCK_SYS = {
  totalPhysicalMemory: 16 * 1024 * 1024 * 1024,  // 16 GB
  availablePhysicalMemory: 8 * 1024 * 1024 * 1024,  // 8 GB free
};

(async () => {
  console.log('\n=== 复制 Top-50 进程测试 ===\n');

  // ============ Top-N selection (5) ============
  console.log('-- Top-N 选择 --');
  await test('空进程列表返回 null', () => {
    assertEq(buildTopCsv([], MOCK_SYS), null);
  });
  await test('少于50个进程 → 全选', () => {
    const csv = buildTopCsv(makeProcs(5), MOCK_SYS);
    const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
    // 1 header + 5 data rows
    assertEq(lines.length, 6);
  });
  await test('正好50个进程 → 全选', () => {
    const csv = buildTopCsv(makeProcs(50), MOCK_SYS);
    const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
    assertEq(lines.length, 51);
  });
  await test('超过50个进程 → 只取前50', () => {
    const csv = buildTopCsv(makeProcs(375), MOCK_SYS, 50);
    const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
    assertEq(lines.length, 51, 'header + 50 data rows');
  });
  await test('按内存降序排列 (rank 1 是最大内存)', () => {
    const csv = buildTopCsv(makeProcs(10), MOCK_SYS);
    const dataLines = csv.split('\n').filter(l => l && !l.startsWith('#')).slice(1);
    // First data row should be pid=1 (highest mem in our mock)
    assert(dataLines[0].startsWith('1,1,'));
  });

  // ============ Memory formatting (4) ============
  console.log('\n-- 内存格式 --');
  await test('memoryMB 格式化为 1 位小数', () => {
    const csv = buildTopCsv([{ pid: 1, name: 'p', memoryUsage: 123.456 * 1024 * 1024 }], MOCK_SYS);
    assert(csv.includes(',123.5,'), 'should be 123.5 MB');
  });
  await test('percentOfTotal 2 位小数', () => {
    // 100 MB / 16 GB = 0.61% (percent is the last column, no trailing comma)
    const csv = buildTopCsv([{ pid: 1, name: 'p', memoryUsage: 100 * 1024 * 1024 }], MOCK_SYS);
    const dataLine = csv.split('\n').filter(l => l && !l.startsWith('#'))[1];
    assert(dataLine.endsWith(',0.61'), 'should end with ,0.61');
  });
  await test('percentOfTotal 大数值 (100%上限)', () => {
    // Process using 16 GB (all of total) → 100.00%
    const csv = buildTopCsv([{ pid: 1, name: 'p', memoryUsage: 16 * 1024 * 1024 * 1024 }], MOCK_SYS);
    const dataLine = csv.split('\n').filter(l => l && !l.startsWith('#'))[1];
    assert(dataLine.endsWith(',100.00'), 'should end with ,100.00');
  });
  await test('小内存 (<1MB) 正确显示', () => {
    // 100 KB = 0.1 MB
    const csv = buildTopCsv([{ pid: 1, name: 'tiny', memoryUsage: 100 * 1024 }], MOCK_SYS);
    assert(csv.includes(',0.1,'));
  });

  // ============ CSV escaping (4) ============
  console.log('\n-- CSV 转义 --');
  await test('name 含逗号 → 加双引号', () => {
    const csv = buildTopCsv([{ pid: 1, name: 'a,b', memoryUsage: 1024 * 1024 }], MOCK_SYS);
    assert(csv.includes('"a,b"'));
  });
  await test('name 含引号 → 双引号转义', () => {
    const csv = buildTopCsv([{ pid: 1, name: 'a"b', memoryUsage: 1024 * 1024 }], MOCK_SYS);
    assert(csv.includes('"a""b"'));
  });
  await test('name 含换行 → 加双引号', () => {
    const csv = buildTopCsv([{ pid: 1, name: 'a\nb', memoryUsage: 1024 * 1024 }], MOCK_SYS);
    assert(csv.includes('"a\nb"'));
  });
  await test('普通 name 不加引号', () => {
    const csv = buildTopCsv([{ pid: 1, name: 'normal_name-123', memoryUsage: 1024 * 1024 }], MOCK_SYS);
    assert(csv.includes(',normal_name-123,'));
  });

  // ============ Header / summary (4) ============
  console.log('\n-- 元数据 --');
  await test('包含 # Top 摘要行', () => {
    const csv = buildTopCsv(makeProcs(100), MOCK_SYS);
    assert(csv.startsWith('# Top 50 of 100 processes by memory'));
  });
  await test('包含系统总内存', () => {
    const csv = buildTopCsv(makeProcs(5), MOCK_SYS);
    assert(csv.includes('# System total: 16.0 GB'));
  });
  await test('包含系统已用内存', () => {
    const csv = buildTopCsv(makeProcs(5), MOCK_SYS);
    // 16 GB - 8 GB free = 8 GB used
    assert(csv.includes('# System used: 8.0 GB'));
  });
  await test('包含 Generated 时间戳', () => {
    const csv = buildTopCsv(makeProcs(5), MOCK_SYS);
    assert(csv.includes('# Generated: ISO_TIMESTAMP'));
  });

  // ============ Edge cases (3) ============
  console.log('\n-- 边界 --');
  await test('无 systemCache → 用 1 作分母 (避免NaN)', () => {
    // 100 MB = 104857600 bytes; divided by 1 byte = 104857600; *100 = 10485760000.00
    const csv = buildTopCsv([{ pid: 1, name: 'p', memoryUsage: 100 * 1024 * 1024 }], null);
    const dataLine = csv.split('\n').filter(l => l && !l.startsWith('#'))[1];
    assert(dataLine.endsWith(',10485760000.00'), '100MB / 1 byte = 10485760000.00% (last col)');
  });
  await test('无 systemCache → used 显示 ?', () => {
    const csv = buildTopCsv(makeProcs(3), null);
    assert(csv.includes('# System used: ? GB'));
  });
  await test('limit=0 → 返回仅header', () => {
    const csv = buildTopCsv(makeProcs(5), MOCK_SYS, 0);
    const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
    assertEq(lines.length, 1, 'just the column header');
  });

  // ============ Source-level checks (5) ============
  console.log('\n-- 源码检查 --');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
  await test('HTML 包含 copyTop50Btn', () => {
    assert(/id="copyTop50Btn"/.test(html));
  });
  await test('HTML 包含 "复制 Top50" 文本', () => {
    assert(html.includes('复制 Top50'));
  });
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 copyTop50Btn 元素引用', () => {
    assert(/copyTop50Btn:\s*\$\(['"]copyTop50Btn['"]\)/.test(renderer));
  });
  await test('renderer 包含 copyTop50ToClipboard 函数', () => {
    assert(/async function copyTop50ToClipboard/.test(renderer));
  });
  await test('renderer 监听 copyTop50Btn 按钮', () => {
    assert(/els\.copyTop50Btn\.addEventListener/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.writeClipboard', () => {
    // Already existed, but verify it's used in copyTop50
    const fn = renderer.match(/async function copyTop50ToClipboard[\s\S]*?\n\}/);
    assert(fn, 'function not found');
    assert(/window\.electronAPI\.writeClipboard/.test(fn[0]));
  });
  await test('renderer 包含 csvEscape 函数', () => {
    assert(/function csvEscape|const csvEscape/.test(renderer));
  });
  await test('renderer 使用 allProcesses.slice(0, 50)', () => {
    assert(/allProcesses\.slice\(0,\s*50\)/.test(renderer));
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