// Shared test fixtures: mock process lists, mock history, mock system.
//
// Used by 4+ test files (test-copytop50, test-recording, test-search,
// test-snapshot, plus any new test that needs realistic process data).
//
// Two process generators:
//   makeProcs(n)              — generic "proc{i}" names, desc-sorted by memory
//   makeRealisticProcs(n)      — real Windows process names (chrome, Code,
//                                svchost, ...), asc-sorted by memory
//
// Plus:
//   makeHistory(procs, opts)   — processHistory map with spike/leak samples
//   MOCK_SYS                   — fixed system-memory object (16 GB total)

const path = require('path');

/**
 * Generate a generic process list with sequential names and descending
 * memory. Used by tests that don't care about names.
 * @param {number} n - process count
 * @returns {Array<{pid:number,name:string,memoryUsage:number}>}
 */
function makeProcs(n) {
  const procs = [];
  for (let i = 1; i <= n; i++) {
    procs.push({
      pid: i,
      name: 'proc' + i,
      memoryUsage: (n - i + 1) * 10 * 1024 * 1024, // 10 MB × (n - i + 1) → sorted desc
    });
  }
  return procs;
}

const REAL_NAMES = [
  'chrome', 'Code', 'svchost', 'explorer', 'powershell',
  'node', 'electron', 'System', 'RuntimeBroker', 'dwm',
];

/**
 * Generate a realistic process list with Windows process names cycling
 * through the array. Used by tests that exercise name-based search.
 * Memory is ascending so PIDs are not in memory order (tests should sort
 * if they care).
 * @param {number} n - process count
 * @returns {Array<{pid:number,name:string,memoryUsage:number}>}
 */
function makeRealisticProcs(n) {
  const procs = [];
  for (let i = 1; i <= n; i++) {
    procs.push({
      pid: i,
      name: REAL_NAMES[i % REAL_NAMES.length] + (i > REAL_NAMES.length ? i : ''),
      memoryUsage: i * 1024 * 1024, // 1 MB × i → sorted asc
    });
  }
  return procs;
}

/**
 * Generate a processHistory map (mirrors main.cjs's structure).
 * @param {Array} procs - process list from makeProcs/makeRealisticProcs
 * @param {object} [opts]
 * @param {number[]} [opts.growingPids] - PIDs that should have leak samples
 * @param {number} [opts.spikeEvery=10] - every Nth proc gets a spike
 * @param {number[]} [opts.allSpikePids] - PIDs that should have spikes
 * @returns {Object} pid -> {baseline, peak, current, spikePercent, leakPercent, sampleCount, samples}
 */
function makeHistory(procs, opts = {}) {
  const growingPids = opts.growingPids || [];
  const allSpikePids = opts.allSpikePids || procs
    .filter((_, i) => i % (opts.spikeEvery || 10) === 0)
    .map(p => p.pid);
  const hist = {};
  procs.forEach(p => {
    const isGrowing = growingPids.includes(p.pid);
    const isSpike = allSpikePids.includes(p.pid);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      if (isGrowing) samples.push(p.memoryUsage + i * 5 * 1024 * 1024);
      else samples.push(p.memoryUsage);
    }
    hist[p.pid] = {
      baseline: p.memoryUsage,
      peak: isSpike ? p.memoryUsage * 1.5 : p.memoryUsage,
      current: p.memoryUsage,
      spikePercent: isSpike ? 80 : 5,
      leakPercent: isGrowing ? 50 : 0,
      sampleCount: 30,
      samples,
    };
  });
  return hist;
}

/** Fixed mock system memory: 16 GB total, 8 GB used, 8 GB free. */
const MOCK_SYS = {
  totalPhysicalMemory: 16 * 1024 * 1024 * 1024,
  availablePhysicalMemory: 8 * 1024 * 1024 * 1024,
  memoryLoad: 50,
  totalMemory: 16 * 1024 * 1024 * 1024,
  usedMemory: 8 * 1024 * 1024 * 1024,
  freeMemory: 8 * 1024 * 1024 * 1024,
};

module.exports = {
  makeProcs,
  makeRealisticProcs,
  makeHistory,
  MOCK_SYS,
  REAL_NAMES,
};