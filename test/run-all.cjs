// Run all test suites and report a combined pass/fail summary.
// Exits 0 only if every suite passes. Use in CI.
//
// Usage: node test/run-all.cjs
//   or:  npm test

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SUITES = [
  'test-spike.cjs',
  'test-leak.cjs',
  'test-context-menu.cjs',
  'test-search.cjs',
  'test-smart-search.cjs',
  'test-long-session.cjs',
  'test-recording.cjs',
  'test-config.cjs',
  'test-snapshot.cjs',
  'test-copytop50.cjs',
  'test-stats-bar.cjs',
  'test-refactor.cjs',
];

let totalSuites = 0;
let passed = 0;
let failed = 0;
const failures = [];

for (const suite of SUITES) {
  const path_ = path.join(__dirname, '..', suite);
  if (!fs.existsSync(path_)) {
    console.log(`  [SKIP] ${suite} (not found)`);
    continue;
  }
  totalSuites++;
  process.stdout.write(`  ${suite} ... `);
  try {
    execFileSync('node', [path_], { stdio: 'pipe', cwd: path.join(__dirname, '..') });
    process.stdout.write('OK\n');
    passed++;
  } catch (e) {
    process.stdout.write('FAIL\n');
    failed++;
    failures.push(suite);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Suites: ${totalSuites}, Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.log('Failed suites:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All suites green ✓');
