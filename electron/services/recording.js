// Persistent recording service.
//
// Recordings are stored as JSONL (one JSON sample per line) in
// userData/recordings/. System-wide recording captures top-N processes
// + system totals at each tick.
//
// File format:
//   {"header":{...metadata...}}
//   {"t":1700000000000,"sys":{...},"top":[{"pid":1234,"name":"x","mem":12345678}, ...]}
//
// Public API:
//   startRecording({interval, topN}) -> {ok, id, filePath} | {ok:false, error}
//   stopRecording()                  -> Promise<{ok, id, filePath, sampleCount}>
//   getStatus()                       -> {active, ...} | {active:false}
//   listRecordings()                  -> [metadata items]
//   deleteRecording(id)              -> {ok} | {ok:false, error}
//   exportCsv(id)                     -> {ok, filePath} | {ok:false, error}
//   appendSample(timestamp, processes, systemInfo) -> void  (called by collector)

const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');

const TOP_N_DEFAULT = 20;
const JSONL_EXT = '.jsonl';
const USER_CANCELED = '用户取消';

let recordingState = null;   // { id, startTime, interval, filePath, stream, sampleCount }

/**
 * Get the absolute path to the recordings directory under userData.
 * @returns {string}
 */
function getRecordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
}

/**
 * Create the recordings directory if it doesn't already exist.
 * @returns {string} the directory path
 */
