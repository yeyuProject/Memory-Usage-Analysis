// Integration test for configurable thresholds & persistent config
// Verifies config schema, sanitization, persistence, defaults, and dynamic
// threshold application logic — all without spawning Electron.
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// ===== Mirror of main.cjs config logic =====
const DEFAULT_CONFIG = {
  spikeThreshold: 50,
  leakThreshold: 30,
  recordingTopN: 20,
  recordingInterval: 2000,
  notificationCooldown: 60,
};

function sanitizeConfig(patch) {
  const out = {};
  if (typeof patch.spikeThreshold === 'number' && Number.isFinite(patch.spikeThreshold)) {
    out.spikeThreshold = Math.min(500, Math.max(5, Math.round(patch.spikeThreshold)));
  }
  if (typeof patch.leakThreshold === 'number' && Number.isFinite(patch.leakThreshold)) {
    out.leakThreshold = Math.min(500, Math.max(1, Math.round(patch.leakThreshold)));
  }
  if (typeof patch.recordingTopN === 'number' && Number.isFinite(patch.recordingTopN)) {
    out.recordingTopN = Math.min(50, Math.max(5, Math.round(patch.recordingTopN)));
  }
  if (typeof patch.recordingInterval === 'number' && Number.isFinite(patch.recordingInterval)) {
    out.recordingInterval = Math.min(60000, Math.max(1000, Math.round(patch.recordingInterval)));
  }
  if (typeof patch.notificationCooldown === 'number' && Number.isFinite(patch.notificationCooldown)) {
    out.notificationCooldown = Math.min(3600, Math.max(0, Math.round(patch.notificationCooldown)));
  }
  return out;
}

function makeConfigStore(filePath) {
  return {
    filePath,
    load() {
      try {
        if (!fs.existsSync(filePath)) return { ...DEFAULT_CONFIG };
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_CONFIG, ...sanitizeConfig(parsed) };
      } catch (e) {
        return { ...DEFAULT_CONFIG };
      }
    },
    save(patch) {
      const clean = sanitizeConfig(patch);
      if (Object.keys(clean).length === 0) return { ok: false, error: '没有可保存的有效字段' };
      const next = { ...this.load(), ...clean };
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      return { ok: true, config: next };
    },
    reset() {
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      return { ok: true, config: { ...DEFAULT_CONFIG } };
    },
  };
}

const TMP = path.join(os.tmpdir(), 'mua-config-test-' + Date.now());

