// Rain tracking for "Rain near the station" (pure functions, no DOM, so it
// can be tested on its own): radar dBZ grids for the last hour of frames in,
// the nearest rain, the motion field and the rain heading for the station out.
//
// - Motion is measured area by area: the map is split into overlapping
//   ~120 km windows and each window's echoes are matched between frames 30
//   minutes apart, for every such pair in the hour (up to four), keeping the
//   median - so a band in the north-west and drizzle in the east can move
//   differently, and one noisy comparison can't swing the result.
// - Rain is grouped into cells (connected echoes at the chosen dBZ); each
//   cell moves with the motion where it is, and is projected forward in a
//   straight line for up to 3 hours.
// - "Approaching" is the cell that comes within CORRIDOR_KM soonest; it
//   either reaches the station (within STATION_KM) or passes by at some
//   distance, which is reported rather than hidden.
// - Trend: the cell's rain, followed back along its track through the hour,
//   growing, steady or shrinking.
//
// Grids are Int8Array dBZ (-32 = no echo), w x h pixels, kmPerPx at the
// station; x grows east, y grows south.  Times are epoch seconds.

export const TRACK_DBZ = 6;           // motion is measured on every visible echo
const RADIUS_KM = 250;                // rain this far away counts
const NEIGHBOURS_MIN = 4;             // a pixel needs this many echo neighbours (drops speckle)
const STATION_KM = 4;                 // "reaches the station"
const CORRIDOR_KM = 15;               // "on course": passes at least this close
const PASS_KM = 60;                   // otherwise the closest pass within this is reported
const HORIZON_S = 3 * 3600;           // don't project further ahead than this
const MIN_ECHOES = 40;                // fewer echo pixels than this: too little to track
const MAX_SPEED_KMH = 150;
const STILL_KMH = 5;
const WIN_KM = 120;                   // motion window size
const WIN_MIN_FRAC = 0.03;            // a window needs this share of echo to be matched
const LAG_FRAMES = 3;                 // frames between matched pairs (30 min at 10-minute frames)
const SPREAD_MAX_KMH = 25;            // a window's estimates must agree this well
const MAX_CELL_SAMPLES = 800;         // pixels per cell projected forward
const TREND_PER_H = 0.3;              // relative change per hour that counts as a trend
const CELL_BOX_MAX = 110;             // cells wider than this (4-px blocks, ~430 km) use the windows
const CELL_MIN_FRAC = 0.01;           // a cell's box (tight around it) needs this share of echo

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Bearing (degrees from north) of a direction given as (east, south). */
const bearingOf = (ex, ey) => (Math.atan2(ex, -ey) * 180 / Math.PI + 360) % 360;

/** 1 where dBZ >= level and at least NEIGHBOURS_MIN of the 8 neighbours are too. */
export function echoMask(dbz, w, h, level) {
  const raw = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) raw[k] = dbz[k] >= level ? 1 : 0;
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (!raw[k]) continue;
      const n = raw[k - w - 1] + raw[k - w] + raw[k - w + 1] + raw[k - 1] + raw[k + 1]
        + raw[k + w - 1] + raw[k + w] + raw[k + w + 1];
      if (n >= NEIGHBOURS_MIN) mask[k] = 1;
    }
  }
  return mask;
}

/** Share of echo per b x b block. */
function blocks(mask, w, h, b) {
  const bw = Math.floor(w / b);
  const bh = Math.floor(h / b);
  const v = new Float32Array(bw * bh);
  for (let y = 0; y < bh * b; y++) {
    for (let x = 0; x < bw * b; x++) {
      if (mask[y * w + x]) v[Math.floor(y / b) * bw + Math.floor(x / b)] += 1 / (b * b);
    }
  }
  return { v, w: bw, h: bh };
}

function boxShare(g, x0, y0, ww, wh) {
  let s = 0;
  for (let y = y0; y < y0 + wh; y++) for (let x = x0; x < x0 + ww; x++) s += g.v[y * g.w + x];
  return s / (ww * wh);
}

/** Normalised correlation of window [x0, x0+ww) x [y0, y0+wh) of grid a
 *  with grid b shifted by (dx, dy), so a shift into a merely denser area
 *  doesn't win. */