function ensureRecordingsDir() {
  const dir = getRecordingsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Build the per-tick JSON payload (top-N processes + system memory) and
 * write it to the active recording stream as one JSONL line.
 * No-op if no recording is active.
 * @param {number} timestamp - ms since epoch (Date.now())
 * @param {Array<{pid:number,name:string,memoryUsage:number}>} processes
 * @param {{totalMemory:number,usedMemory:number,freeMemory:number}} systemInfo
 */
function appendSample(timestamp, processes, systemInfo) {
  if (!recordingState || !recordingState.stream) return;
  try {
    const top = [...processes]
      .sort((a, b) => b.memoryUsage - a.memoryUsage)
      .slice(0, recordingState.topN)
      .map(p => ({ pid: p.pid, name: p.name, mem: p.memoryUsage }));
    const sample = {
      t: timestamp,
      sys: {
        totalMem: systemInfo.totalMemory,
        usedMem: systemInfo.usedMemory,
        freeMem: systemInfo.freeMemory,
      },
      top,
    };
    recordingState.stream.write(JSON.stringify(sample) + '\n');
    recordingState.sampleCount++;
  } catch (e) {
    console.error('recording write failed:', e.message);
  }
}

/**
 * Start a new recording. Writes the header line, opens the write stream,
 * and stores state so appendSample() knows where to write.
 * Only one recording can be active at a time.
 * @param {{interval?:number, topN?:number}} opts - interval in ms, topN count
 * @returns {{ok:true,id:string,filePath:string}|{ok:false,error:string}}
 */
function startRecording({ interval = 2000, topN = TOP_N_DEFAULT } = {}) {
  if (recordingState) {
    return { ok: false, error: '已有录制在进行中' };
  }
  const dir = ensureRecordingsDir();
  const id = 'rec_' + Date.now();
  const filePath = path.join(dir, id + JSONL_EXT);
  try {
    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    stream.write(JSON.stringify({
      header: {
        id,
        startTime: Date.now(),
        interval,
        topN,
        version: app.getVersion(),
      },
    }) + '\n');
    recordingState = { id, startTime: Date.now(), interval, topN, filePath, stream, sampleCount: 0 };
    return { ok: true, id, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Stop the active recording and close the write stream.
 * @returns {Promise<{ok:true,id:string,filePath:string,sampleCount:number}|{ok:false,error:string}>}
 */
function stopRecording() {
  if (!recordingState) return Promise.resolve({ ok: false, error: '当前未在录制' });
  const { id, filePath, sampleCount } = recordingState;
  return new Promise(resolve => {
    recordingState.stream.end(() => {
      recordingState = null;
      resolve({ ok: true, id, filePath, sampleCount });
    });
  });
}

/**
 * Return the current recording status. Used by the renderer footer to
 * show a live counter, and by the IPC handler to mirror state across reloads.
 * @returns {{active:false}|{active:true,id:string,startTime:number,...}}
 */
function getStatus() {
  if (!recordingState) return { active: false };
  return {
    active: true,
    id: recordingState.id,
    startTime: recordingState.startTime,
    interval: recordingState.interval,
    topN: recordingState.topN,
    sampleCount: recordingState.sampleCount,
    filePath: recordingState.filePath,
  };
}

/**
 * Read header + tail of every .jsonl file in the recordings dir and return
 * metadata items sorted newest-first. Expensive on huge files but
 * recordings are typically small (1-2MB) so this is fine.
 * @returns {Array<{id:string,filePath:string,startTime:number,...}>}
 */
function listRecordings() {
  const dir = ensureRecordingsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(JSONL_EXT));
  const items = [];
  for (const f of files) {
    const filePath = path.join(dir, f);
    try {
      const stat = fs.statSync(filePath);
      const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
      const header = JSON.parse(firstLine).header || {};
      const all = fs.readFileSync(filePath, 'utf8').trim().split('\n');
      let endTime = header.startTime;
      let sampleCount = 0;
      for (let i = 1; i < all.length; i++) {
        try {
          const s = JSON.parse(all[i]);
          endTime = s.t || endTime;
          sampleCount++;
        } catch {}
      }
      items.push({
        id: header.id || f.replace(JSONL_EXT, ''),
        filePath,
        startTime: header.startTime || stat.birthtimeMs,
        endTime,
        interval: header.interval || 0,
        topN: header.topN || TOP_N_DEFAULT,
        sampleCount,
        sizeBytes: stat.size,
      });
    } catch (e) {
      items.push({ id: f, filePath, error: e.message, sizeBytes: 0 });
    }
  }
  items.sort((a, b) => b.startTime - a.startTime);
  return items;
}

/**
 * Delete a recording file from disk.
 * @param {string} id - recording id (matches {id}.jsonl filename)
 * @returns {{ok:true}|{ok:false,error:string}}
 */
function deleteRecording(id) {
  const filePath = path.join(getRecordingsDir(), id + JSONL_EXT);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { ok: true };
    }
    return { ok: false, error: '文件不存在' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Convert a JSONL recording to a flat CSV. Shows a save dialog so the
 * user picks the destination. Reads the whole file into memory
 * (recordings are small ~1.4MB/hr) then writes to the chosen path.
 * Wide CSV format: timestamp, system_used/total/free, then rank columns
 * (r0_pid, r0_name, r0_mem, r1_pid, ...).
 * @param {string} id - recording id
 * @param {BrowserWindow} parentWindow - parent for the save dialog
 * @returns {Promise<{ok:true,filePath:string}|{ok:false,error:string}>}
 */
async function exportCsv(id, parentWindow) {
  const filePath = path.join(getRecordingsDir(), id + JSONL_EXT);
  if (!fs.existsSync(filePath)) return { ok: false, error: '录制不存在' };
  const { filePath: outPath, canceled } = await dialog.showSaveDialog(parentWindow, {
    title: '导出为 CSV',
    defaultPath: id + '.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !outPath) return { ok: false, error: USER_CANCELED };
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const header = JSON.parse(lines[0]).header || {};
    const N = header.topN || TOP_N_DEFAULT;
    const cols = ['timestamp', 'system_used', 'system_total', 'system_free'];
    for (let i = 0; i < N; i++) cols.push(`r${i}_pid`, `r${i}_name`, `r${i}_mem`);
    const rows = [cols.join(',')];
    const csvEscape = v => {
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const s = JSON.parse(line);
      const row = [
        new Date(s.t).toISOString(),
        s.sys.usedMem || 0,
        s.sys.totalMem || 0,
        s.sys.freeMem || 0,
      ];
      for (let j = 0; j < N; j++) {
        const p = s.top[j];
        row.push(p ? p.pid : '', p ? p.name : '', p ? p.mem : 0);
      }
      rows.push(row.map(csvEscape).join(','));
    }
    fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
    return { ok: true, filePath: outPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  TOP_N_DEFAULT,
  startRecording,
  stopRecording,
  getStatus,
  listRecordings,
  deleteRecording,
  exportCsv,
  appendSample,
};
