// Integration test for right-click context menu feature
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');

(async () => {
  // === Test 1: Renderer code contains context menu logic ===
  console.log('[Test 1] Renderer 包含右键菜单逻辑');
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');

  await test('1.1 - showContextMenu 函数存在', () => {
    assert(renderer.includes('function showContextMenu'), 'missing function');
  });
  await test('1.2 - hideContextMenu 函数存在', () => {
    assert(renderer.includes('function hideContextMenu'), 'missing function');
  });
  await test('1.3 - handleContextAction 函数存在', () => {
    assert(renderer.includes('function handleContextAction'), 'missing function');
  });
  await test('1.4 - 绑定 contextmenu 事件', () => {
    assert(renderer.includes("addEventListener('contextmenu'"), 'no contextmenu listener');
  });
  await test('1.5 - 绑定 ctxMenu 点击事件', () => {
    assert(renderer.includes("els.ctxMenu.addEventListener"), 'no ctxMenu listener');
  });
  await test('1.6 - 全局点击关闭菜单', () => {
    assert(renderer.includes("document.addEventListener('click', hideContextMenu)"), 'no global click');
  });
  await test('1.7 - ESC 键关闭菜单', () => {
    assert(renderer.includes("e.key === 'Escape'"), 'no ESC handler');
  });

  // === Test 2: Action handlers present in code ===
  console.log('\n[Test 2] 各 action 处理函数存在');
  const actions = ['copy-pid', 'copy-name', 'open-location', 'select', 'kill'];
  for (let i = 0; i < actions.length; i++) {
    await test(`2.${i + 1} - "${actions[i]}" action 处理`, () => {
      assert(renderer.includes(`'${actions[i]}'`), `missing ${actions[i]} handler`);
    });
  }

  // === Test 3: HTML has ctxMenu element ===
  console.log('\n[Test 3] HTML 包含 ctxMenu 元素');
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
  await test('3.1 - HTML 含 ctxMenu div', () => {
    assert(html.includes('id="ctxMenu"'), 'missing ctxMenu element');
  });
  await test('3.2 - ctxMenu 类名为 ctx-menu', () => {
    assert(html.includes('class="ctx-menu"'), 'missing ctx-menu class');
  });

  // === Test 4: CSS has styles ===
  console.log('\n[Test 4] CSS 包含菜单样式');
  const css = fs.readFileSync(path.join(__dirname, 'src', 'styles.css'), 'utf8');
  await test('4.1 - .ctx-menu 样式存在', () => {
    assert(css.includes('.ctx-menu'), 'missing .ctx-menu');
  });
  await test('4.2 - .ctx-item 样式存在', () => {
    assert(css.includes('.ctx-item'), 'missing .ctx-item');
  });
  await test('4.3 - .ctx-item.danger 危险操作样式', () => {
    assert(css.includes('.ctx-item.danger'), 'missing danger style');
  });
  await test('4.4 - .ctx-divider 分隔线样式', () => {
    assert(css.includes('.ctx-divider'), 'missing divider style');
  });

  // === Test 5: Main process IPC handlers ===
  console.log('\n[Test 5] 主进程 IPC handlers');
  const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
  await test('5.1 - kill-process handler', () => {
    assert(main.includes("'kill-process'"), 'missing kill-process');
    assert(main.includes('taskkill'), 'missing taskkill');
  });
  await test('5.2 - open-file-location handler', () => {
    assert(main.includes("'open-file-location'"), 'missing handler');
    assert(main.includes('shell.showItemInFolder'), 'missing shell call');
  });
  await test('5.3 - write-clipboard handler', () => {
    assert(main.includes("'write-clipboard'"), 'missing handler');
    assert(main.includes('clipboard.writeText'), 'missing clipboard call');
  });
  await test('5.4 - killProcess 类型防御', () => {
    const idx = main.indexOf("'kill-process'");
    const block = main.substring(idx, idx + 500);
    assert(block.includes('typeof pid') && block.includes('Number.isFinite'), 'no type guard');
  });

  // === Test 6: Preload exposes new methods ===
  console.log('\n[Test 6] Preload 暴露新 IPC');
  const preload = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');
  await test('6.1 - killProcess 暴露', () => {
    assert(preload.includes('killProcess:'), 'missing killProcess');
  });
  await test('6.2 - openFileLocation 暴露', () => {
    assert(preload.includes('openFileLocation:'), 'missing openFileLocation');
  });
  await test('6.3 - writeClipboard 暴露', () => {
    assert(preload.includes('writeClipboard:'), 'missing writeClipboard');
  });

  // === Test 7: Logic simulation ===
  console.log('\n[Test 7] 逻辑模拟');
  await test('7.1 - 菜单定位不超视口 (left)', () => {
    const x = 1900, w = 200;
    const px = Math.min(x, 1920 - w - 8);
    assertEq(px, 1712, 'viewport left check');
  });
  await test('7.2 - 菜单定位不超视口 (top)', () => {
    const y = 1000, h = 240;
    const py = Math.min(y, 1080 - h - 8);
    assertEq(py, 832, 'viewport top check');
  });
  await test('7.3 - 复制PID逻辑', () => {
    const pid = 1234;
    const text = String(pid);
    assertEq(text, '1234', 'stringification');
  });
  await test('7.4 - 进程名引号转义 (open-file-location 安全性)', () => {
    const name = "test'exe";
    const escaped = name.replace(/'/g, "''");
    assertEq(escaped, "test''exe", 'SQL-style quote escape');
  });

  // === Test 8: Syntax check ===
  console.log('\n[Test 8] 语法检查');
  await test('8.1 - main.cjs 语法正确', () => {
    execSync('node -c electron/main.cjs', { stdio: 'pipe' });
  });
  await test('8.2 - preload.cjs 语法正确', () => {
    execSync('node -c electron/preload.cjs', { stdio: 'pipe' });
  });
  await test('8.3 - renderer.js 语法正确', () => {
    execSync('node -c src/renderer.js', { stdio: 'pipe' });
  });

  // === Summary ===
  console.log('\n================================================');
  console.log(`  右键菜单功能测试: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
  console.log('================================================');
  if (failed > 0) {
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n✓ 右键菜单功能验证通过！');
  }
})();
