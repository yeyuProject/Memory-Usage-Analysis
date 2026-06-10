// Long-running PowerShell session (REPL protocol).
//
// Instead of spawning a new powershell.exe every 2s (which costs ~430ms per
// call: process startup + .NET runtime + Get-Process), we keep ONE process
// alive and talk to it over stdin/stdout using a simple REPL protocol.
//
// Protocol (line-oriented, UTF-8):
//   Host->PS:  "COLLECT\n"  (request)
//   PS->Host:  <JSON line(s)>  (one JSON payload, possibly split across lines)
//              "READY\n"        (sentinel: end of this request's response)
//              "ERR: <msg>\n"   (error, followed by READY)
//
// The REPL is single-threaded: one request in flight at a time. Concurrent
// callers are queued. This avoids interleaving of JSON payloads from multiple
// in-flight requests, which would complicate parsing.
//
// Public API:
//   collect()             -> Promise<{processes, system}>
//   getStats()            -> diagnostic info for status bar
//   stop()                -> graceful shutdown
//   isAlive()             -> boolean
//
// The REPL bootstrap script is embedded below. Keep it in sync with
// bench-powershell.cjs (which benchmarks this exact protocol).

const { spawn } = require('child_process');

const PS_READY = 'READY';
const PS_PATH = 'powershell.exe';

let session = null;        // { proc, buffer, jsonAccum, pending, alive, stats }
const queue = [];          // queued collect() calls

