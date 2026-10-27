// MSLP chart: isobars and high/low centres drawn from data/mslp.json (a
// pressure grid the skin fetches from Open-Meteo every few hours).
// The coarse grid is smoothed with bicubic interpolation, contoured with
// marching squares, and the line pieces are joined and labelled.

export const ISOBAR_HPA = 4;
const UPSAMPLE = 4;             // 3° grid -> 0.75° before contouring
const EXTREMA_RADIUS = 8;       // cells (6°) a high/low must dominate
const EXTREMA_MIN_DIFF = 2;     // hPa above/below its surroundings' mean

/** Catmull-Rom bicubic upsampling of a row-major grid. */
function upsample(v, rows, cols, f) {
  const R = (rows - 1) * f + 1;
  const C = (cols - 1) * f + 1;
  const at = (i, j) => v[Math.max(0, Math.min(rows - 1, i)) * cols + Math.max(0, Math.min(cols - 1, j))];
  const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const out = new Float32Array(R * C);
  for (let I = 0; I < R; I++) {
    const i = Math.floor(I / f);
    const ti = I / f - i;
    for (let J = 0; J < C; J++) {
      const j = Math.floor(J / f);
      const tj = J / f - j;
      const row = (k) => cr(at(k, j - 1), at(k, j), at(k, j + 1), at(k, j + 2), tj);
      out[I * C + J] = cr(row(i - 1), row(i), row(i + 1), row(i + 2), ti);
    }
  }
  return { v: out, rows: R, cols: C };
}

/** Fill nulls (rare: a point the model skipped) with the mean of neighbours. */
function fillGaps(p, rows, cols) {
  const v = p.map((x) => (x === null ? NaN : x));
  for (let pass = 0; pass < 4 && v.some(Number.isNaN); pass++) {
    for (let k = 0; k < v.length; k++) {
      if (!Number.isNaN(v[k])) continue;
      const i = Math.floor(k / cols);
      const j = k % cols;
      let s = 0;
      let n = 0;
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const a = i + di;
        const b = j + dj;
        if (a >= 0 && a < rows && b >= 0 && b < cols && !Number.isNaN(v[a * cols + b])) { s += v[a * cols + b]; n++; }
      }
      if (n) v[k] = s / n;
    }
  }
  return v.map((x) => (Number.isNaN(x) ? 1013 : x));
}

/** Marching squares: line segments [[y0,x0],[y1,x1]] (grid units) at level. */
function segments(g, level) {
  const { v, rows, cols } = g;
  const out = [];
  const lerp = (a, b) => (level - a) / (b - a);
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = v[i * cols + j];             // top-left
      const b = v[i * cols + j + 1];         // top-right
      const c = v[(i + 1) * cols + j + 1];   // bottom-right
      const d = v[(i + 1) * cols + j];       // bottom-left
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = [i, j + lerp(a, b)];
      const right = [i + lerp(b, c), j + 1];
      const bottom = [i + 1, j + lerp(d, c)];
      const left = [i + lerp(a, d), j];
      const centre = (a + b + c + d) / 4 > level;
      switch (idx) {
        case 1: case 14: out.push([left, bottom]); break;
        case 2: case 13: out.push([bottom, right]); break;
        case 3: case 12: out.push([left, right]); break;
        case 4: case 11: out.push([top, right]); break;
        case 6: case 9: out.push([top, bottom]); break;
        case 7: case 8: out.push([left, top]); break;
        case 5: if (centre) out.push([left, top], [bottom, right]); else out.push([left, bottom], [top, right]); break;
        case 10: if (centre) out.push([top, right], [left, bottom]); else out.push([left, top], [bottom, right]); break;
        default: break;
      }
    }
  }
  return out;
}

