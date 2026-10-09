// Spatial lookup (hover) and polygon / box hit-testing (selection). Positions: Float32Array n x 2 in data space.

export class PointGrid {
  private cells: Int32Array; private items: Uint32Array;
  private x0 = 0; private y0 = 0; private cw = 1; private ch = 1; private g = 1;
  constructor(private pos: Float32Array) {
    const n = pos.length / 2;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1];
      if (x !== x || y !== y) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
    this.g = Math.max(8, Math.min(512, Math.round(Math.sqrt(n / 4))));
    this.x0 = x0; this.y0 = y0;
    this.cw = (x1 - x0 || 1) / this.g * 1.000001; this.ch = (y1 - y0 || 1) / this.g * 1.000001;
    const counts = new Int32Array(this.g * this.g + 1);
    const cellOf = (i: number) => {
      const cx = Math.floor((pos[2 * i] - this.x0) / this.cw), cy = Math.floor((pos[2 * i + 1] - this.y0) / this.ch);
      return cy * this.g + cx;
    };
    for (let i = 0; i < n; i++) { if (pos[2 * i] === pos[2 * i] && pos[2 * i + 1] === pos[2 * i + 1]) counts[cellOf(i) + 1]++; }
    for (let i = 0; i < this.g * this.g; i++) counts[i + 1] += counts[i];
    this.cells = counts;
    this.items = new Uint32Array(counts[this.g * this.g]);
    const fill = counts.slice(0, this.g * this.g);
    for (let i = 0; i < n; i++) { if (pos[2 * i] === pos[2 * i] && pos[2 * i + 1] === pos[2 * i + 1]) this.items[fill[cellOf(i)]++] = i; }
  }
  /** Nearest visible point within `r` (data units), or -1. */
  nearest(x: number, y: number, r: number, visible?: (i: number) => boolean): number {
    const cx0 = Math.max(0, Math.floor((x - r - this.x0) / this.cw)), cx1 = Math.min(this.g - 1, Math.floor((x + r - this.x0) / this.cw));
    const cy0 = Math.max(0, Math.floor((y - r - this.y0) / this.ch)), cy1 = Math.min(this.g - 1, Math.floor((y + r - this.y0) / this.ch));
    let best = -1, bd = r * r;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * this.g + cx;
      for (let k = this.cells[c]; k < this.cells[c + 1]; k++) {
        const i = this.items[k];
        const dx = this.pos[2 * i] - x, dy = this.pos[2 * i + 1] - y, d = dx * dx + dy * dy;
        if (d <= bd && (!visible || visible(i))) { bd = d; best = i; }
      }
    }
    return best;
  }
}

/** Cells inside a polygon (data space). `visible` filters hidden cells. */
export function pointsInPolygon(pos: Float32Array, poly: [number, number][], visible?: (i: number) => boolean): Uint8Array {
  const n = pos.length / 2, out = new Uint8Array(n);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = poly.length;
  for (let i = 0; i < n; i++) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (visible && !visible(i)) continue;
    let inside = false;
    for (let a = 0, b = m - 1; a < m; b = a++) {
      const xa = poly[a][0], ya = poly[a][1], xb = poly[b][0], yb = poly[b][1];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
    }
    if (inside) out[i] = 1;
  }
  return out;
}

/** Median position per category code, robust to outliers (used for label placement). */
export function categoryCentroids(pos: Float32Array, codes: ArrayLike<number>, nCats: number, visible?: (c: number) => boolean) {
  const xs: number[][] = Array.from({ length: nCats }, () => []), ys: number[][] = Array.from({ length: nCats }, () => []);
  const n = codes.length, step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) {
    const c = codes[i]; if (c < 0 || (visible && !visible(c))) continue;
    const x = pos[2 * i], y = pos[2 * i + 1]; if (x !== x || y !== y) continue;
    xs[c].push(x); ys[c].push(y);
  }
  const med = (a: number[]) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  return xs.map((a, c) => (a.length ? { x: med(a), y: med(ys[c]), n: a.length } : null));
}