function corr(a, b, x0, y0, ww, wh, dx, dy) {
  let s = 0;
  let bb = 0;
  for (let y = y0; y < y0 + wh; y++) {
    const yb = y + dy;
    if (yb < 0 || yb >= b.h) continue;
    const ra = y * a.w;
    const rb = yb * b.w;
    for (let x = x0; x < x0 + ww; x++) {
      const xb = x + dx;
      if (xb < 0 || xb >= b.w) continue;
      const vb = b.v[rb + xb];
      bb += vb * vb;
      s += a.v[ra + x] * vb;
    }
  }
  return bb > 0 ? s / Math.sqrt(bb) : 0;
}

/** Shift (dx, dy) that best lays the window of grid a onto grid b, searched
 *  within span of (cx, cy); ties go to the smaller shift.  With `subPixel`
 *  the peak is refined between whole steps by a parabola through its
 *  neighbours (whole steps of a 2-pixel grid are ~8 km/h over 30 minutes). */
function windowShift(a, b, x0, y0, ww, wh, cx, cy, span, subPixel = false) {
  let best = { dx: cx, dy: cy, score: 0 };
  for (let dy = cy - span; dy <= cy + span; dy++) {
    for (let dx = cx - span; dx <= cx + span; dx++) {
      const score = corr(a, b, x0, y0, ww, wh, dx, dy);
      const closer = dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy;
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && score > 0 && closer)) {
        best = { dx, dy, score };
      }
    }
  }
  if (subPixel && best.score > 0) {
    const peak = (m, p) => {
      const d = m - 2 * best.score + p;
      return d < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0;
    };
    const fx = peak(corr(a, b, x0, y0, ww, wh, best.dx - 1, best.dy), corr(a, b, x0, y0, ww, wh, best.dx + 1, best.dy));
    const fy = peak(corr(a, b, x0, y0, ww, wh, best.dx, best.dy - 1), corr(a, b, x0, y0, ww, wh, best.dx, best.dy + 1));
    best = { ...best, dx: best.dx + fx, dy: best.dy + fy };
  }
  return best;
}

/** Motion (km/s east, south) of the echoes in box [x0, x0+ww) x [y0, y0+wh)
 *  (4-pixel blocks): the median of every 30-minute comparison in the hour
 *  where both frames have at least minShare of echo in the box, or null if
 *  too few agree. */
function boxMotion(b4, b2, times, x0, y0, ww, wh, kmPerPx, minShare) {
  const n = b4.length;
  const lag = Math.min(LAG_FRAMES, n - 1);
  if (lag < 1) return null;
  const ests = [];
  let share = 0;
  for (let i = 0; i + lag < n; i++) {
    const j = i + lag;
    const dt = times[j] - times[i];
    if (dt <= 0) continue;
    const fa = boxShare(b4[i], x0, y0, ww, wh);
    const fb = boxShare(b4[j], x0, y0, ww, wh);
    if (fa <= 0 || fb <= 0 || fa < minShare || fb < minShare) continue;
    const span = Math.ceil(MAX_SPEED_KMH * dt / 3600 / kmPerPx / 4);
    const c = windowShift(b4[i], b4[j], x0, y0, ww, wh, 0, 0, span);
    if (c.score <= 0) continue;
    const f = windowShift(b2[i], b2[j], x0 * 2, y0 * 2, ww * 2, wh * 2, c.dx * 2, c.dy * 2, 2, true);
    if (f.score <= 0) continue;
    const vx = f.dx * 2 * kmPerPx / dt;
    const vy = f.dy * 2 * kmPerPx / dt;
    if (Math.hypot(vx, vy) * 3600 > MAX_SPEED_KMH) continue;
    ests.push([vx, vy]);
    share = Math.max(share, fb);
  }
  if (ests.length < Math.min(2, n - lag)) return null;
  const vx = median(ests.map((e) => e[0]));
  const vy = median(ests.map((e) => e[1]));
  if (ests.length >= 2 && median(ests.map((e) => Math.hypot(e[0] - vx, e[1] - vy))) * 3600 > SPREAD_MAX_KMH) return null;
  return { vx, vy, share, n: ests.length };
}

/** Motion vectors (km/s east, south) for ~120 km windows across the area
 *  around the station; keeps the block grids for cellMotion. */
