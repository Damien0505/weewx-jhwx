// "Rain near the station" from RainViewer radar tiles: nearest echo, echo
// motion over the last 30 minutes and a rough arrival estimate.  The tiles
// are read pixel by pixel in a canvas (RainViewer sends CORS headers).
//
// Estimates only: free-tier tiles stop at zoom 7, the analysis runs at zoom 6
// (~2 km per pixel here), and a radar echo is not always rain at the ground.

import { distBearing } from './maps.js';

const ZOOM = 6;
const RADIUS_KM = 250;          // area analysed around the station
const ALPHA_MIN = 100;          // pixel counts as an echo above this opacity
const NEIGHBOURS_MIN = 4;       // ... and with this many echo neighbours (drops speckle)
const STATION_KM = 4;           // "rain at the station": an echo this close
const ARRIVAL_KM = 6;           // an echo passing this close counts as arriving
const ARRIVAL_MAX_S = 3 * 3600; // don't project further ahead than this
const MIN_ECHOES = 40;          // fewer pixels than this: too little to track
const MAX_SPEED_KMH = 150;
const TIMEOUT_MS = 15000;

const TILE = 256;

function worldPx(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: (lon + 180) / 360 * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

function pxToLatLon(x, y, z) {
  const n = TILE * 2 ** z;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { lat, lon };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('timed out')); }, TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('tile failed to load')); };
    img.src = url;
  });
}

/** Echo mask (Uint8Array, 1 = echo) for one frame over the tile block. */
async function frameMask(host, frame, block) {
  const { tx0, ty0, nx, ny } = block;
  const cv = document.createElement('canvas');
  cv.width = nx * TILE;
  cv.height = ny * TILE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const url = `${host}${frame.path}/${TILE}/${ZOOM}/${tx0 + i}/${ty0 + j}/2/0_0.png`;
      jobs.push(loadImage(url).then((img) => ctx.drawImage(img, i * TILE, j * TILE)));
    }
  }
  await Promise.all(jobs);
  const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
  const w = cv.width;
  const h = cv.height;
  const raw = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) raw[k] = data[k * 4 + 3] > ALPHA_MIN ? 1 : 0;
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
  return { mask, w, h };
}

/** Sum the mask into b x b blocks (fraction of echo per block). */
function blocks(m, b) {
  const bw = Math.floor(m.w / b);
  const bh = Math.floor(m.h / b);
  const out = new Float32Array(bw * bh);
  for (let y = 0; y < bh * b; y++) {
    for (let x = 0; x < bw * b; x++) {
      if (m.mask[y * m.w + x]) out[Math.floor(y / b) * bw + Math.floor(x / b)] += 1 / (b * b);
    }
  }
  return { v: out, w: bw, h: bh };
}

/** Best shift (dx, dy) of grid a onto grid b, searched around (cx, cy). */
function bestShift(a, b, cx, cy, span) {
  let best = { dx: cx, dy: cy, score: -1 };
  for (let dy = cy - span; dy <= cy + span; dy++) {
    for (let dx = cx - span; dx <= cx + span; dx++) {
      let s = 0;
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(a.h, a.h - dy);
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(a.w, a.w - dx);
      for (let y = y0; y < y1; y++) {
        const ra = y * a.w;
        const rb = (y + dy) * a.w + dx;
        for (let x = x0; x < x1; x++) {
          const va = a.v[ra + x];
          if (va) s += va * b.v[rb + x];
        }
      }
      if (s > best.score) best = { dx, dy, score: s };
    }
  }
  return best;
}

/**
 * @param {string} host  RainViewer host
 * @param {Array<{time:number,path:string}>} frames  past frames, oldest first
 * @returns {Promise<object>} { time, echoes, nearest, atStation, motion, arrival }
 */
export async function analyseRadar(host, frames, lat, lon) {
  const now = frames[frames.length - 1];
  // the frame closest to 30 minutes before the newest one
  let prev = null;
  for (const f of frames) {
    if (f === now) continue;
    if (!prev || Math.abs(now.time - f.time - 1800) < Math.abs(now.time - prev.time - 1800)) prev = f;
  }
  const st = worldPx(lat, lon, ZOOM);
  const kmPerPx = 40075.016686 * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** ZOOM);
  const rPx = RADIUS_KM / kmPerPx;
  const tx0 = Math.floor((st.x - rPx) / TILE);
  const ty0 = Math.floor((st.y - rPx) / TILE);
  const block = {
    tx0, ty0, nx: Math.floor((st.x + rPx) / TILE) - tx0 + 1, ny: Math.floor((st.y + rPx) / TILE) - ty0 + 1,
  };
  const sx = st.x - tx0 * TILE;   // station in block pixels
  const sy = st.y - ty0 * TILE;

  const cur = await frameMask(host, now, block);
  const out = { time: now.time, echoes: 0, nearest: null, atStation: false, motion: null, arrival: null };

  // nearest echo and echo list (km east/south of the station) within the radius
  const pts = [];
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let y = 0; y < cur.h; y++) {
    for (let x = 0; x < cur.w; x++) {
      if (!cur.mask[y * cur.w + x]) continue;
      const ex = (x + 0.5 - sx) * kmPerPx;
      const ey = (y + 0.5 - sy) * kmPerPx;
      const d = Math.hypot(ex, ey);
      if (d > RADIUS_KM) continue;
      pts.push(ex, ey);
      if (d < best) { best = d; bx = x + 0.5; by = y + 0.5; }
    }
  }
  out.echoes = pts.length / 2;
  if (out.echoes) {
    const p = pxToLatLon(tx0 * TILE + bx, ty0 * TILE + by, ZOOM);
    out.nearest = { ...distBearing(lat, lon, p.lat, p.lon), lat: p.lat, lon: p.lon };
    out.atStation = best <= STATION_KM;
  }
  if (!prev || out.echoes < MIN_ECHOES) return out;

  // motion: cross-correlate the older frame onto the newest, coarse then fine
  const old = await frameMask(host, prev, block);
  const dt = now.time - prev.time;
  const span = Math.ceil(MAX_SPEED_KMH * dt / 3600 / kmPerPx);
  const c4 = bestShift(blocks(old, 4), blocks(cur, 4), 0, 0, Math.ceil(span / 4));
  const f2 = bestShift(blocks(old, 2), blocks(cur, 2), c4.dx * 2, c4.dy * 2, 2);
  if (f2.score <= 0) return out;
  const vx = f2.dx * 2 * kmPerPx / dt;     // km/s east
  const vy = f2.dy * 2 * kmPerPx / dt;     // km/s south
  const speed = Math.hypot(vx, vy) * 3600;
  out.motion = { speed, toward: (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360, still: speed < 5 };
  if (out.motion.still || out.atStation) return out;

  // arrival: soonest time any echo passes within ARRIVAL_KM of the station
  const v2 = vx * vx + vy * vy;
  let first = Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const px = pts[k];
    const py = pts[k + 1];
    const tc = -(px * vx + py * vy) / v2;           // time of closest approach (s)
    if (tc <= 0) continue;
    const cx = px + vx * tc;
    const cy = py + vy * tc;
    const miss = Math.hypot(cx, cy);
    if (miss > ARRIVAL_KM) continue;
    const t = tc - Math.sqrt(ARRIVAL_KM ** 2 - miss ** 2) / Math.sqrt(v2);
    if (t < first) first = t;
  }
  // count from the newest frame's time, not from now
  if (first <= ARRIVAL_MAX_S) out.arrival = now.time + Math.max(0, first);
  return out;
}
