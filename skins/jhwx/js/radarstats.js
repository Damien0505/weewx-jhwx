// "Rain near the station" from RainViewer radar tiles: the last hour of
// frames is read pixel by pixel in a canvas (RainViewer sends CORS headers),
// turned into dBZ grids and handed to radartrack.js, which finds the nearest
// rain, the motion area by area and the rain heading for the station.
//
// Estimates only: free-tier tiles stop at zoom 7, the analysis runs at zoom 6
// (~2 km per pixel here), and a radar echo is not always rain at the ground.
//
// Only echoes at or above a chosen radar reflectivity count (minDbz): each
// pixel's colour is looked up in RainViewer's Universal Blue table to get its
// dBZ, so drizzle and virga can be left out.

import { distBearing } from './maps.js';
import { trackRain } from './radartrack.js';

const ZOOM = 6;
const BLOCK_KM = 330;           // tiles loaded this far around the station (rain counts to 250 km)
const TIMEOUT_MS = 15000;

const TILE = 256;

// RainViewer "Universal Blue" (colour scheme 2, rain), one RGBA hex per dBZ
// step from UB_FIRST_DBZ upward; from rainviewer.com/files/rainviewer_api_colors_table.csv
const UB_FIRST_DBZ = -10;
const UB_RAIN = '6361591466635a1969665c1e6c685d246f6b5f29726e612e75706234787364397c75653e7f786744827b6949857d6a4e88806c548b826d598e856f5e928871649e93756eaa9e7978b6a97e82c2b4828ccec08796d2c48ba0d6c88faadacc93b4ded097be88ddeeff6cd1ebff51c5e8ff36bae5ff1baee2ff00a3e0ff009ad5ff0091caff0088bfff007fb4ff0077aaff0070a3ff00699cff006295ff005b8eff005588ff005180ff004e78ff004a70ff004768ffffee00ffffe000ffffd200ffffc500ffffb700ffffaa00ffff9f00ffff9500ffff8b00ffff8100ffff4400fff23600ffe62800ffd91b00ffcd0d00ffc10000ffa80000ff8f0000ff760000ff5d0000ffffaaffffff9fffffff95ffffff8bffffff81ffffff77ffffff6cffffff62ffffff58ffffff4effffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff';

// Which echoes count, by reflectivity (dBZ ~ rain rate by Marshall-Palmer).
// 6 dBZ matches the old opacity rule (every visible echo).
export const RADAR_LEVELS = [
  { dbz: 6, label: 'Any echo', short: 'any echo' },
  { dbz: 20, label: 'Light rain or heavier (20+ dBZ)', short: 'light rain or heavier' },
  { dbz: 30, label: 'Moderate rain or heavier (30+ dBZ)', short: 'moderate rain or heavier' },
  { dbz: 40, label: 'Heavy rain (40+ dBZ)', short: 'heavy rain' },
];
export const DEFAULT_MIN_DBZ = 20;

const UB = [];                  // [r, g, b, a, dBZ]
for (let k = 0; k < UB_RAIN.length; k += 8) {
  const c = [0, 2, 4, 6].map((o) => parseInt(UB_RAIN.slice(k + o, k + o + 2), 16));
  UB.push([...c, UB_FIRST_DBZ + k / 8]);
}
const dbzCache = new Map();

/** dBZ of a tile pixel: the nearest Universal Blue colour (canvas reads of
 *  translucent pixels can be a step or two off), or -32 for no echo. */
function dbzOf(r, g, b, a) {
  if (a === 0) return -32;
  const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  let v = dbzCache.get(key);
  if (v !== undefined) return v;
  let best = Infinity;
  for (const c of UB) {
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 + (c[3] - a) ** 2;
    if (d < best) { best = d; v = c[4]; }
  }
  dbzCache.set(key, v);
  return v;
}

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

/** dBZ grid (Int8Array, -32 = no echo) of one frame over the tile block. */
async function frameDbz(host, frame, block) {
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
  const dbz = new Int8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const o = k * 4;
    dbz[k] = data[o + 3] ? dbzOf(data[o], data[o + 1], data[o + 2], data[o + 3]) : -32;
  }
  return { dbz, w, h };
}

/**
 * Rain near the station from the last hour of radar.
 * @param {string} host  RainViewer host
 * @param {Array<{time:number,path:string}>} frames  past frames, oldest first
 * @param {number} minDbz  weakest echo that counts as rain (RADAR_LEVELS)
 * @returns {Promise<object>} { time, minDbz, frames, echoes, nearest, atStation,
 *   motion, approach, arrival } - places have lat, lon, dist (km), bearing.
 */
export async function analyseRadar(host, frames, lat, lon, minDbz = DEFAULT_MIN_DBZ) {
  const now = frames[frames.length - 1];
  const st = worldPx(lat, lon, ZOOM);
  const kmPerPx = 40075.016686 * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** ZOOM);
  const rPx = BLOCK_KM / kmPerPx;
  const tx0 = Math.floor((st.x - rPx) / TILE);
  const ty0 = Math.floor((st.y - rPx) / TILE);
  const block = {
    tx0, ty0, nx: Math.floor((st.x + rPx) / TILE) - tx0 + 1, ny: Math.floor((st.y + rPx) / TILE) - ty0 + 1,
  };
  const sx = st.x - tx0 * TILE;   // station in block pixels
  const sy = st.y - ty0 * TILE;

  // every frame of the hour; older ones that fail to load are left out
  const got = await Promise.allSettled(frames.map((f) => frameDbz(host, f, block)));
  const newest = got[got.length - 1];
  if (newest.status !== 'fulfilled') throw newest.reason;
  const used = got.map((r, i) => [r, frames[i]]).filter(([r]) => r.status === 'fulfilled');
  const { w, h } = newest.value;
  const t = trackRain({
    grids: used.map(([r]) => r.value.dbz), times: used.map(([, f]) => f.time), w, h, sx, sy, kmPerPx, minDbz,
  });

  const toLL = (ex, ey) => pxToLatLon(tx0 * TILE + sx + ex / kmPerPx, ty0 * TILE + sy + ey / kmPerPx, ZOOM);
  const place = (ex, ey) => { const p = toLL(ex, ey); return { ...distBearing(lat, lon, p.lat, p.lon), lat: p.lat, lon: p.lon }; };
  const out = {
    time: now.time, minDbz, frames: used.length, echoes: t.echoes,
    nearest: t.nearest ? place(t.nearest.ex, t.nearest.ey) : null,
    atStation: t.atStation,
    motion: t.motion ? { speed: t.motion.speed, toward: t.motion.toward, still: t.motion.still } : null,
    approach: null,
    arrival: null,
  };
  const a = t.approach;
  if (a) {
    const pass = place(a.pass.ex, a.pass.ey);
    out.approach = {
      onCourse: a.onCourse,                           // false: the closest near miss instead
      ...place(a.from.ex, a.from.ey),                 // the part of the rain that's on course, now
      to: toLL(a.to.ex, a.to.ey),                     // where that part passes the station closest
      edge: place(a.lead.ex, a.lead.ey),              // the cell's nearest edge now
      areaKm2: a.areaKm2,
      speed: a.speed,
      toward: a.toward,
      maxDbz: a.maxDbz,
      eta: a.reach !== null ? now.time + a.reach : null,
      pass: { dist: a.pass.miss, side: pass.bearing, time: now.time + a.pass.t, closing: a.pass.closing },
      trend: a.trend ? a.trend.label : null,
    };
    out.arrival = out.approach.eta;
  }
  return out;
}