// Embedded PowerShell bootstrap. Defines a Collect function and runs a REPL
// loop that reads commands from stdin and emits responses to stdout.
const PS_REPL_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Collect {
  $procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
    [PSCustomObject]@{ pid = [int]$_.Id; name = $_.ProcessName; memory = [long]$_.WorkingSet64 }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  [PSCustomObject]@{
    processes = $procs
    system = @{ total = [long]$os.TotalVisibleMemorySize * 1024; free = [long]$os.FreePhysicalMemory * 1024 }
  } | ConvertTo-Json -Compress -Depth 3
}
Write-Output '${PS_READY}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  if ($cmd -eq 'COLLECT') {
    try {
      $json = Collect
      if ($null -eq $json) { $json = '' }
      Write-Output $json
    } catch {
      Write-Output "ERR: $($_.Exception.Message)"
    }
    Write-Output '${PS_READY}'
  } elseif ($cmd -eq 'EXIT' -or $cmd -eq 'QUIT') {
    break
  }
}
`;

/**
 * Spawn a fresh PowerShell process running the REPL bootstrap script.
 * Wires stdout/stderr/exit handlers and replaces the module-level
 * `session` reference. Returns the existing session if still alive.
 * @returns {object|null} the session object, or null on spawn failure
 */
function startSession() {
  if (session && session.alive) return session;
  try {
    const proc = spawn(PS_PATH, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', PS_REPL_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session = {
      proc,
      buffer: '',
      jsonAccum: [],
      pending: null,           // { resolve, reject, startedAt }
      alive: true,
      stats: { requests: 0, errors: 0, lastDurationMs: 0 },
      startedAt: Date.now(),
      pid: proc.pid,
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', d => console.error('[ps stderr]', d.toString().trim()));
    proc.on('exit', code => {
      if (session) session.alive = false;
      if (session && session.pending) {
        const p = session.pending;
        session.pending = null;
        p.reject(new Error('PowerShell exited (code ' + code + ')'));
      }
    });
    proc.on('error', err => {
      console.error('[ps spawn error]', err.message);
      if (session) session.alive = false;
      if (session && session.pending) {
        const p = session.pending;
        session.pending = null;
        p.reject(err);
      }
    });
    return session;
  } catch (e) {
    console.error('[startSession]', e.message);
    return null;
  }
}

/**
 * Gracefully stop the PowerShell session. Tries `EXIT` command first
 * (so PowerShell can flush), then force-kills after 500ms if it
 * hasn't exited yet. Idempotent — safe to call when no session exists.
 */
function stop() {
  if (!session) return;
  session.alive = false;
  try {
    if (session.proc && !session.proc.killed) {
      try { session.proc.stdin.write('EXIT\n'); } catch {}
      setTimeout(() => {
        if (session && session.proc && !session.proc.killed) {
          try { session.proc.kill(); } catch {}
        }
      }, 500);
    }
  } catch {}
  session = null;
}

/**
 * Check if a PowerShell session is currently alive and usable.
 * @returns {boolean}
 */
function isAlive() {
  return !!(session && session.alive);
}

/**
 * Diagnostic stats for the status-bar display ("PS: 75ms | 请求 42").
 * Shows request count, error count, last round-trip latency, in-flight
 * status, and queue depth.
 * @returns {{alive:false}|{alive:true,pid:number,...}}
 */
function getStats() {
  if (!session) return { alive: false };
  return {
    alive: true,
    pid: session.pid,
    startTime: session.startedAt,
    requests: session.stats.requests,
    errors: session.stats.errors,
    lastDurationMs: session.stats.lastDurationMs,
    pending: !!session.pending,
    queueLength: queue.length,
  };
}

/**
 * stdout data handler. Accumulates chunks into a line buffer and
 * dispatches complete lines to handleLine(). Handles partial lines
 * that arrive across multiple data events.
 * @param {string} chunk - stdout chunk (utf8)
 */
function onStdout(chunk) {
  if (!session) return;
  session.buffer += chunk;
  let nl;
  while ((nl = session.buffer.indexOf('\n')) >= 0) {
    const line = session.buffer.slice(0, nl).replace(/\r$/, '');
    session.buffer = session.buffer.slice(nl + 1);
    handleLine(line);
  }
}

/**
 * State machine for one request's response. Routes each output line:
 *   'READY'        -> end of response, resolves pending promise with
 *                      accumulated JSON (or null if empty), then drains queue
 *   'ERR: <msg>'   -> error path, rejects pending promise
 *   anything else  -> JSON payload line, accumulates into jsonAccum
 *
 * NOTE: drainQueue() is called only on READY, not ERR — PowerShell
 * always sends ERR followed by READY in the same flush, and we don't
 * want to fire the queued request into an empty buffer.
 * @param {string} line - one stdout line (no trailing newline)
 */
function handleLine(line) {
  if (!session) return;
  if (line === PS_READY) {
    if (session.pending) {
      const p = session.pending;
      session.pending = null;
      const text = session.jsonAccum.join('\n').trim();
      session.jsonAccum = [];
      session.stats.lastDurationMs = Date.now() - p.startedAt;
      session.stats.requests++;
      if (!text) { p.resolve(null); }
      else {
        try { p.resolve(JSON.parse(text)); }
        catch (e) { p.reject(new Error('JSON parse failed: ' + e.message)); }
      }
    }
    // Only READY drains the queue. ERR alone does NOT drain — the subsequent
    // READY (which PowerShell always sends after ERR) will drain. This prevents
    // a subtle bug where the queued request would see an empty buffer.
    drainQueue();
    return;
  }
  if (line.startsWith('ERR: ')) {
    if (session.pending) {
      const p = session.pending;
      session.pending = null;
      session.jsonAccum = [];
      session.stats.errors++;
      p.reject(new Error(line.slice(5)));
    }
    return;
  }
  // JSON payload line (or continuation). Buffer until READY.
  if (session.pending) session.jsonAccum.push(line);
}

/**
 * Send queued collect requests while the session has no in-flight request.
 * Called after every READY (end of response). Stops on first send so
 * the REPL handles one request at a time.
 */
function drainQueue() {
  while (queue.length > 0 && session && session.alive && !session.pending) {
    const next = queue.shift();
    sendRequest(next);
  }
}

/**
 * Send one COLLECT command to the REPL and store the pending request.
 * Resets jsonAccum so the next READY only sees this response's lines.
 * On stdin write failure, rejects the pending promise immediately.
 * @param {{resolve:function,reject:function}} req - queued request
 */
function sendRequest(req) {
  session.pending = {
    resolve: req.resolve,
    reject: req.reject,
    startedAt: Date.now(),
  };
  session.jsonAccum = [];
  try {
    session.proc.stdin.write('COLLECT\n');
  } catch (e) {
    const p = session.pending;
    session.pending = null;
    p.reject(e);
  }
}

/**
 * Public API: request one data collection. Auto-starts the session if
 * needed. Concurrent callers are queued and serialized through the REPL.
 * @returns {Promise<{processes:Array,system:{total:number,free:number}}>}
 *   resolves with the parsed JSON payload, or null if no data
 */
function collect() {
  return new Promise((resolve, reject) => {
    if (!session || !session.alive) {
      const fresh = startSession();
      if (!fresh) {
        reject(new Error('PowerShell session not available'));
        return;
      }
    }
    if (session.pending) {
      queue.push({ resolve, reject });
      return;
    }
    sendRequest({ resolve, reject });
  });
}

module.exports = { collect, getStats, stop, isAlive, PS_READY, PS_PATH };