export function motionField(tracks, times, w, h, sx, sy, kmPerPx) {
  const n = tracks.length;
  const out = { windows: [], global: null, b4: null, b2: null };
  if (n < 2) return out;
  const b4 = tracks.map((m) => blocks(m, w, h, 4));
  const b2 = tracks.map((m) => blocks(m, w, h, 2));
  out.b4 = b4;
  out.b2 = b2;
  const win4 = Math.max(4, Math.round(WIN_KM / kmPerPx / 4));
  const step4 = Math.max(2, Math.round(win4 / 2));
  const reach4 = (RADIUS_KM + WIN_KM / 2) / kmPerPx / 4;
  const W4 = b4[0].w;
  const H4 = b4[0].h;
  for (let y0 = 0; y0 + win4 <= H4; y0 += step4) {
    for (let x0 = 0; x0 + win4 <= W4; x0 += step4) {
      const cx = x0 + win4 / 2;
      const cy = y0 + win4 / 2;
      if (Math.hypot(cx - sx / 4, cy - sy / 4) > reach4) continue;
      const m = boxMotion(b4, b2, times, x0, y0, win4, win4, kmPerPx, WIN_MIN_FRAC);
      if (m) out.windows.push({ x: cx * 4, y: cy * 4, ...m });
    }
  }
  if (out.windows.length) {
    out.global = { vx: median(out.windows.map((v) => v.vx)), vy: median(out.windows.map((v) => v.vy)) };
  } else {
    // no window had enough echo on its own: the whole area at once
    const m = boxMotion(b4, b2, times, 0, 0, W4, H4, kmPerPx, 0);
    if (m) out.global = { vx: m.vx, vy: m.vy };
  }
  return out;
}

/** A rain cell's own motion: its whole outline (plus a margin) matched
 *  through the hour.  A window cutting across a long band can't see motion
 *  along the band (the "aperture" problem); the whole cell, ends and all, can.
 *  Null when the cell is too big or changes too much to match. */
function cellMotion(cell, field, times, w, kmPerPx) {
  if (!field.b4) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const k of cell.pts) {
    const x = k % w;
    const y = (k - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const m = 12 / kmPerPx;                                   // 12 km margin
  const W4 = field.b4[0].w;
  const H4 = field.b4[0].h;
  const bx0 = Math.max(0, Math.floor((x0 - m) / 4));
  const by0 = Math.max(0, Math.floor((y0 - m) / 4));
  const bx1 = Math.min(W4, Math.ceil((x1 + m) / 4));
  const by1 = Math.min(H4, Math.ceil((y1 + m) / 4));
  if (bx1 - bx0 > CELL_BOX_MAX || by1 - by0 > CELL_BOX_MAX || bx1 - bx0 < 3 || by1 - by0 < 3) return null;
  return boxMotion(field.b4, field.b2, times, bx0, by0, bx1 - bx0, by1 - by0, kmPerPx, CELL_MIN_FRAC);
}

/** Motion at pixel (x, y): windows weighted by closeness (a ~60 km taper). */
export function motionAt(field, x, y, kmPerPx) {
  if (!field.windows.length) return field.global;
  const L2 = (60 / kmPerPx) ** 2;
  let sw = 0;
  let vx = 0;
  let vy = 0;
  for (const v of field.windows) {
    const wt = (0.5 + v.share) / ((v.x - x) ** 2 + (v.y - y) ** 2 + L2);
    sw += wt;
    vx += wt * v.vx;
    vy += wt * v.vy;
  }
  return { vx: vx / sw, vy: vy / sw };
}

/** Connected echo cells (8-neighbour) with at least one pixel within the radius. */
export function findCells(mask, dbz, w, h, sx, sy, kmPerPx) {
  const lab = new Int32Array(w * h);
  const cells = [];
  const stack = [];
  const r2 = (RADIUS_KM / kmPerPx) ** 2;
  for (let k0 = 0; k0 < w * h; k0++) {
    if (!mask[k0] || lab[k0]) continue;
    const id = cells.length + 1;
    const pts = [];
    let maxDbz = -32;
    let inside = false;
    lab[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop();
      pts.push(k);
      if (dbz[k] > maxDbz) maxDbz = dbz[k];
      const x = k % w;
      const y = (k - x) / w;
      if ((x + 0.5 - sx) ** 2 + (y + 0.5 - sy) ** 2 <= r2) inside = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) {
            const q = yy * w + xx;
            if (mask[q] && !lab[q]) { lab[q] = id; stack.push(q); }
          }
        }
      }
    }
    if (!inside) { cells.push(null); continue; }
    let cx = 0;
    let cy = 0;
    for (const k of pts) { cx += k % w; cy += Math.floor(k / w); }
    cells.push({ pts, maxDbz, cx: cx / pts.length + 0.5, cy: cy / pts.length + 0.5 });
  }
  return cells.filter(Boolean);
}

