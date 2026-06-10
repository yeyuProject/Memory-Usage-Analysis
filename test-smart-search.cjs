// Integration test for smart process name matching
// Validates the compileSearchMatcher() function: substring, prefix, OR, and
// combined syntax. Backward compatibility with existing substring search.
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

// ===== Replicate compileSearchMatcher logic from renderer.js =====
// New API: compileSearchMatcher(term) returns a closure (or null) that runs
// in O(orParts) per process instead of re-parsing the term for every process.
function compileSearchMatcher(term) {
  if (!term) return null;
  const orParts = term.split(';').map(s => s.trim()).filter(Boolean);
  if (orParts.length === 0) return null;
  const compiled = orParts.map(part => {
    if (part.endsWith('*')) {
      return { kind: 'prefix', value: part.slice(0, -1) };
    }
    return { kind: 'substring', value: part };
  });
  return (p) => {
    const name = p.name.toLowerCase();
    const pidStr = String(p.pid);
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (c.kind === 'prefix') {
        if (name.startsWith(c.value) || pidStr.startsWith(c.value)) return true;
      } else {
        if (name.includes(c.value) || pidStr.includes(c.value)) return true;
      }
    }
    return false;
  };
}

// Helper: test if a term matches a process (matches new API).
function matches(term, p) {
  const m = compileSearchMatcher(term);
  return m ? m(p) : true;  // null matcher = match all
}

// Mock process data
const procs = [
  { pid: 1, name: 'chrome', memoryUsage: 100 },
  { pid: 2, name: 'chrome_helper', memoryUsage: 50 },
  { pid: 3, name: 'msedge', memoryUsage: 80 },
  { pid: 4, name: 'Code', memoryUsage: 200 },
  { pid: 5, name: 'powershell', memoryUsage: 60 },
  { pid: 6, name: 'svchost', memoryUsage: 30 },
  { pid: 7, name: 'Node', memoryUsage: 90 },
  { pid: 8, name: 'node_helper', memoryUsage: 40 },
  { pid: 1234, name: 'weird', memoryUsage: 10 },
  { pid: 5678, name: 'another', memoryUsage: 20 },
];

