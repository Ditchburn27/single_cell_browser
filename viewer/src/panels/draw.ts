// One drawing API, two backends (canvas for screen, SVG for export), so each chart is written once.

export interface TextOpts { size?: number; weight?: string; anchor?: 'start' | 'middle' | 'end'; baseline?: 'top' | 'middle' | 'bottom'; color?: string; rotate?: number }
export interface Draw {
  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string): void;
  circle(cx: number, cy: number, r: number, fill: string, stroke?: string): void;
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width?: number): void;
  poly(pts: [number, number][], fill: string, stroke?: string, width?: number): void;
  text(x: number, y: number, s: string, o?: TextOpts): void;
}
export interface Theme { text: string; muted: string; grid: string; bg: string }
export const LIGHT: Theme = { text: '#1a1a18', muted: '#6b6b67', grid: 'rgba(128,128,128,0.25)', bg: '#ffffff' };

export function currentTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  return { text: v('--txt', LIGHT.text), muted: v('--mut', LIGHT.muted), grid: 'rgba(128,128,128,0.25)', bg: v('--surf', LIGHT.bg) };
}

export class CanvasDraw implements Draw {
  ctx: CanvasRenderingContext2D;
  constructor(public canvas: HTMLCanvasElement, public w: number, public h: number) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    this.ctx = canvas.getContext('2d')!;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
  }
  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string) {
    this.ctx.fillStyle = fill; this.ctx.fillRect(x, y, w, h);
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.strokeRect(x, y, w, h); }
  }
  circle(cx: number, cy: number, r: number, fill: string, stroke?: string) {
    this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.fillStyle = fill; this.ctx.fill();
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.stroke(); }
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1) {
    this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.strokeStyle = stroke; this.ctx.lineWidth = width; this.ctx.stroke();
  }
  poly(pts: [number, number][], fill: string, stroke?: string, width = 1) {
    const c = this.ctx; c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath();
    c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const c = this.ctx;
    c.save(); c.translate(x, y); if (o.rotate) c.rotate((o.rotate * Math.PI) / 180);
    c.font = `${o.weight ?? 'normal'} ${o.size ?? 11}px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;
    c.fillStyle = o.color ?? '#000'; c.textAlign = o.anchor === 'middle' ? 'center' : o.anchor === 'end' ? 'right' : 'left';
    c.textBaseline = o.baseline ?? 'middle'; c.fillText(s, 0, 0); c.restore();
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (x: number) => Math.round(x * 100) / 100;

export class SvgDraw implements Draw {
  private parts: string[] = [];
  constructor(public w: number, public h: number, public bg = '#ffffff') {}
  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string) {
    this.parts.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`);
  }
  circle(cx: number, cy: number, r: number, fill: string, stroke?: string) {
    this.parts.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1) {
    this.parts.push(`<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${stroke}" stroke-width="${width}"/>`);
  }
  poly(pts: [number, number][], fill: string, stroke?: string, width = 1) {
    this.parts.push(`<polygon points="${pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ')}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ''}/>`);
  }
  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const base = o.baseline === 'top' ? 'hanging' : o.baseline === 'bottom' ? 'text-after-edge' : 'central';
    const tr = o.rotate ? ` transform="rotate(${o.rotate},${r2(x)},${r2(y)})"` : '';
    this.parts.push(`<text x="${r2(x)}" y="${r2(y)}" font-size="${o.size ?? 11}" font-weight="${o.weight ?? 'normal'}" text-anchor="${o.anchor ?? 'start'}" dominant-baseline="${base}" fill="${o.color ?? '#000'}"${tr}>${esc(s)}</text>`);
  }
  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" font-family="Helvetica,Arial,sans-serif"><rect width="100%" height="100%" fill="${this.bg}"/>${this.parts.join('')}</svg>`;
  }
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a'); a.download = filename; a.href = URL.createObjectURL(blob); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const downloadText = (text: string, filename: string, type = 'text/plain') => download(new Blob([text], { type }), filename);

/** A chart is a size plus a function that paints it with any Draw backend + theme. */
export interface Chart { w: number; h: number; paint(d: Draw, t: Theme): void }

export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
export function fmtNum(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return String(Math.round(v * 100) / 100);
}
