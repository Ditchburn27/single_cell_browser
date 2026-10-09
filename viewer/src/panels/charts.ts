import { type Chart, type Draw, type Theme, fmtNum, niceTicks } from './draw';
import { colormapCss, type MapName } from '../render/color';

const FONT_PAD = 6;

export interface BarInput { labels: string[]; values: number[]; colors: string[]; yLabel: string; maxBarW?: number }

/** Bar chart (cell counts). */
export function barChart(inp: BarInput, avail: number): Chart {
  const padL = 60, padR = 20, padT = 20, padB = longest(inp.labels) + 24, H = 280;
  const k = inp.labels.length || 1;
  const barW = Math.max(14, Math.min(inp.maxBarW ?? 56, Math.floor((avail - padL - padR) / k) - 4)), gap = 4;
  const W = padL + k * (barW + gap) + padR, chartH = H - padT - padB;
  const mx = Math.max(1, ...inp.values);
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      for (const v of niceTicks(0, mx, 5)) {
        const y = padT + chartH * (1 - v / mx);
        d.line(padL, y, W - padR, y, t.grid, 0.6); d.text(padL - 5, y, fmtNum(v), { anchor: 'end', size: 9, color: t.muted });
      }
      inp.labels.forEach((lab, i) => {
        const x = padL + i * (barW + gap), h = (chartH * inp.values[i]) / mx;
        d.rect(x, padT + chartH - h, barW, h, inp.colors[i]);
        d.text(x + barW / 2, padT + chartH - h - 7, inp.values[i].toLocaleString(), { anchor: 'middle', size: 9, color: t.text });
        d.text(x + barW / 2 + 3, padT + chartH + 8, lab, { anchor: 'start', baseline: 'top', rotate: 45, size: 10, color: t.text });
      });
      d.text(14, padT + chartH / 2, inp.yLabel, { anchor: 'middle', rotate: -90, size: 11, color: t.text });
    },
  };
}

export interface StackInput { rows: string[]; cols: string[]; colColors: string[]; counts: number[][]; rowKey: string; colKey: string; asProportion: boolean }

/** Stacked bars: for each row category, the composition across column categories. */
export function stackedBars(inp: StackInput, avail: number): Chart {
  const padL = 50, padT = 20, padB = longest(inp.rows) + 40, H = 320, barW = Math.max(14, Math.min(40, Math.floor((avail - 220 - padL) / (inp.rows.length || 1)) - 5)), gap = 5;
  const chartW = inp.rows.length * (barW + gap), W = padL + chartW + 20, chartH = H - padT - padB;
  const totals = inp.counts.map((r) => r.reduce((a, b) => a + b, 0) || 1);
  const maxTotal = Math.max(...totals);
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      const ticks = inp.asProportion ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, maxTotal, 4);
      const top = inp.asProportion ? 1 : maxTotal;
      for (const v of ticks) {
        const y = padT + chartH * (1 - v / top);
        d.line(padL, y, padL + chartW, y, t.grid, 0.6);
        d.text(padL - 5, y, inp.asProportion ? `${Math.round(v * 100)}%` : fmtNum(v), { anchor: 'end', size: 9, color: t.muted });
      }
      inp.rows.forEach((r, ri) => {
        const x = padL + ri * (barW + gap);
        let y = padT + chartH;
        inp.cols.forEach((_, ci) => {
          const frac = inp.asProportion ? inp.counts[ri][ci] / totals[ri] : inp.counts[ri][ci] / maxTotal;
          const h = frac * chartH;
          if (h < 0.3) return;
          y -= h; d.rect(x, y, barW, h, inp.colColors[ci]);
        });
        d.text(x + barW / 2 + 3, padT + chartH + 8, r, { anchor: 'start', baseline: 'top', rotate: 45, size: 10, color: t.text });
      });
      d.text(padL + chartW / 2, H - 6, inp.rowKey, { anchor: 'middle', size: 11, color: t.text });
      d.text(12, padT + chartH / 2, inp.asProportion ? 'proportion' : '# cells', { anchor: 'middle', rotate: -90, size: 11, color: t.text });
    },
  };
}

export interface ViolinInput { cats: string[]; colors: string[]; groups: Float32Array[]; yLabel: string; xLabel: string }

