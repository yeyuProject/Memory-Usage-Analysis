# Architecture

## Overview

Memory Usage Analysis is a Windows desktop tool (Electron + vanilla JS)
that monitors per-process memory usage in real-time. It polls Windows
via PowerShell every2s and displays processes, spikes, leaks, charts,
notifications, and persistent recordings in a single window.

The project was refactored into a clear module structure: the main
process is split into focused services, and the renderer is split
into focused modules. All real logic lives in those modules; the
top-level `main.cjs` and `renderer.js` are thin orchestrators.

## File layout

```
electron/
  main.cjs                  (338 lines) — thin orchestrator: IPC + lifecycle
  preload.cjs               (33 lines)  — contextBridge IPC surface
  services/
    config.js               (97 lines)  — load/save/reset user config
    recording.js            (224 lines) — JSONL recording + CSV export
    ps-session.js           (242 lines) — PowerShell REPL protocol
    window.js               (37 lines)  — BrowserWindow lifecycle

src/
  index.html                (298 lines) — single-page UI, 7 tabs
  renderer.js               (331 lines) — thin orchestrator: events + refresh
  styles.css                (138 lines)
  modules/
    state.js                (127 lines) — shared mutable state
    utils.js                (71 lines)  — DOM helpers, formatters
    charts.js               (255 lines) — Canvas drawing (bar/pie/line)
    search.js               (83 lines)  — smart name matching, highlight
    process-table.js        (346 lines) — renderTable/Spikes/Leaks
    recordings.js           (216 lines) — recording IPC + clipboard
    notifications.js        (159 lines) — threshold rules + history
    export.js               (153 lines) — exportReport, snapshot
    config.js               (136 lines) — user thresholds, collector stats

test-*.cjs                  — 12 integration test suites (391/391 pass)
bench-*.cjs                 — 2 performance benchmarks
test-helpers.cjs            — shared test framework
test-fixtures.cjs           — shared mock data (procs, history, sys)
test/run-all.cjs            — CI runner
```

## Main process services

### ps-session.js — PowerShell REPL

Instead of spawning a new `powershell.exe` every2s (which costs ~430ms
of process startup + .NET runtime + Get-Process each tick), we keep
ONE process alive and talk to it over stdin/stdout via a simple REPL.

```
Protocol (line-oriented UTF-8):
  Host → PS:  "COLLECT\n"
  PS  → Host: <JSON payload, possibly multi-line>
              "READY\n"                       (end-of-response sentinel)
              "ERR: <message>\n" + "READY\n"  (error path)
```

The REPL bootstrap script is embedded in `ps-session.js` (template
literal, ~30 lines of PowerShell). Public API:

```js
const ps = require('./services/ps-session');
await ps.collect();          // returns {processes, system}
ps.getStats();               // diagnostic info for status bar
ps.stop();                   // graceful shutdown
```

The session auto-starts on first call, queues concurrent callers,
and restarts on error. See `bench-powershell.cjs` for the original
4.8x speedup benchmark.

### recording.js — persistent system recordings

Recordings are stored as JSONL files in `userData/recordings/`.
Each line is one JSON sample; the first line is the header
(id, startTime, interval, topN, appVersion).

File format:
```
{"header":{"id":"rec_...","startTime":...,"interval":2000,"topN":20,"version":"1.0.0"}}
{"t":1700000000000,"sys":{"totalMem":...,"usedMem":...,"freeMem":...},"top":[{"pid":1,"name":"chrome","mem":12345678}, ...]}
{"t":1700002000000,...}
```

At ~200 bytes per sample with default settings, a recording is
~1.4 MB/hour.

### config.js — user preferences

Persists spikeThreshold, leakThreshold, recordingTopN, recordingInterval,
and notificationCooldown to `userData/config.json`. `sanitizeConfig()`
clamps numeric values to safe ranges and silently drops invalid keys
(partial saves are still useful).

### window.js — BrowserWindow lifecycle

Single source of truth for the main window. `create()` is called once
on `app.whenReady()`. `get()` returns the live window reference for
IPC handlers that need a parent for native dialogs (save dialog,
showItemInFolder).

## IPC surface (20 channels)

```
get-processes               →  [{pid, name, memoryUsage}, ...]
get-system-info             →  {totalPhysicalMemory, availablePhysicalMemory, memoryLoad}
get-process-history         →  {pid: {baseline, peak, spikePercent, leakPercent, sampleCount}}
get-process-memory(pid)     →  {pid, name, memoryUsage, privateWorkingSetSize, commitSize}
refresh-now                 →  triggers immediate collectData()
get-app-version             →  app.getVersion()
kill-process(pid)           →  taskkill /PID <pid> /F
open-file-location(name)    →  shell.showItemInFolder(<exePath>)
write-clipboard(text)       →  clipboard.writeText(text)

start-recording             →  services/recording.startRecording(opts)
stop-recording              →  services/recording.stopRecording()
get-recording-status        →  services/recording.getStatus()
list-recordings             →  services/recording.listRecordings()
delete-recording(id)        →  services/recording.deleteRecording(id)
export-recording-csv(id)    →  shows save dialog, writes CSV

get-config / set-config / reset-config   →  services/config.*
export-history-snapshot(opts)           →  shows save dialog, writes CSV/JSON

get-collector-stats         →  services/ps-session.getStats() (live latency)
```

All IPC channels follow the same pattern: thin pass-through to a
service in `main.cjs`, with the service owning the actual state and
business logic. The collector stats channel is the diagnostic output
that powers the footer "PS: 75ms | 请求 42" indicator.

