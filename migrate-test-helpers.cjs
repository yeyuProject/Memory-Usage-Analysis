// One-off migration script: replace local test/assert/assertEq declarations
// in all test-*.cjs files with a single require('./test-helpers.cjs').
// Run from project root: node migrate-test-helpers.cjs

const fs = require('fs');
const path = require('path');

const TEST_FILES = [
  'test-config.cjs',
  'test-context-menu.cjs',
  'test-copytop50.cjs',
  'test-leak.cjs',
  'test-long-session.cjs',
  'test-recording.cjs',
  'test-refactor.cjs',
  'test-search.cjs',
  'test-smart-search.cjs',
  'test-snapshot.cjs',
  'test-spike.cjs',
  'test-stats-bar.cjs',
];

// The block of declarations to replace (greedy: stop at first blank line after the
// closing } of assertEq). We replace the whole prelude with one require line.
const PRELUDE_RE = /let passed = 0, failed = 0;\nconst results = \[\];\n\nfunction test\(name, fn\) \{[\s\S]*?function assertEq\(actual, expected, msg\) \{[\s\S]*?\n\}\n/;

let migrated = 0;
let skipped = 0;
for (const f of TEST_FILES) {
  const path_ = path.join(__dirname, f);
  if (!fs.existsSync(path_)) { skipped++; continue; }
  let src = fs.readFileSync(path_, 'utf8');
  if (src.includes("require('./test-helpers.cjs')")) { skipped++; continue; }
  // Match a tolerant variant of the prelude: allow for `const results = []` or `let results = []`
  const re = /let passed = 0, failed = 0;\nconst results = \[\];\n\nfunction test\([\s\S]*?\nfunction assertEq\(actual, expected, msg\) \{[\s\S]*?\n\}\n/;
  if (!re.test(src)) {
    console.log(`  [SKIP] ${f}: no standard prelude found`);
    skipped++;
    continue;
  }
  src = src.replace(re, "const { test, assert, assertEq, passed, failed, results } = require('./test-helpers.cjs');\n");
  fs.writeFileSync(path_, src, 'utf8');
  console.log(`  [OK]   ${f}`);
  migrated++;
}
console.log(`\nMigrated: ${migrated}, Skipped: ${skipped}`);