/** When a cell moving at (vx, vy) km/s first comes within CORRIDOR_KM and
 *  STATION_KM of the station, its closest pass within the horizon, and which
 *  part of it is on course (`from`: where that part is now; `to`: where it
 *  passes closest) - for a big band that isn't its nearest edge. */
function project(cell, vx, vy, w, sx, sy, kmPerPx) {
  const v2 = vx * vx + vy * vy;
  const sp = Math.sqrt(v2);
  const res = {
    near: null, reach: null, pass: { miss: Infinity, ex: 0, ey: 0, t: 0 }, lead: { d: Infinity, ex: 0, ey: 0 },
    nearPx: null, reachPx: null, passPx: null,
  };
  const step = Math.max(1, Math.ceil(cell.pts.length / MAX_CELL_SAMPLES));
  for (let i = 0; i < cell.pts.length; i += step) {
    const k = cell.pts[i];
    const x = k % w;
    const ex = (x + 0.5 - sx) * kmPerPx;
    const ey = ((k - x) / w + 0.5 - sy) * kmPerPx;
    const d = Math.hypot(ex, ey);
    if (d < res.lead.d) res.lead = { d, ex, ey };
    if (!v2) continue;
    const tc = -(ex * vx + ey * vy) / v2;           // time of closest approach (s)
    if (tc <= 0) continue;                          // already moving away
    const tce = Math.min(tc, HORIZON_S);
    const mx = ex + vx * tce;
    const my = ey + vy * tce;
    const miss = Math.hypot(mx, my);
    if (miss < res.pass.miss) {
      res.pass = { miss, ex: mx, ey: my, t: tce, closing: tc > HORIZON_S };   // closing: still nearing at the horizon
      res.passPx = { ex, ey, tc: tce };
    }
    const closest = Math.hypot(ex + vx * tc, ey + vy * tc);
    for (const [key, R] of [['near', CORRIDOR_KM], ['reach', STATION_KM]]) {
      if (closest > R) continue;
      const t = Math.max(0, tc - Math.sqrt(R * R - closest * closest) / sp);
      if (t <= HORIZON_S && (res[key] === null || t < res[key])) {
        res[key] = t;
        res[`${key}Px`] = { ex, ey, tc };
      }
    }
  }
  const on = res.reachPx || res.nearPx || res.passPx;
  if (on) {
    res.from = { ex: on.ex, ey: on.ey, d: Math.hypot(on.ex, on.ey) };
    res.to = { ex: on.ex + vx * on.tc, ey: on.ey + vy * on.tc };
  }
  return res;
}

/** Strengthening / steady / weakening: the cell's rain (dBZ above the level,
 *  summed) followed back along its track through every frame of the hour. */
function cellTrend(grids, times, w, h, cell, vx, vy, kmPerPx, minDbz) {
  const tNow = times[times.length - 1];
  const r = Math.sqrt(cell.pts.length / Math.PI) + 10 / kmPerPx;
  const pts = [];
  grids.forEach((g, f) => {
    const back = tNow - times[f];
    const px = cell.cx - vx * back / kmPerPx;
    const py = cell.cy - vy * back / kmPerPx;
    let s = 0;
    for (let y = Math.max(0, Math.floor(py - r)); y <= Math.min(h - 1, Math.ceil(py + r)); y++) {
      for (let x = Math.max(0, Math.floor(px - r)); x <= Math.min(w - 1, Math.ceil(px + r)); x++) {
        if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 > r * r) continue;
        const d = g[y * w + x];
        if (d >= minDbz) s += d - minDbz + 1;
      }
    }
    pts.push([(times[f] - tNow) / 3600, s]);
  });
  if (pts.length < 3) return null;
  const mt = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const ms = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  if (ms <= 0) return null;
  let num = 0;
  let den = 0;
  for (const [t, s] of pts) { num += (t - mt) * (s - ms); den += (t - mt) ** 2; }
  const rel = den ? num / den / ms : 0;             // share of the mean, per hour
  return { label: rel > TREND_PER_H ? 'strengthening' : rel < -TREND_PER_H ? 'weakening' : 'steady', rel };
}