## Renderer modules

The renderer's `renderer.js` (331 lines) is a thin orchestrator. It
declares the DOM element cache, runs the `refresh()` loop, wires
event bindings, and delegates everything else to one of9 modules.

```
src/modules/
  state.js          shared mutable state (allProcesses, processHistory,
                    filterCriteria, selectedPid, etc.). Exposed via
                    getter/setter accessors so other modules can
                    mutate without prop-drilling.

  utils.js          formatBytes, formatShort, escapeHtml, showToast,
                    setStatus, $(), el(). Pure functions, no deps.

  charts.js         Canvas drawing: drawBarChart, drawPieChart,
                    drawLineChart, plus axis helpers. All take a
                    <canvas> element + data, draw in place.
                    Reentrant-guarded by isDrawing flag.

  search.js         compileSearchMatcher(term) returns a closure that
                    runs in O(orParts) per process. Cached regex
                    highlight via getHighlightRe(). 6.3x faster than
                    per-process re-parsing.

  process-table.js  renderTable() (Dashboard / Processes tab),
                    renderSpikes() (突变进程 card), renderLeaks()
                    (疑似泄漏 card). Holds the magic-number
                    constants (SPIKE_THRESHOLD_DEFAULT = 50, etc.)
                    and the COLORS palette. Provides the small
                    renderProcessRow() helper used by renderTable.

  recordings.js     start/stop/load/delete/exportRecordingCsv and
                    copyTop50ToClipboard (CSV to clipboard).

  notifications.js  Threshold-based alert rules + history. Edges
                    (rising/falling) trigger entries. History capped
                    at 20.

  export.js         exportReport() (CSV/JSON/HTML) and
                    exportHistorySnapshot() (main-process export).

  config.js         loadConfig / saveConfigFromUI / resetConfig /
                    updateCollectorStats (status-bar indicator).
```

State sharing: `state.js` uses getter/setter accessors so modules can
mutate shared state without prop-drilling. ES module live bindings
make this transparent: `a = state.someField; state.someField = v;`

No circular imports (verified by clean dependency order):
state → utils → search → process-table → recordings/notifications
→ export → config → renderer

## Data flow (refresh tick)

```
1. refresh() (in renderer.js)
2. Promise.all([getSystemInfo, getProcesses, getProcessHistory])
3. Update state.allProcesses, state.processHistory, state.systemCache
4. Cache systemCache.totalPhysicalMemory in state.sysTotalCache
5. processTable.renderTable()
6. renderDashCharts() (Canvas)
7. processTable.renderSpikes()
8. processTable.renderLeaks()
9. processTable.renderChartPage()
10. notifications.populateFilterProcesses()
11. notifications.checkNotifications()
12. config.updateCollectorStats()
```

Total time per tick on a typical Windows machine (375 processes):
**~200ms** (down from **~430ms** before the long-session REPL opt).

## Test architecture

```
test-helpers.cjs    shared { test, assert, assertEq, passed, failed }
                     — eliminates 420 lines of duplicate test boilerplate

test-fixtures.cjs   shared { makeProcs, makeRealisticProcs,
                     makeHistory, MOCK_SYS }
                     — eliminates 4 duplicate mock factories

test/*.cjs          12 integration test suites (391/391 cases passing):
   test-spike.cjs          (31)  spike detection (history/baseline)
   test-leak.cjs           (26)  leak detection (linear regression)
   test-context-menu.cjs   (32)  right-click menu actions
   test-search.cjs         (35)  search + Ctrl+F + highlight
   test-smart-search.cjs   (26)  smart matching syntax (chrome*, ;)
   test-long-session.cjs   (41)  PS REPL protocol state machine
   test-recording.cjs      (38)  JSONL recording + CSV export
   test-config.cjs         (47)  config persistence + sanitizeConfig
   test-snapshot.cjs       (35)  history snapshot export
   test-copytop50.cjs      (29)  Top-50 clipboard export
   test-stats-bar.cjs      (26)  collector stats rendering
   test-refactor.cjs       (32)  structure assertions (constants, helpers, JSDoc)

bench-*.cjs         2 performance benchmarks:
   bench-powershell.cjs    real PowerShell timing comparison
   bench-renderer.cjs      renderer hot-path profiling
```

Run all: `npm test` or `node test/run-all.cjs`

## Key optimizations

| What | Before | After | Speedup |
|---|---|---|---|
| PowerShell collector | 430ms/tick (spawn) | 75ms/tick (REPL) | **4.8x** |
| Search matcher | per-process re-parse | pre-compiled closure | **6.3x** |
| renderSpikes | two passes over procs | single pass | **2.0x** |
| Highlight regex | rebuild every render | cached by term | **13x** |
| Overall tick | 0.405ms | 0.202ms | **~50%** |

## Conventions

- **Pure CommonJS** (`require`/`module.exports`) — no ESM transpiler
- **JSDoc** on every public function — see test-refactor.cjs assertions
- **Magic numbers → named constants** at top of `process-table.js`
- **COLORS palette** instead of hex literals scattered in JSX-like strings
- **No frameworks** in renderer (vanilla JS + Canvas) — keeps bundle tiny
- **IPC contract is stable** — adding/removing services doesn't change
  the 20 channels above

## See also

- `test/run-all.cjs` — CI runner that exits non-zero if any suite fails
- `bench-renderer.cjs` — reproducible perf numbers for the hot paths
- `migrate-test-helpers.cjs` — one-off script kept for reference