function kde(vals: Float32Array, lo: number, hi: number, nPts: number): number[] {
  // subsample for speed
  const m = vals.length, step = Math.max(1, Math.floor(m / 4000));
  const s: number[] = []; for (let i = 0; i < m; i += step) s.push(vals[i]);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length) || (hi - lo) * 0.05 || 0.1;
  const bw = Math.max(1.06 * sd * Math.pow(s.length, -0.2), (hi - lo) * 0.01);
  const out: number[] = [];
  for (let k = 0; k <= nPts; k++) {
    const x = lo + (k * (hi - lo)) / nPts; let dsum = 0;
    for (const v of s) { const z = (x - v) / bw; dsum += Math.exp(-0.5 * z * z); }
    out.push(dsum / (s.length * bw));
  }
  return out;
}
export function violin(inp: ViolinInput, avail: number): Chart {
  const padL = 56, padR = 20, padT = 20, padB = longest(inp.cats) + 30, H = 320, k = inp.cats.length || 1;
  const vw = Math.max(26, Math.min(70, Math.floor((avail - padL - padR) / k) - 4)), gap = 4;
  const W = padL + k * (vw + gap) + padR, chartH = H - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const g of inp.groups) for (let i = 0; i < g.length; i++) { const v = g[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!isFinite(lo)) { lo = 0; hi = 1; } if (lo === hi) hi = lo + 1;
  const toY = (v: number) => padT + chartH - ((v - lo) / (hi - lo)) * chartH;
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      for (const v of niceTicks(lo, hi, 5)) {
        const y = toY(v); d.line(padL, y, W - padR, y, t.grid, 0.6); d.text(padL - 5, y, fmtNum(v), { anchor: 'end', size: 9, color: t.muted });
      }
      inp.cats.forEach((cat, ci) => {
        const g = inp.groups[ci]; if (!g.length) return;
        const cx = padL + ci * (vw + gap) + vw / 2, half = vw * 0.46, dens = kde(g, lo, hi, 50), mx = Math.max(...dens) || 1;
        const right: [number, number][] = dens.map((v, i) => [cx + (v / mx) * half, toY(lo + (i * (hi - lo)) / 50)]);
        const left: [number, number][] = dens.map((v, i) => [cx - (v / mx) * half, toY(lo + (i * (hi - lo)) / 50)]).reverse() as [number, number][];
        d.poly([...right, ...left], inp.colors[ci] + 'aa', inp.colors[ci], 1.2);
        const sorted = Float32Array.from(g).sort(); const med = sorted[Math.floor(sorted.length / 2)];
        d.line(cx - half * 0.5, toY(med), cx + half * 0.5, toY(med), '#ffffff', 2);
        d.text(cx + 3, padT + chartH + 8, cat, { anchor: 'start', baseline: 'top', rotate: 45, size: 10, color: t.text });
      });
      d.text(14, padT + chartH / 2, inp.yLabel, { anchor: 'middle', rotate: -90, size: 11, color: t.text });
    },
  };
}

