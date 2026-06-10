// Shared state for the renderer.
//
// Centralizes the module-level mutable state that was previously spread
// across renderer.js. Other modules import individual names:
//
//   const { allProcesses, processHistory, selectedPid } = require('./state');
//
// All bindings are live references — mutating them is the documented way
// to update state. A small `getState()` helper is also exported for
// code that prefers an immutable snapshot.

const api = window.electronAPI;

// ===== Processes & system =====
let allProcesses = [];          // [{pid, name, memoryUsage}, ...]
let processHistory = {};        // pid -> { baseline, peak, peakTime, current, spikePercent, leakPercent, sampleCount }
let systemCache = null;          // { totalPhysicalMemory, availablePhysicalMemory, memoryLoad, timestamp }
let sysUsedCache = 1;
let sysTotalCache = 1;

// ===== UI state =====
let selectedPid = null;
let currentTab = 'dashboard';
let sortKey = 'memoryUsage';    // current sort column
let sortDir = 'desc';           // 'asc' | 'desc'

// ===== Filter / notification =====
let filterCriteria = {
  processIds: [],
  metrics: ['workingSetSize', 'privateWorkingSetSize', 'commitSize'],
  minMem: null,
  maxMem: null,
};
let notifyRules = [];
let notifyHistory = [];
let isNotifying = false;

// ===== Recording (UI-side mirror of main-process state) =====
let recordings = [];
let activeRecording = null;     // mirrored from get-recording-status
let statusPollTimer = null;

// ===== Refresh loop =====
let refreshTimer = null;
let isRefreshing = false;
let isDrawing = false;

// ===== Cached highlight RegExp (built once per term change) =====
let _cachedHlTerm = null;
let _cachedHlRe = null;
let _lastSortKey = null;
let _lastSortDir = null;
let _sortIndicatorsDirty = true;

// Snapshot for code that prefers read-only access.
function getState() {
  return {
    allProcesses,
    processHistory,
    systemCache,
    selectedPid,
    currentTab,
    sortKey,
    sortDir,
    filterCriteria,
  };
}

module.exports = {
  api,
  // processes
  get allProcesses() { return allProcesses; },
  set allProcesses(v) { allProcesses = v; },
  get processHistory() { return processHistory; },
  set processHistory(v) { processHistory = v; },
  get systemCache() { return systemCache; },
  set systemCache(v) { systemCache = v; },
  get sysUsedCache() { return sysUsedCache; },
  set sysUsedCache(v) { sysUsedCache = v; },
  get sysTotalCache() { return sysTotalCache; },
  set sysTotalCache(v) { sysTotalCache = v; },
  // ui
  get selectedPid() { return selectedPid; },
  set selectedPid(v) { selectedPid = v; },
  get currentTab() { return currentTab; },
  set currentTab(v) { currentTab = v; },
  get sortKey() { return sortKey; },
  set sortKey(v) { sortKey = v; },
  get sortDir() { return sortDir; },
  set sortDir(v) { sortDir = v; },
  // filter/notify
  get filterCriteria() { return filterCriteria; },
  set filterCriteria(v) { filterCriteria = v; },
  get notifyRules() { return notifyRules; },
  set notifyRules(v) { notifyRules = v; },
  get notifyHistory() { return notifyHistory; },
  set notifyHistory(v) { notifyHistory = v; },
  get isNotifying() { return isNotifying; },
  set isNotifying(v) { isNotifying = v; },
  // recording
  get recordings() { return recordings; },
  set recordings(v) { recordings = v; },
  get activeRecording() { return activeRecording; },
  set activeRecording(v) { activeRecording = v; },
  get statusPollTimer() { return statusPollTimer; },
  set statusPollTimer(v) { statusPollTimer = v; },
  // refresh
  get refreshTimer() { return refreshTimer; },
  set refreshTimer(v) { refreshTimer = v; },
  get isRefreshing() { return isRefreshing; },
  set isRefreshing(v) { isRefreshing = v; },
  get isDrawing() { return isDrawing; },
  set isDrawing(v) { isDrawing = v; },
  // cache
  get _cachedHlTerm() { return _cachedHlTerm; },
  set _cachedHlTerm(v) { _cachedHlTerm = v; },
  get _cachedHlRe() { return _cachedHlRe; },
  set _cachedHlRe(v) { _cachedHlRe = v; },
  get _lastSortKey() { return _lastSortKey; },
  set _lastSortKey(v) { _lastSortKey = v; },
  get _lastSortDir() { return _lastSortDir; },
  set _lastSortDir(v) { _lastSortDir = v; },
  get _sortIndicatorsDirty() { return _sortIndicatorsDirty; },
  set _sortIndicatorsDirty(v) { _sortIndicatorsDirty = v; },
  // helpers
  getState,
};