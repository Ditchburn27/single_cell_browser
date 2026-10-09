// Colour utilities: palettes, colormaps, RGBA buffer builders. No dataset-specific assumptions.
import type { CatCol, NumCol } from '../data/schema';

export const BASE_PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#8dd3c7', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'];

/** Colour i of an unbounded palette: the base palette first, then golden-angle HSL for the rest. */
export function paletteColor(i: number): string {
  if (i < BASE_PALETTE.length) return BASE_PALETTE[i];
  const k = i - BASE_PALETTE.length;
  const h = (k * 137.508) % 360, s = 55 + ((k * 7) % 25), l = 45 + ((k * 11) % 20);
  return hsl(h, s, l);
}
function hsl(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}/i.test(h)) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  // named / rgb() colours via a throwaway canvas
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = '#000'; c.fillStyle = hex;
  const m = /^#([0-9a-f]{6})$/i.exec(c.fillStyle as string);
  return m ? hexToRgb(m[1]) : [170, 170, 170];
}

/** Category colours: uns colours when valid, otherwise palette. */
export function categoryColors(col: CatCol): string[] {
  if (col.colors && col.colors.length >= col.categories.length) return col.colors.slice(0, col.categories.length);
  return col.categories.map((_, i) => paletteColor(i));
}

export type MapName = 'viridis' | 'magma' | 'plasma' | 'inferno' | 'cividis' | 'turbo' | 'greys' | 'blues' | 'rdbu';
const STOPS: Record<MapName, string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  plasma: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'],
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  cividis: ['#00204d', '#414d6b', '#7c7b78', '#bcaf6f', '#ffea46'],
  turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c7ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'],
  greys: ['#e8e8e8', '#9a9a9a', '#1a1a1a'],
  blues: ['#e6eefc', '#8fb4f0', '#2b5fc9', '#0b2a6b'],
  rdbu: ['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b'],
};
const lutCache = new Map<string, Uint8Array>();
export function lut(name: MapName): Uint8Array {
  let l = lutCache.get(name);
  if (l) return l;
  const stops = STOPS[name].map(hexToRgb);
  l = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) l[i * 3 + c] = Math.round(stops[k][c] + f * (stops[k + 1][c] - stops[k][c]));
  }
  lutCache.set(name, l);
  return l;
}
export function colormapCss(name: MapName, t: number): string {
  const l = lut(name), i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return `rgb(${l[i * 3]},${l[i * 3 + 1]},${l[i * 3 + 2]})`;
}
export const COLORMAPS = Object.keys(STOPS) as MapName[];

export function quantile(sorted: Float32Array | number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

export interface ValueRange { min: number; max: number }
export function valueRange(v: Float32Array, clipTop: boolean): ValueRange {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < v.length; i++) { const x = v[i]; if (x === x) { if (x < mn) mn = x; if (x > mx) mx = x; } }
  if (!isFinite(mn)) return { min: 0, max: 1 };
  if (clipTop && mx > mn) {
    // 99.5th percentile of non-zero values, only if it materially reduces the range
    const nz: number[] = [];
    for (let i = 0; i < v.length; i += Math.max(1, Math.floor(v.length / 100000))) if (v[i] > mn) nz.push(v[i]);
    if (nz.length > 50) { nz.sort((a, b) => a - b); const q = quantile(nz, 0.995); if (q > mn && q < mx) mx = q; }
  }
  return { min: mn, max: mx };
}

export const MISSING: [number, number, number] = [170, 170, 170];

export function rgbaForCategories(col: CatCol, colors: string[]): Uint8Array {
  const n = col.codes.length, out = new Uint8Array(n * 4);
  const rgb = colors.map(hexToRgb);
  for (let i = 0; i < n; i++) {
    const c = col.codes[i], o = i * 4;
    const [r, g, b] = c >= 0 ? rgb[c] : MISSING;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}
export function rgbaForValues(v: Float32Array | NumCol['values'], range: ValueRange, map: MapName): Uint8Array {
  const n = v.length, out = new Uint8Array(n * 4), l = lut(map);
  const span = range.max - range.min || 1;
  for (let i = 0; i < n; i++) {
    const x = v[i], o = i * 4;
    if (x !== x) { out[o] = 170; out[o + 1] = 170; out[o + 2] = 170; out[o + 3] = 255; continue; }
    const t = Math.max(0, Math.min(1, (x - range.min) / span)), k = Math.round(t * 255) * 3;
    out[o] = l[k]; out[o + 1] = l[k + 1]; out[o + 2] = l[k + 2]; out[o + 3] = 255;
  }
  return out;
}