export interface DotInput {
  groups: string[]; genes: string[]; mean: Float32Array; pct: Float32Array; // gi*nGroups + group
  scale: 'gene' | 'global'; map: MapName; cell?: number;
}
export type DotChart = Chart & { padL: number; cell: number; padT: number };
export function dotPlot(inp: DotInput): DotChart {
  const nG = inp.groups.length, nGe = inp.genes.length, cell = inp.cell ?? 20;
  const padL = Math.min(200, 20 + longest(inp.groups)), padT = 16, padB = longest(inp.genes) + 14, padR = 110;
  const W = padL + nGe * cell + padR, H = padT + nG * cell + padB;
  // colour scaling
  const mn = new Float32Array(nGe).fill(Infinity), mx = new Float32Array(nGe).fill(-Infinity);
  let gmx = 0;
  for (let gi = 0; gi < nGe; gi++) for (let k = 0; k < nG; k++) {
    const v = inp.mean[gi * nG + k]; if (v < mn[gi]) mn[gi] = v; if (v > mx[gi]) mx[gi] = v; if (v > gmx) gmx = v;
  }
  return {
    w: W, h: H, padL, cell, padT,
    paint(d: Draw, t: Theme) {
      for (let k = 0; k < nG; k++) {
        const y = padT + k * cell + cell / 2;
        d.text(padL - 6, y, inp.groups[k], { anchor: 'end', size: 11, color: t.text });
        d.line(padL, y, padL + nGe * cell, y, t.grid, 0.4);
      }
      for (let gi = 0; gi < nGe; gi++) {
        const x = padL + gi * cell + cell / 2;
        d.text(x + 3, padT + nG * cell + 8, inp.genes[gi], { anchor: 'start', baseline: 'top', rotate: 45, size: 10, color: t.text });
        for (let k = 0; k < nG; k++) {
          const p = inp.pct[gi * nG + k], v = inp.mean[gi * nG + k];
          if (p <= 0) continue;
          const tt = inp.scale === 'gene' ? (mx[gi] > mn[gi] ? (v - mn[gi]) / (mx[gi] - mn[gi]) : 0) : gmx > 0 ? v / gmx : 0;
          d.circle(x, padT + k * cell + cell / 2, cell * 0.46 * Math.sqrt(p), colormapCss(inp.map, tt), 'rgba(0,0,0,0.15)');
        }
      }
      // size legend
      const lx = padL + nGe * cell + 20;
      d.text(lx, padT + 2, '% expressing', { size: 10, color: t.muted });
      [0.25, 0.5, 0.75, 1].forEach((p, i) => {
        d.circle(lx + 10, padT + 24 + i * 22, cell * 0.46 * Math.sqrt(p), '#888'); d.text(lx + 30, padT + 24 + i * 22, `${p * 100}%`, { size: 10, color: t.muted });
      });
      d.text(lx, padT + 120, inp.scale === 'gene' ? 'mean (per gene)' : 'mean', { size: 10, color: t.muted });
      for (let i = 0; i < 40; i++) d.rect(lx + i * 2, padT + 130, 2, 10, colormapCss(inp.map, i / 39));
      d.text(lx, padT + 150, 'low', { size: 9, color: t.muted }); d.text(lx + 80, padT + 150, 'high', { size: 9, color: t.muted, anchor: 'end' });
    },
  };
}

export interface HeatInput { groups: string[]; genes: string[]; mean: Float32Array; map: MapName; cell?: number }
/** Heatmap of group-mean expression, z-scored per gene across groups. */
export function heatmap(inp: HeatInput): Chart {
  const nG = inp.groups.length, nGe = inp.genes.length, cell = inp.cell ?? 18;
  const padL = Math.min(200, 20 + longest(inp.groups)), padT = 16, padB = longest(inp.genes) + 14, padR = 80;
  const W = padL + nGe * cell + padR, H = padT + nG * cell + padB;
  const z = new Float32Array(nGe * nG);
  for (let gi = 0; gi < nGe; gi++) {
    let m = 0; for (let k = 0; k < nG; k++) m += inp.mean[gi * nG + k]; m /= nG;
    let s = 0; for (let k = 0; k < nG; k++) s += (inp.mean[gi * nG + k] - m) ** 2; s = Math.sqrt(s / nG) || 1;
    for (let k = 0; k < nG; k++) z[gi * nG + k] = Math.max(-2.5, Math.min(2.5, (inp.mean[gi * nG + k] - m) / s));
  }
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      for (let k = 0; k < nG; k++) d.text(padL - 6, padT + k * cell + cell / 2, inp.groups[k], { anchor: 'end', size: 11, color: t.text });
      for (let gi = 0; gi < nGe; gi++) {
        d.text(padL + gi * cell + cell / 2 + 3, padT + nG * cell + 8, inp.genes[gi], { anchor: 'start', baseline: 'top', rotate: 45, size: 10, color: t.text });
        for (let k = 0; k < nG; k++) d.rect(padL + gi * cell, padT + k * cell, cell, cell, colormapCss(inp.map, (z[gi * nG + k] + 2.5) / 5));
      }
      const lx = padL + nGe * cell + 16;
      d.text(lx, padT + 2, 'z-score', { size: 10, color: t.muted });
      for (let i = 0; i < 40; i++) d.rect(lx, padT + 12 + i * 2, 10, 2, colormapCss(inp.map, 1 - i / 39));
      d.text(lx + 14, padT + 16, '+2.5', { size: 9, color: t.muted }); d.text(lx + 14, padT + 12 + 78, '−2.5', { size: 9, color: t.muted });
    },
  };
}