(async () => {
  console.log('\n=== 智能进程名匹配测试 ===\n');

  // ============ Backward compat (5) ============
  console.log('-- 向后兼容 (substring) --');
  await test('空term → 全部匹配', () => {
    assert(matches('', procs[0]));
    assert(matches(null, procs[0]));
  });
  await test('普通子串匹配 (chrome)', () => {
    assert(matches('chrome', procs[0]));   // chrome
    assert(matches('chrome', procs[1]));   // chrome_helper
    assert(!matches('chrome', procs[2]));  // msedge
  });
  await test('大小写不敏感 (CHROME)', () => {
    // renderer lowercases the term before calling; we mimic that
    assert(matches('chrome', procs[0]));  // chrome
    assert(matches('code', procs[3]));    // Code
  });
  await test('PID 也能匹配 (1234)', () => {
    assert(matches('1234', procs[8]));  // pid=1234
    assert(!matches('1234', procs[9]));  // pid=5678
  });
  await test('部分PID匹配 (567)', () => {
    assert(matches('567', procs[9]));  // pid=5678 contains "567"
  });

  // ============ Prefix matching (6) ============
  console.log('\n-- 前缀匹配 chrome* --');
  await test('chrome* 只匹配以chrome开头的', () => {
    assert(matches('chrome*', procs[0]));   // chrome
    assert(matches('chrome*', procs[1]));   // chrome_helper
    assert(!matches('chrome*', procs[2]));  // msedge
    assert(!matches('chrome*', procs[3]));  // Code
  });
  await test('code* 大小写不敏感', () => {
    // Term is already lowercased by caller
    assert(matches('code*', procs[3]));  // Code
  });
  await test('node* 匹配所有node开头的', () => {
    assert(matches('node*', procs[6]));  // Node
    assert(matches('node*', procs[7]));  // node_helper
    assert(!matches('node*', procs[4])); // powershell
  });
  await test('pid* 也能前缀匹配', () => {
    assert(matches('1234*', procs[8]));  // pid=1234
    assert(!matches('1234*', procs[9])); // pid=5678
  });
  await test('* 单独使用 → 必须以空字符串开头 → 全部匹配', () => {
    // Edge case: just "*" means "starts with empty string" = always true
    assert(matches('*', procs[0]));
    assert(matches('*', procs[9]));
  });
  await test('chrome* 不匹配包含但不以chrome开头的', () => {
    // "msedge" doesn't contain "chrome" as a prefix
    assert(!matches('chrome*', procs[2]));
  });

  // ============ OR matching (6) ============
  console.log('\n-- OR 匹配 chrome;code --');
  await test('chrome;code → 任一匹配即可', () => {
    assert(matches('chrome;code', procs[0]));  // chrome
    assert(matches('chrome;code', procs[1]));  // chrome_helper
    assert(matches('chrome;code', procs[3]));  // Code
    assert(!matches('chrome;code', procs[2])); // msedge
    assert(!matches('chrome;code', procs[5])); // svchost
  });
  await test('多关键字 OR (chrome;code;node)', () => {
    assert(matches('chrome;code;node', procs[0]));  // chrome
    assert(matches('chrome;code;node', procs[3]));  // Code
    assert(matches('chrome;code;node', procs[6]));  // Node
    assert(matches('chrome;code;node', procs[7]));  // node_helper
    assert(!matches('chrome;code;node', procs[2])); // msedge
  });
  await test('分号带空格 → trim后正常', () => {
    assert(matches('chrome ; code', procs[0]));  // chrome
    assert(matches('chrome ; code', procs[3]));  // Code
  });
  await test('空分号片段被忽略 (chrome;;)', () => {
    assert(matches('chrome;;', procs[0]));  // chrome
    assert(!matches('chrome;;', procs[2])); // msedge (empty part ignored, only "chrome" checked)
  });
  await test('全部无匹配 → false', () => {
    assert(!matches('xxx;yyy;zzz', procs[0]));
  });
  await test('分号 + PID 混合', () => {
    assert(matches('chrome;1234', procs[0]));  // chrome
    assert(matches('chrome;1234', procs[8]));  // pid=1234
    assert(!matches('chrome;1234', procs[2])); // msedge
  });

  // ============ Combined prefix + OR (4) ============
  console.log('\n-- 组合 chrome*;code* --');
  await test('chrome*;code* 匹配两者之一', () => {
    assert(matches('chrome*;code*', procs[0]));  // chrome
    assert(matches('chrome*;code*', procs[1]));  // chrome_helper
    assert(matches('chrome*;code*', procs[3]));  // Code
    assert(!matches('chrome*;code*', procs[2])); // msedge
  });
  await test('node*;chrome* 组合', () => {
    assert(matches('node*;chrome*', procs[0]));  // chrome
    assert(matches('node*;chrome*', procs[6]));  // Node
    assert(!matches('node*;chrome*', procs[3])); // Code
  });
  await test('混合 prefix 和 substring (chrome*;code)', () => {
    assert(matches('chrome*;code', procs[0]));  // chrome (prefix)
    assert(matches('chrome*;code', procs[3]));  // Code (substring)
    assert(!matches('chrome*;code', procs[2])); // msedge
  });
  await test('分号 + PID 前缀 (1234*;5*)', () => {
    assert(matches('1234*;5*', procs[8]));  // pid=1234
    assert(matches('1234*;5*', procs[9]));  // pid=5678 (5*)
    assert(!matches('1234*;5*', procs[0])); // chrome
  });

  // ============ Source-level checks (4) ============
  console.log('\n-- 源码检查 --');
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 compileSearchMatcher 函数', () => {
    assert(/function\s+compileSearchMatcher\s*\(/.test(renderer));
  });
  await test('renderer getFilteredProcesses 调用 compileSearchMatcher', () => {
    const fn = renderer.match(/function getFilteredProcesses\([\s\S]*?\n\}/);
    assert(fn, 'getFilteredProcesses not found');
    assert(/compileSearchMatcher\(/.test(fn[0]));
  });
  await test('renderer 支持 * 后缀 (prefix match)', () => {
    assert(/endsWith\(['"]\*['"]\)/.test(renderer));
  });
  await test('renderer 支持 ; 分隔 (OR match)', () => {
    assert(/\.split\(['"];['"]\)/.test(renderer));
  });

  // ============ Syntax ============
  console.log('\n-- 语法检查 --');
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
})();