(async () => {
  console.log('\n=== 阈值配置持久化测试 ===\n');
  fs.mkdirSync(TMP, { recursive: true });

  // ============ Defaults & schema (5) ============
  console.log('-- 默认值与 schema --');
  await test('默认值正确', () => {
    assertEq(DEFAULT_CONFIG.spikeThreshold, 50);
    assertEq(DEFAULT_CONFIG.leakThreshold, 30);
    assertEq(DEFAULT_CONFIG.recordingTopN, 20);
    assertEq(DEFAULT_CONFIG.recordingInterval, 2000);
    assertEq(DEFAULT_CONFIG.notificationCooldown, 60);
  });
  await test('load() 在文件不存在时返回默认值', () => {
    const cfgPath = path.join(TMP, 'no-file.json');
    const store = makeConfigStore(cfgPath);
    const cfg = store.load();
    assertEq(cfg.spikeThreshold, 50);
    assertEq(cfg.leakThreshold, 30);
  });
  await test('schema 包含 5 个键', () => {
    const cfgPath = path.join(TMP, 'schema.json');
    const store = makeConfigStore(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ spikeThreshold: 75 }), 'utf8');
    const cfg = store.load();
    assertEq(Object.keys(cfg).length, 5);
    assertEq(cfg.spikeThreshold, 75);
    assertEq(cfg.leakThreshold, 30);  // defaulted
  });
  await test('未知键被 sanitize 过滤', () => {
    const cfgPath = path.join(TMP, 'unknown.json');
    const store = makeConfigStore(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ spikeThreshold: 75, evil: 'malicious' }), 'utf8');
    const cfg = store.load();
    assertEq(cfg.spikeThreshold, 75);
    assert(cfg.evil === undefined, 'unknown key should be dropped');
  });
  await test('损坏的 JSON 优雅降级到默认值', () => {
    const cfgPath = path.join(TMP, 'corrupt.json');
    fs.writeFileSync(cfgPath, '{ not valid json', 'utf8');
    const store = makeConfigStore(cfgPath);
    const cfg = store.load();
    assertEq(cfg.spikeThreshold, 50);
  });

  // ============ Sanitization / range clamping (8) ============
  console.log('\n-- 范围限制 --');
  await test('spikeThreshold < 5 钳制到 5', () => {
    assertEq(sanitizeConfig({ spikeThreshold: 1 }).spikeThreshold, 5);
    assertEq(sanitizeConfig({ spikeThreshold: 0 }).spikeThreshold, 5);
    assertEq(sanitizeConfig({ spikeThreshold: -100 }).spikeThreshold, 5);
  });
  await test('spikeThreshold > 500 钳制到 500', () => {
    assertEq(sanitizeConfig({ spikeThreshold: 1000 }).spikeThreshold, 500);
    assertEq(sanitizeConfig({ spikeThreshold: 99999 }).spikeThreshold, 500);
  });
  await test('spikeThreshold 小数四舍五入', () => {
    assertEq(sanitizeConfig({ spikeThreshold: 33.4 }).spikeThreshold, 33);
    assertEq(sanitizeConfig({ spikeThreshold: 33.6 }).spikeThreshold, 34);
  });
  await test('leakThreshold < 1 钳制到 1', () => {
    assertEq(sanitizeConfig({ leakThreshold: 0 }).leakThreshold, 1);
    assertEq(sanitizeConfig({ leakThreshold: -50 }).leakThreshold, 1);
  });
  await test('leakThreshold > 500 钳制到 500', () => {
    assertEq(sanitizeConfig({ leakThreshold: 1000 }).leakThreshold, 500);
  });
  await test('recordingTopN 钳制 5-50', () => {
    assertEq(sanitizeConfig({ recordingTopN: 2 }).recordingTopN, 5);
    assertEq(sanitizeConfig({ recordingTopN: 100 }).recordingTopN, 50);
    assertEq(sanitizeConfig({ recordingTopN: 25 }).recordingTopN, 25);
  });
  await test('recordingInterval 钳制 1000-60000', () => {
    assertEq(sanitizeConfig({ recordingInterval: 500 }).recordingInterval, 1000);
    assertEq(sanitizeConfig({ recordingInterval: 99999 }).recordingInterval, 60000);
  });
  await test('非数字值被忽略', () => {
    const out = sanitizeConfig({ spikeThreshold: 'abc', leakThreshold: null, recordingTopN: NaN });
    assert(out.spikeThreshold === undefined);
    assert(out.leakThreshold === undefined);
    assert(out.recordingTopN === undefined);
  });
  await test('Infinity 被拒绝', () => {
    const out = sanitizeConfig({ spikeThreshold: Infinity, leakThreshold: -Infinity });
    assert(out.spikeThreshold === undefined);
    assert(out.leakThreshold === undefined);
  });
  await test('空 patch 返回空对象', () => {
    const out = sanitizeConfig({});
    assertEq(Object.keys(out).length, 0);
  });

  // ============ Persistence (5) ============
  console.log('\n-- 持久化 --');
  await test('save → load 往返一致', () => {
    const cfgPath = path.join(TMP, 'rt.json');
    const store = makeConfigStore(cfgPath);
    const result = store.save({ spikeThreshold: 75, leakThreshold: 45 });
    assert(result.ok);
    const reloaded = store.load();
    assertEq(reloaded.spikeThreshold, 75);
    assertEq(reloaded.leakThreshold, 45);
  });
  await test('save 是部分更新, 不影响其他键', () => {
    const cfgPath = path.join(TMP, 'partial.json');
    const store = makeConfigStore(cfgPath);
    store.save({ spikeThreshold: 80 });
    store.save({ leakThreshold: 40 });
    const cfg = store.load();
    assertEq(cfg.spikeThreshold, 80);
    assertEq(cfg.leakThreshold, 40);
    assertEq(cfg.recordingTopN, 20);  // unchanged
  });
  await test('save 空 patch 返回错误', () => {
    const cfgPath = path.join(TMP, 'empty.json');
    const store = makeConfigStore(cfgPath);
    const result = store.save({ spikeThreshold: 'invalid' });
    assert(!result.ok);
  });
  await test('reset 恢复所有默认值', () => {
    const cfgPath = path.join(TMP, 'reset.json');
    const store = makeConfigStore(cfgPath);
    store.save({ spikeThreshold: 200, leakThreshold: 200, recordingTopN: 50 });
    store.reset();
    const cfg = store.load();
    assertEq(cfg.spikeThreshold, 50);
    assertEq(cfg.leakThreshold, 30);
    assertEq(cfg.recordingTopN, 20);
  });
  await test('文件实际写入磁盘 (非内存)', () => {
    const cfgPath = path.join(TMP, 'disk.json');
    const store = makeConfigStore(cfgPath);
    store.save({ spikeThreshold: 99 });
    // Read file directly to confirm
    const raw = fs.readFileSync(cfgPath, 'utf8');
    assert(raw.includes('"spikeThreshold": 99'), 'should be on disk as formatted JSON');
    assert(raw.includes('spikeThreshold'));
  });

  // ============ Dynamic threshold application (4) ============
  console.log('\n-- 动态应用 --');
  // Simulate the renderer's applyConfig() logic
  let SPIKE_THRESHOLD = 50;
  let LEAK_THRESHOLD = 30;
  function applyConfig(cfg) {
    SPIKE_THRESHOLD = cfg.spikeThreshold;
    LEAK_THRESHOLD = cfg.leakThreshold;
  }
  await test('applyConfig 更新 spike threshold', () => {
    applyConfig({ spikeThreshold: 75, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 });
    assertEq(SPIKE_THRESHOLD, 75);
  });
  await test('applyConfig 更新 leak threshold', () => {
    applyConfig({ spikeThreshold: 50, leakThreshold: 60, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 });
    assertEq(LEAK_THRESHOLD, 60);
  });
  await test('新阈值立即影响判定', () => {
    applyConfig({ spikeThreshold: 25, leakThreshold: 20, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 });
    // A 30% spike now passes the lowered threshold
    const spikePercent = 30;
    assert(Math.abs(spikePercent) >= SPIKE_THRESHOLD);
    // A 22% leak now passes
    const leakPercent = 22;
    assert(leakPercent >= LEAK_THRESHOLD);
  });
  await test('原始阈值会被新值覆盖 (不是叠加)', () => {
    applyConfig({ spikeThreshold: 50, leakThreshold: 30, recordingTopN: 20, recordingInterval: 2000, notificationCooldown: 60 });
    applyConfig({ spikeThreshold: 10, leakThreshold: 10, recordingTopN: 5, recordingInterval: 1000, notificationCooldown: 0 });
    assertEq(SPIKE_THRESHOLD, 10);
    assertEq(LEAK_THRESHOLD, 10);
  });

  // ============ Source-level checks (5) ============
  console.log('\n-- 源码检查 --');
  const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
  await test('main.cjs 包含 DEFAULT_CONFIG', () => {
    assert(/const DEFAULT_CONFIG\s*=/.test(main));
  });
  await test('main.cjs 包含 sanitizeConfig', () => {
    assert(/function\s+sanitizeConfig\s*\(/.test(main));
  });
  await test('main.cjs 包含 get-config IPC', () => {
    assert(/ipcMain\.handle\(['"]get-config['"]/.test(main));
  });
  await test('main.cjs 包含 set-config IPC', () => {
    assert(/ipcMain\.handle\(['"]set-config['"]/.test(main));
  });
  await test('main.cjs 包含 reset-config IPC', () => {
    assert(/ipcMain\.handle\(['"]reset-config['"]/.test(main));
  });
  const preload = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');
  await test('preload 暴露 3 个 config API', () => {
    assert(/getConfig:/.test(preload));
    assert(/setConfig:/.test(preload));
    assert(/resetConfig:/.test(preload));
  });
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
  await test('HTML 包含 cfgSpikeThreshold 输入', () => {
    assert(/id="cfgSpikeThreshold"/.test(html));
  });
  await test('HTML 包含 cfgLeakThreshold 输入', () => {
    assert(/id="cfgLeakThreshold"/.test(html));
  });
  await test('HTML 包含 cfgSave 按钮', () => {
    assert(/id="cfgSave"/.test(html));
  });
  await test('HTML 包含 cfgReset 按钮', () => {
    assert(/id="cfgReset"/.test(html));
  });
  const renderer = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
  await test('renderer 不再有 const SPIKE_THRESHOLD (改为 let)', () => {
    // After refactor: SPIKE_THRESHOLD_DEFAULT exists as const (default value),
    // but the mutable binding is let.
    assert(!/const\s+SPIKE_THRESHOLD\b/.test(renderer), 'should be let, not const');
    assert(/let\s+SPIKE_THRESHOLD\b/.test(renderer));
  });
  await test('renderer 不再有 const LEAK_THRESHOLD', () => {
    assert(!/const\s+LEAK_THRESHOLD\b/.test(renderer));
    assert(/let\s+LEAK_THRESHOLD\b/.test(renderer));
  });
  await test('renderer 包含 loadConfig 函数', () => {
    assert(/async function loadConfig/.test(renderer));
  });
  await test('renderer 包含 applyConfig 函数', () => {
    assert(/function applyConfig/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.getConfig', () => {
    assert(/window\.electronAPI\.getConfig/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.setConfig', () => {
    assert(/window\.electronAPI\.setConfig/.test(renderer));
  });
  await test('renderer 调用 window.electronAPI.resetConfig', () => {
    assert(/window\.electronAPI\.resetConfig/.test(renderer));
  });
  await test('renderer 在启动时调用 loadConfig()', () => {
    assert(/^loadConfig\(\)/m.test(renderer));
  });
  await test('renderer 监听 cfgSave 按钮', () => {
    assert(/els\.cfgSave\.addEventListener/.test(renderer));
  });
  await test('renderer 监听 cfgReset 按钮', () => {
    assert(/els\.cfgReset\.addEventListener/.test(renderer));
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
  // Cleanup
  fs.readdirSync(TMP).forEach(f => fs.unlinkSync(path.join(TMP, f)));
  fs.rmdirSync(TMP);
})();