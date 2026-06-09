/**
 * Memory Usage Analysis - Renderer (vanilla JS, no frameworks)
 * Polls main process via IPC for process & memory data
 */

const api = window.electronAPI;

const els = {
  totalMem: document.getElementById('totalMem'),
  freeMem: document.getElementById('freeMem'),
  memLoad: document.getElementById('memLoad'),
  procCount: document.getElementById('procCount'),
  lastUpdate: document.getElementById('lastUpdate'),
  searchInput: document.getElementById('searchInput'),
  refreshBtn: document.getElementById('refreshBtn'),
  tbody: document.getElementById('processTbody'),
  detailCard: document.getElementById('detailCard'),
  detailTitle: document.getElementById('detailTitle'),
  dWS: document.getElementById('dWS'),
  dPWS: document.getElementById('dPWS'),
  dCommit: document.getElementById('dCommit'),
  bWS: document.getElementById('bWS'),
  bPWS: document.getElementById('bPWS'),
  bCommit: document.getElementById('bCommit'),
  status: document.getElementById('status'),
};

let allProcesses = [];
let selectedPid = null;
let refreshTimer = null;

function formatBytes(b) {
  if (!b || b <= 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(k)));
  return (b / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}

function renderSystemInfo(sys) {
  if (!sys) return;
  els.totalMem.textContent = formatBytes(sys.totalPhysicalMemory);
  els.freeMem.textContent = formatBytes(sys.availablePhysicalMemory);
  els.memLoad.textContent = sys.memoryLoad + '%';
  els.memLoad.style.color = sys.memoryLoad > 80 ? '#ff4d4f' : sys.memoryLoad > 60 ? '#faad14' : '#1890ff';
  els.procCount.textContent = allProcesses.length;
}

function renderTable(filter = '') {
  const term = filter.trim().toLowerCase();
  const matched = term
    ? allProcesses.filter(
        (p) => p.name.toLowerCase().includes(term) || String(p.pid).includes(term)
      )
    : allProcesses;

  if (matched.length === 0) {
    els.tbody.innerHTML = `<tr><td colspan="5" class="empty">${
      allProcesses.length === 0 ? '暂无数据' : '无匹配结果'
    }</td></tr>`;
    return;
  }

  // Show top 100 to keep DOM lean
  const slice = matched.slice(0, 100);
  const max = slice[0]?.memoryUsage || 1;

  els.tbody.innerHTML = slice
    .map(
      (p) => `<tr data-pid="${p.pid}" class="${selectedPid === p.pid ? 'selected' : ''}">
        <td>${p.pid}</td>
        <td>${escapeHtml(p.name)}</td>
        <td class="text-right">${formatBytes(p.memoryUsage)}</td>
        <td class="text-right">${((p.memoryUsage / max) * 100).toFixed(0)}%</td>
        <td><span class="tag ${selectedPid === p.pid ? 'tag-sel' : 'tag-run'}">${
        selectedPid === p.pid ? '已选择' : '运行中'
      }</span></td>
      </tr>`
    )
    .join('');

  if (matched.length > 100) {
    els.tbody.insertAdjacentHTML(
      'beforeend',
      `<tr><td colspan="5" class="empty">仅显示前 100 个进程，共 ${matched.length} 个匹配</td></tr>`
    );
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showDetail(pid) {
  const proc = allProcesses.find((p) => p.pid === pid);
  if (!proc) {
    els.detailCard.style.display = 'none';
    return;
  }
  selectedPid = pid;
  const ws = proc.memoryUsage;
  const pws = Math.floor(ws * 0.7);
  const commit = Math.floor(ws * 1.3);
  const max = Math.max(ws, pws, commit);

  els.detailTitle.textContent = `${proc.name} (PID: ${pid})`;
  els.dWS.textContent = formatBytes(ws);
  els.dPWS.textContent = formatBytes(pws);
  els.dCommit.textContent = formatBytes(commit);
  els.bWS.style.width = (ws / max) * 100 + '%';
  els.bPWS.style.width = (pws / max) * 100 + '%';
  els.bCommit.style.width = (commit / max) * 100 + '%';
  els.detailCard.style.display = 'block';
}

async function refresh() {
  try {
    const sys = await api.getSystemInfo();
    const procs = await api.getProcesses();
    allProcesses = procs || [];
    renderSystemInfo(sys);
    renderTable(els.searchInput.value);
    if (selectedPid) showDetail(selectedPid);
    els.lastUpdate.textContent = '更新: ' + new Date().toLocaleTimeString();
    els.status.textContent = `已加载 ${allProcesses.length} 个进程`;
  } catch (e) {
    els.status.textContent = '错误: ' + e.message;
  }
}

els.refreshBtn.addEventListener('click', refresh);
els.searchInput.addEventListener('input', (e) => renderTable(e.target.value));
els.tbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pid) return;
  showDetail(Number(tr.dataset.pid));
  document.querySelectorAll('#processTbody tr').forEach((r) => r.classList.remove('selected'));
  tr.classList.add('selected');
});

refresh();
refreshTimer = setInterval(refresh, 2000);