/** Join segments that share end points into polylines. */
function join(segs) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const ends = new Map();
  segs.forEach((s, k) => {
    for (const p of s) {
      const kk = key(p);
      if (!ends.has(kk)) ends.set(kk, []);
      ends.get(kk).push(k);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const next = (p) => (ends.get(key(p)) || []).find((k) => !used[k]);
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const line = [segs[k][0], segs[k][1]];
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? line[line.length - 1] : line[0];
        const n = next(tip);
        if (n === undefined) break;
        used[n] = 1;
        const [p, q] = segs[n];
        const other = key(p) === key(tip) ? q : p;
        if (forward) line.push(other); else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Highs and lows: cells that are the extreme of their neighbourhood. */
function extrema(g) {
  const { v, rows, cols } = g;
  const r = EXTREMA_RADIUS;
  const out = [];
  const edge = 2;   // centres right on the grid's edge are usually cut off
  for (let i = edge; i < rows - edge; i++) {
    for (let j = edge; j < cols - edge; j++) {
      const x = v[i * cols + j];
      let isMax = true;
      let isMin = true;
      let sum = 0;
      let n = 0;
      // the window shrinks at the edges, so near-edge highs and lows count
      for (let a = Math.max(0, i - r); a <= Math.min(rows - 1, i + r) && (isMax || isMin); a++) {
        for (let b = Math.max(0, j - r); b <= Math.min(cols - 1, j + r); b++) {
          if (a === i && b === j) continue;
          const y = v[a * cols + b];
          if (y >= x) isMax = false;
          if (y <= x) isMin = false;
          sum += y;
          n++;
        }
      }
      if (!n) continue;
      const mean = sum / n;
      if (isMax && x - mean >= EXTREMA_MIN_DIFF) out.push({ type: 'H', i, j, p: x });
      if (isMin && mean - x >= EXTREMA_MIN_DIFF) out.push({ type: 'L', i, j, p: x });
    }
  }
  return out;
}

/**
 * Isobars for one time step.
 * @returns {{lines: Array<{level:number, pts:Array<[number,number]>}>,
 *            centres: Array<{type:string, lat:number, lon:number, p:number}>,
 *            at: function(lat, lon): number}}
 */
export function isobars(data, step) {
  const rows = data.lat.length;
  const cols = data.lon.length;
  const coarse = fillGaps(data.p[step], rows, cols);
  const g = upsample(coarse, rows, cols, UPSAMPLE);
  const lat0 = data.lat[0];
  const lon0 = data.lon[0];
  const dLat = (data.lat[rows - 1] - lat0) / (g.rows - 1);
  const dLon = (data.lon[cols - 1] - lon0) / (g.cols - 1);
  const toLL = ([y, x]) => [lat0 + y * dLat, lon0 + x * dLon];

  let lo = Infinity;
  let hi = -Infinity;
  for (const x of g.v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const lines = [];
  for (let level = Math.ceil(lo / ISOBAR_HPA) * ISOBAR_HPA; level <= hi; level += ISOBAR_HPA) {
    for (const line of join(segments(g, level))) {
      if (line.length < 3) continue;
      lines.push({ level, pts: line.map(toLL) });
    }
  }
  const centres = extrema(g).map((e) => {
    const [lat, lon] = toLL([e.i, e.j]);
    return { type: e.type, lat, lon, p: e.p };
  });
  // bilinear value at a point, for "pressure here"
  const at = (lat, lon) => {
    const y = (lat - lat0) / dLat;
    const x = (lon - lon0) / dLon;
    const i = Math.max(0, Math.min(g.rows - 2, Math.floor(y)));
    const j = Math.max(0, Math.min(g.cols - 2, Math.floor(x)));
    const ty = y - i;
    const tx = x - j;
    const V = (a, b) => g.v[a * g.cols + b];
    return (V(i, j) * (1 - tx) + V(i, j + 1) * tx) * (1 - ty) + (V(i + 1, j) * (1 - tx) + V(i + 1, j + 1) * tx) * ty;
  };
  return { lines, centres, at };
}
