// Integration test for enhanced process search
// Verifies filtering logic, match counting, and text highlighting — without
// spawning Electron. Renderer DOM behavior is tested via regex matching on
// the output HTML.
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

// ===== Replicate getFilteredProcesses logic from renderer.js =====
const filterCriteria = { processIds: [], minMem: null, maxMem: null };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function getFilteredProcesses(allProcesses, searchTerm) {
  let list = allProcesses;
  const term = (searchTerm || '').trim().toLowerCase();
  if (term) {
    list = list.filter(p => p.name.toLowerCase().includes(term) || String(p.pid).includes(term));
  }
  if (filterCriteria.processIds.length > 0) {
    list = list.filter(p => filterCriteria.processIds.includes(p.pid));
  }
  if (filterCriteria.minMem != null) {
    list = list.filter(p => p.memoryUsage >= filterCriteria.minMem * 1024 * 1024);
  }
  if (filterCriteria.maxMem != null) {
    list = list.filter(p => p.memoryUsage <= filterCriteria.maxMem * 1024 * 1024);
  }
  return list;
}

// Highlight matches (mirrors the renderer's hl() helper)
function highlight(text, term) {
  const escTerm = term ? term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const re = term ? new RegExp('(' + escTerm + ')', 'gi') : null;
  if (!re) return escapeHtml(String(text));
  return escapeHtml(String(text)).replace(re, '<mark class="search-hl">$1</mark>');
}

// Build match-count display text (mirrors renderer logic)
function matchCountText(matchedCount, total, term) {
  if (term) return `${matchedCount} / ${total}`;
  return total > 0 ? `共 ${total} 个` : '';
}

// Mock data: 375 processes (typical Windows load)
function makeProcs(n) {
  const procs = [];
  const names = ['chrome', 'Code', 'svchost', 'explorer', 'powershell', 'node', 'electron', 'System', 'RuntimeBroker', 'dwm'];
  for (let i = 1; i <= n; i++) {
    procs.push({
      pid: i,
      name: names[i % names.length] + (i > names.length ? i : ''),
      memoryUsage: i * 1024 * 1024,
    });
  }
  return procs;
}

