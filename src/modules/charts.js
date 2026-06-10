// Canvas chart drawing — bar, pie, line. No external chart library.
//
// Each draw function takes a <canvas> element + data and draws in place.
// Reentrant-safe (checks isDrawing flag) — concurrent calls are no-ops.
//
// Theme colors are imported from ./theme (single source of truth shared
// with renderer.js, config.js, notifications.js, etc).

const { formatShort } = require('./utils');
const { COLORS } = require('./theme');

let isDrawing = false;

/**
 * Clear the canvas with the background color.
 */
function clearCanvas(ctx) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * Draw X/Y axes with ticks and labels.
 */
function drawAxes(ctx, w, h, padding) {
  ctx.strokeStyle = COLORS.AXIS_COLOR;
  ctx.lineWidth = 1;
  // Y axis
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.stroke();
  // Y-axis labels (0, 25%, 50%, 75%, 100%)
  ctx.fillStyle = COLORS.TEXT_MUTED;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = h - padding.bottom - (i / 4) * (h - padding.top - padding.bottom);
    ctx.fillText((i * 25) + '%', padding.left - 6, y + 4);
    // Gridline
    ctx.strokeStyle = COLORS.GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }
}

/**
 * Draw a horizontal bar chart for top-N processes.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{pid:number,name:string,memoryUsage:number}>} data
 */
function drawBarChart(canvas, data) {
  if (!canvas || isDrawing) return;
  isDrawing = true;
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    clearCanvas(ctx);
    if (!data || data.length === 0) return;
    const top = data.slice(0, 10);
    const max = top[0].memoryUsage || 1;
    const padding = { top: 10, right: 16, bottom: 20, left: 80 };
    const barH = (h - padding.top - padding.bottom) / top.length;
    ctx.font = '11px sans-serif';
    top.forEach((p, i) => {
      const y = padding.top + i * barH;
      const barW = (p.memoryUsage / max) * (w - padding.left - padding.right);
      ctx.fillStyle = COLORS.CHART_SERIES[i % COLORS.CHART_SERIES.length];
      ctx.fillRect(padding.left, y + 2, barW, barH - 4);
      // Label (left)
      ctx.fillStyle = COLORS.TEXT_MUTED;
      ctx.textAlign = 'right';
      ctx.fillText(p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name, padding.left - 6, y + barH / 2 + 4);
      // Value (right of bar)
      ctx.textAlign = 'left';
      ctx.fillStyle = '#333';
      ctx.fillText(formatShort(p.memoryUsage), padding.left + barW + 4, y + barH / 2 + 4);
    });
  } finally {
    isDrawing = false;
  }
}

/**
 * Draw a pie chart for system memory (used vs free).
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{name:string,value:number,color?:string}>} data
 */
function drawPieChart(canvas, data) {
  if (!canvas || isDrawing) return;
  isDrawing = true;
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    clearCanvas(ctx);
    const total = data.reduce((s, d) => s + d.value, 0);
    if (total === 0) return;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 10;
    let angle = -Math.PI / 2;
    data.forEach((d, i) => {
      const slice = (d.value / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = d.color || COLORS.CHART_SERIES[i % COLORS.CHART_SERIES.length];
      ctx.fill();
      angle += slice;
    });
    // Legend
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    let ly = 8;
    data.forEach((d, i) => {
      ctx.fillStyle = d.color || COLORS.CHART_SERIES[i % COLORS.CHART_SERIES.length];
      ctx.fillRect(6, ly, 10, 10);
      ctx.fillStyle = COLORS.TEXT_MUTED;
      const pct = ((d.value / total) * 100).toFixed(1);
      ctx.fillText(`${d.name} ${pct}%`, 20, ly + 9);
      ly += 16;
    });
  } finally {
    isDrawing = false;
  }
}

/**
 * Draw a line chart for one process's memory over time.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label:string,color:string,points:Array<{x:number,y:number}>}>} series
 */
function drawLineChart(canvas, series) {
  if (!canvas || isDrawing) return;
  isDrawing = true;
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    clearCanvas(ctx);
    const padding = { top: 16, right: 16, bottom: 30, left: 50 };
    if (!series || series.length === 0) {
      ctx.fillStyle = '#999';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('选择一个进程查看历史', w / 2, h / 2);
      return;
    }
    // Compute bounds across all series
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    series.forEach(s => {
      s.points.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    });
    if (maxX === minX) { minX -= 1; maxX += 1; }
    if (maxY === minY) { minY = 0; maxY = 1; }
    const xRange = maxX - minX;
    const yRange = maxY - minY;
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;
    drawAxesNumeric(ctx, w, h, padding, minY, maxY);
    // Draw each series
    series.forEach(s => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = padding.left + ((p.x - minX) / xRange) * plotW;
        const y = padding.top + plotH - ((p.y - minY) / yRange) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // Dots
      ctx.fillStyle = s.color;
      s.points.forEach(p => {
        const x = padding.left + ((p.x - minX) / xRange) * plotW;
        const y = padding.top + plotH - ((p.y - minY) / yRange) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
        ctx.fill();
      });
    });
    // Legend
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    let lx = padding.left + 4;
    series.forEach((s, i) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, h - padding.bottom + 6, 10, 10);
      ctx.fillStyle = COLORS.TEXT_MUTED;
      ctx.fillText(s.label, lx + 14, h - padding.bottom + 15);
      lx += ctx.measureText(s.label).width + 30;
    });
  } finally {
    isDrawing = false;
  }
}

function drawAxesNumeric(ctx, w, h, padding, minY, maxY) {
  ctx.strokeStyle = COLORS.AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.stroke();
  ctx.fillStyle = COLORS.TEXT_MUTED;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  const plotH = h - padding.top - padding.bottom;
  for (let i = 0; i <= 4; i++) {
    const v = minY + ((4 - i) / 4) * (maxY - minY);
    const y = padding.top + (i / 4) * plotH;
    ctx.fillText(formatShort(Math.round(v)), padding.left - 6, y + 4);
    ctx.strokeStyle = COLORS.GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }
}

function redrawAxesLine(ctx, w, h, left, right) {
  ctx.strokeStyle = COLORS.AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, 16);
  ctx.lineTo(left, h - 30);
  ctx.lineTo(w - right, h - 30);
  ctx.stroke();
}

module.exports = {
  clearCanvas,
  drawAxes,
  drawBarChart,
  drawPieChart,
  drawLineChart,
  drawAxesNumeric,
  redrawAxesLine,
};