export interface Scatter2Input { x: Float32Array; y: Float32Array; colors: ((i: number) => string) | null; xLabel: string; yLabel: string; maxPts?: number }
export function pointScatter(inp: Scatter2Input): Chart {
  const W = 420, H = 340, padL = 56, padR = 16, padT = 14, padB = 44;
  const n = inp.x.length, step = Math.max(1, Math.floor(n / (inp.maxPts ?? 8000)));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i += step) { const a = inp.x[i], b = inp.y[i]; if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; }
  if (x0 === x1) x1 = x0 + 1; if (y0 === y1) y1 = y0 + 1;
  const sx = (v: number) => padL + ((v - x0) / (x1 - x0)) * (W - padL - padR), sy = (v: number) => H - padB - ((v - y0) / (y1 - y0)) * (H - padT - padB);
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      for (const v of niceTicks(x0, x1, 5)) { d.line(sx(v), padT, sx(v), H - padB, t.grid, 0.5); d.text(sx(v), H - padB + 12, fmtNum(v), { anchor: 'middle', size: 9, color: t.muted }); }
      for (const v of niceTicks(y0, y1, 5)) { d.line(padL, sy(v), W - padR, sy(v), t.grid, 0.5); d.text(padL - 5, sy(v), fmtNum(v), { anchor: 'end', size: 9, color: t.muted }); }
      for (let i = 0; i < n; i += step) d.circle(sx(inp.x[i]), sy(inp.y[i]), 1.8, inp.colors ? inp.colors(i) : 'rgba(61,111,240,0.45)');
      d.text(padL + (W - padL - padR) / 2, H - 8, inp.xLabel, { anchor: 'middle', size: 11, color: t.text });
      d.text(12, padT + (H - padT - padB) / 2, inp.yLabel, { anchor: 'middle', rotate: -90, size: 11, color: t.text });
    },
  };
}

export interface VolcanoInput { lfc: Float32Array; p: Float32Array; names: string[]; labelTop: number; xLabel?: string }
export function volcano(inp: VolcanoInput): Chart {
  const W = 480, H = 360, padL = 56, padR = 20, padT = 16, padB = 44, n = inp.lfc.length;
  const ys = new Float32Array(n); let ym = 1, xm = 0.5;
  for (let i = 0; i < n; i++) { ys[i] = -Math.log10(Math.max(inp.p[i], 1e-300)); ym = Math.max(ym, ys[i]); xm = Math.max(xm, Math.abs(inp.lfc[i])); }
  xm = Math.min(xm, 12);
  const sx = (v: number) => padL + ((Math.max(-xm, Math.min(xm, v)) + xm) / (2 * xm)) * (W - padL - padR), sy = (v: number) => H - padB - (v / ym) * (H - padT - padB);
  const top = Array.from({ length: n }, (_, i) => i).sort((a, b) => ys[b] * Math.abs(inp.lfc[b]) - ys[a] * Math.abs(inp.lfc[a])).slice(0, inp.labelTop);
  return {
    w: W, h: H,
    paint(d: Draw, t: Theme) {
      d.line(sx(0), padT, sx(0), H - padB, t.grid, 0.8); d.line(padL, sy(-Math.log10(0.05)), W - padR, sy(-Math.log10(0.05)), t.grid, 0.8);
      for (const v of niceTicks(-xm, xm, 6)) d.text(sx(v), H - padB + 12, fmtNum(v), { anchor: 'middle', size: 9, color: t.muted });
      for (const v of niceTicks(0, ym, 5)) d.text(padL - 5, sy(v), fmtNum(v), { anchor: 'end', size: 9, color: t.muted });
      for (let i = 0; i < n; i++) {
        const sig = inp.p[i] < 0.05 && Math.abs(inp.lfc[i]) > 0.5;
        d.circle(sx(inp.lfc[i]), sy(ys[i]), sig ? 2.4 : 1.6, sig ? (inp.lfc[i] > 0 ? '#e15759' : '#4e79a7') : 'rgba(150,150,150,0.5)');
      }
      for (const i of top) d.text(sx(inp.lfc[i]) + 4, sy(ys[i]) - 4, inp.names[i], { size: 9, color: t.text });
      d.text(padL + (W - padL - padR) / 2, H - 8, inp.xLabel ?? 'log2 fold change', { anchor: 'middle', size: 11, color: t.text });
      d.text(12, padT + (H - padT - padB) / 2, '−log10 adj. p', { anchor: 'middle', rotate: -90, size: 11, color: t.text });
    },
  };
}

function longest(a: string[]): number {
  let m = 0; for (const s of a) m = Math.max(m, s.length);
  return Math.min(180, m * 5.6 + FONT_PAD);
}