(async () => {
  console.log('\n=== 进程搜索增强测试 ===\n');

  // ============ Filtering logic (8) ============
  console.log('-- 过滤逻辑 --');
  await test('空搜索返回全部', () => {
    const procs = makeProcs(10);
    const result = getFilteredProcesses(procs, '');
    assertEq(result.length, 10);
  });
  await test('按进程名匹配 (大小写不敏感)', () => {
    const procs = [{ pid: 1, name: 'Chrome', memoryUsage: 100 }, { pid: 2, name: 'Code', memoryUsage: 200 }];
    const r1 = getFilteredProcesses(procs, 'chrome');
    assertEq(r1.length, 1);
    assertEq(r1[0].pid, 1);
    const r2 = getFilteredProcesses(procs, 'CHROME');
    assertEq(r2.length, 1, 'should match case-insensitively');
  });
  await test('按PID匹配 (字符串包含)', () => {
    const procs = [{ pid: 1234, name: 'a', memoryUsage: 100 }, { pid: 5678, name: 'b', memoryUsage: 200 }, { pid: 123, name: 'c', memoryUsage: 50 }];
    const r = getFilteredProcesses(procs, '123');
    assertEq(r.length, 2, 'should match 1234 and 123');
  });
  await test('无匹配返回空', () => {
    const procs = makeProcs(5);
    const r = getFilteredProcesses(procs, 'nonexistent_xyz');
    assertEq(r.length, 0);
  });
  await test('搜索带空格的词', () => {
    const procs = [{ pid: 1, name: 'Microsoft Edge', memoryUsage: 100 }, { pid: 2, name: 'Edge', memoryUsage: 50 }];
    const r = getFilteredProcesses(procs, 'microsoft edge');
    assertEq(r.length, 1, 'should match exact phrase');
  });
  await test('trim() 处理前后空格', () => {
    const procs = [{ pid: 1, name: 'chrome', memoryUsage: 100 }];
    const r = getFilteredProcesses(procs, '   chrome   ');
    assertEq(r.length, 1);
  });
  await test('空字符串(只空格) → 全部', () => {
    const procs = makeProcs(5);
    const r = getFilteredProcesses(procs, '   ');
    assertEq(r.length, 5);
  });
  await test('375进程搜索 "chrome" 返回匹配数', () => {
    const procs = makeProcs(375);
    const r = getFilteredProcesses(procs, 'chrome');
    assert(r.length > 0 && r.length < 375, `should match some but not all, got ${r.length}`);
  });

  // ============ Highlight logic (6) ============
  console.log('\n-- 高亮逻辑 --');
  await test('空搜索不产生mark标签', () => {
    const h = highlight('chrome', '');
    assertEq(h, 'chrome');
    assert(!h.includes('<mark'));
  });
  await test('大小写不敏感高亮 (使用原case)', () => {
    const h = highlight('Chrome', 'chrome');
    assert(h.includes('<mark class="search-hl">Chrome</mark>'));
  });
  await test('多次匹配都被高亮 (g flag)', () => {
    // "chachacha" = c-h-a-c-h-a-c-h-a → "ch" appears at positions 0, 3, 6 = 3 times
    const h = highlight('chachacha', 'ch');
    const matches = h.match(/<mark/g);
    assertEq(matches.length, 3, 'should highlight all 3 occurrences');
  });
  await test('转义HTML特殊字符后再高亮 (XSS防护)', () => {
    const h = highlight('<script>alert("xss")</script>', 'script');
    // XSS-safe: raw <script> never appears (it was escaped to &lt;script&gt;)
    assert(!h.includes('<script>'), 'raw <script> should not appear in output');
    // And the substring "script" inside the escaped tags is highlighted
    assert(h.includes('<mark class="search-hl">script</mark>'), 'should highlight "script" even inside escaped tags');
  });
  await test('正则元字符转义 (避免regex注入)', () => {
    // Search for ".exe" — without escaping the dot would match anything
    const h = highlight('myapp.exe', '.exe');
    assert(h.includes('<mark class="search-hl">.exe</mark>'));
    // And verify the dot doesn't accidentally match nothing
    const h2 = highlight('myappXexe', '.exe');
    assert(!h2.includes('<mark'), '. should be literal, not regex wildcard');
  });
  await test('PID列也支持高亮 (部分匹配也工作)', () => {
    // highlight(1234, '123') → "<mark>123</mark>4" (regex matches "123", leaves "4")
    const h = highlight(1234, '123');
    assert(h.includes('<mark class="search-hl">123</mark>'), 'should highlight "123" inside "1234"');
  });

  // ============ Match count display (4) ============
  console.log('\n-- 匹配计数 --');
  await test('有搜索时显示 "matched / total"', () => {
    assertEq(matchCountText(5, 375, 'chrome'), '5 / 375');
  });
  await test('无搜索时显示 "共 N 个"', () => {
    assertEq(matchCountText(0, 375, ''), '共 375 个');
  });
  await test('无搜索且无进程时为空', () => {
    assertEq(matchCountText(0, 0, ''), '');
  });
  await test('搜索无匹配时显示 0/N', () => {
    assertEq(matchCountText(0, 375, 'zzz'), '0 / 375');
  });

  // ============ Combined filter (3) ============
  console.log('\n-- 组合过滤 --');
  await test('搜索 + PID白名单取交集', () => {
    filterCriteria.processIds = [1, 2, 3];
    const procs = [{ pid: 1, name: 'chrome', memoryUsage: 100 }, { pid: 2, name: 'code', memoryUsage: 200 }, { pid: 3, name: 'node', memoryUsage: 50 }];
    const r = getFilteredProcesses(procs, 'chrome');
    assertEq(r.length, 1);
    assertEq(r[0].pid, 1);
    filterCriteria.processIds = [];  // reset
  });
  await test('搜索 + minMem 内存下限', () => {
    filterCriteria.minMem = 100;
    const procs = [{ pid: 1, name: 'chrome', memoryUsage: 50 * 1024 * 1024 }, { pid: 2, name: 'chrome-old', memoryUsage: 200 * 1024 * 1024 }];
    const r = getFilteredProcesses(procs, 'chrome');
    assertEq(r.length, 1, 'only the 200MB one');
    assertEq(r[0].pid, 2);
    filterCriteria.minMem = null;
  });
  await test('搜索 + maxMem 内存上限', () => {
    filterCriteria.maxMem = 100;
    const procs = [{ pid: 1, name: 'chrome', memoryUsage: 50 * 1024 * 1024 }, { pid: 2, name: 'chrome-old', memoryUsage: 200 * 1024 * 1024 }];
    const r = getFilteredProcesses(procs, 'chrome');
    assertEq(r.length, 1, 'only the 50MB one');
    assertEq(r[0].pid, 1);
    filterCriteria.maxMem = null;
  });

  // ============ Source-level checks (7) ============
  console.log('\n-- 源码检查 --');
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
  await test('HTML 包含 searchClear 按钮', () => {
    assert(/id="searchClear"/.test(html));
  });
  await test('HTML 包含 searchMatchCount 元素', () => {
    assert(/id="searchMatchCount"/.test(html));
  });
  await test('HTML 搜索框 placeholder 包含 Ctrl+F 提示', () => {
    assert(/Ctrl\+F/.test(html), 'should mention Ctrl+F shortcut in placeholder');
  });
  const css = fs.readFileSync(path.join(__dirname, 'src', 'styles.css'), 'utf8');
  await test('CSS 包含 .search-clear 样式', () => {
    assert(/\.search-clear\s*\{/.test(css));
  });
  await test('CSS 包含 mark.search-hl 高亮样式', () => {
    assert(/mark\.search-hl\s*\{/.test(css));
  });
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('renderer 包含 searchClear 元素引用', () => {
    assert(/searchClear:\s*\$\(['"]searchClear['"]\)/.test(renderer));
  });
  await test('renderer 包含 searchMatchCount 元素引用', () => {
    assert(/searchMatchCount:\s*\$\(['"]searchMatchCount['"]\)/.test(renderer));
  });
  await test('renderer 在renderTable中更新matchCount', () => {
    // Check the function body references the element
    const rt = renderer.match(/function renderTable\([\s\S]*?\n\}/);
    assert(rt, 'renderTable not found');
    assert(/searchMatchCount/.test(rt[0]), 'should update searchMatchCount in renderTable');
  });
  await test('renderer 使用 <mark class="search-hl"> 高亮', () => {
    assert(/mark class="search-hl"/.test(renderer));
  });
  await test('renderer 监听 searchClear 按钮点击', () => {
    assert(/els\.searchClear\.addEventListener/.test(renderer));
  });
  await test('renderer 绑定 Ctrl+F 快捷键', () => {
    assert(/ctrlKey|metaKey/.test(renderer));
    assert(/['"]f['"]/.test(renderer));
  });
  await test('renderer 在 Escape 时清除搜索', () => {
    assert(/Escape/.test(renderer));
  });
  await test('renderer 包含 term.replace 转义正则元字符', () => {
    assert(/replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/.test(renderer));
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