/**
 * Track the rain around the station.
 * @param {object} o
 * @param {Int8Array[]} o.grids  dBZ per frame, oldest first (the last is "now")
 * @param {number[]} o.times     epoch seconds per frame
 * @param {number} o.w, o.h, o.sx, o.sy, o.kmPerPx, o.minDbz
 * @returns {object} distances in km east (ex) / south (ey) of the station,
 *   times in seconds from the newest frame, speeds in km/h, bearings in degrees.
 */
export function trackRain({ grids, times, w, h, sx, sy, kmPerPx, minDbz }) {
  const now = grids.length - 1;
  const rain = echoMask(grids[now], w, h, minDbz);
  const out = { echoes: 0, nearest: null, atStation: false, motion: null, approach: null };

  // nearest rain within the radius
  let best = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!rain[y * w + x]) continue;
      const ex = (x + 0.5 - sx) * kmPerPx;
      const ey = (y + 0.5 - sy) * kmPerPx;
      const d = Math.hypot(ex, ey);
      if (d > RADIUS_KM) continue;
      out.echoes++;
      if (d < best) { best = d; out.nearest = { ex, ey, d }; }
    }
  }
  if (!out.nearest) return out;
  out.atStation = best <= STATION_KM;

  // motion, from every visible echo through the hour
  const tracks = grids.map((g) => echoMask(g, w, h, TRACK_DBZ));
  let tracked = 0;
  for (let k = 0; k < tracks[now].length; k++) tracked += tracks[now][k];
  if (grids.length < 2 || tracked < MIN_ECHOES) return out;
  const field = motionField(tracks, times, w, h, sx, sy, kmPerPx);
  if (!field.global) return out;
  const gs = Math.hypot(field.global.vx, field.global.vy) * 3600;
  out.motion = { ...field.global, speed: gs, toward: bearingOf(field.global.vx, field.global.vy), still: gs < STILL_KMH };
  out.windows = field.windows.length;
  if (out.atStation) return out;

  // the cell that comes within the corridor soonest; failing that, the one
  // that passes closest (a near miss is still worth knowing about)
  let pick = null;
  let close = null;
  for (const cell of findCells(rain, grids[now], w, h, sx, sy, kmPerPx)) {
    const v = cellMotion(cell, field, times, w, kmPerPx) || motionAt(field, cell.cx, cell.cy, kmPerPx);
    const speed = Math.hypot(v.vx, v.vy) * 3600;
    if (speed < STILL_KMH) continue;
    const p = project(cell, v.vx, v.vy, w, sx, sy, kmPerPx);
    if (p.near === null) {
      if (p.passPx && p.pass.miss <= PASS_KM && (!close || p.pass.miss < close.p.pass.miss)) close = { cell, v, speed, p };
      continue;
    }
    if (!pick || p.near < pick.p.near - 60 || (Math.abs(p.near - pick.p.near) <= 60 && cell.maxDbz > pick.cell.maxDbz)) {
      pick = { cell, v, speed, p };
    }
  }
  if (!pick && !close) return out;
  const { cell, v, speed, p } = pick || close;
  out.approach = {
    onCourse: !!pick,
    lead: p.lead,
    from: p.from,
    to: p.to,
    centroid: { ex: (cell.cx - sx) * kmPerPx, ey: (cell.cy - sy) * kmPerPx },
    areaKm2: cell.pts.length * kmPerPx * kmPerPx,
    maxDbz: cell.maxDbz,
    vx: v.vx,
    vy: v.vy,
    speed,
    toward: bearingOf(v.vx, v.vy),
    near: p.near,
    reach: p.reach,
    pass: p.pass,
    trend: cellTrend(grids, times, w, h, cell, v.vx, v.vy, kmPerPx, minDbz),
  };
  return out;
}
