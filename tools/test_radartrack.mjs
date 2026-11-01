// Synthetic radar scenes for js/radartrack.js: known motion in, check the
// tracking gets it back.  Run: node tools/test_radartrack.mjs
import { trackRain } from '../skins/jhwx/js/radartrack.js';

const KM = 2;                  // km per pixel (zoom 6 at ~37°S is ~1.94)
const STEP = 600;              // 10-minute frames
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

/** Seeded random, so a failure can be reproduced. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** A textured blob: a disc of `dbz` with ragged edges and lumps (fixed by seed). */
function blob(seed, r) {
  const rand = rng(seed);
  const cells = [];
  for (let i = 0; i < 10; i++) cells.push([(rand() - 0.5) * r * 1.2, (rand() - 0.5) * r * 1.2, r * (0.35 + rand() * 0.4)]);
  return cells;
}

function scene({ w = 400, h = 400, frames = 7, objs }) {
  const grids = [];
  const times = [];
  for (let f = 0; f < frames; f++) {
    const g = new Int8Array(w * h).fill(-32);
    const back = (frames - 1 - f) * STEP;          // seconds before "now"
    for (const o of objs) {
      const cx = o.x - o.vx * back / 3600 / KM;     // vx, vy in km/h (east, south)
      const cy = o.y - o.vy * back / 3600 / KM;
      const dbz = o.dbz + (o.dDbzPerH || 0) * (-back / 3600);
      const scale = 1 + (o.growPerH || 0) * (-back / 3600);
      for (const [ox, oy, rr] of o.shape) {
        const r = rr * scale;
        for (let y = Math.floor(cy + oy - r); y <= cy + oy + r; y++) {
          for (let x = Math.floor(cx + ox - r); x <= cx + ox + r; x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if ((x - cx - ox) ** 2 + (y - cy - oy) ** 2 > r * r) continue;
            const k = y * w + x;
            g[k] = Math.max(g[k], Math.round(dbz));
          }
        }
      }
    }
    grids.push(g);
    times.push(1_800_000_000 - back);
  }
  return { grids, times, w, h, sx: w / 2, sy: h / 2, kmPerPx: KM };
}

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// 1. A shower 120 km west heading straight for the station at 60 km/h, while a
//    bigger drizzle field to the north-east drifts north: the old single
//    motion would follow the drizzle; per-area motion must not.
{
  const s = scene({ objs: [
    { x: 200 - 60, y: 200, vx: 60, vy: 0, dbz: 38, shape: blob(1, 10) },
    { x: 320, y: 90, vx: 0, vy: -30, dbz: 12, shape: [...blob(2, 30), ...blob(3, 26).map(([a, b, r]) => [a + 30, b + 20, r])] },
  ] });
  const r = trackRain({ ...s, minDbz: 20 });
  const a = r.approach;
  check('1 approaching shower found', !!a && a.onCourse, a ? `${Math.round(a.from.d)} km` : 'none');
  if (a) {
    check('1 its motion is east ~60 km/h', angle(a.toward, 90) < 15 && Math.abs(a.speed - 60) < 15,
      `${Math.round(a.toward)}° ${Math.round(a.speed)} km/h`);
    const etaH = a.reach / 3600;
    const expect = (a.from.d - 4) / 60;
    check('1 reaches the station on time', a.reach !== null && Math.abs(etaH - expect) < 0.35,
      `${etaH.toFixed(2)} h vs ~${expect.toFixed(2)} h`);
  }
}

// 2. A small shower that passes ~12 km north of the station: reported as a pass.
{
  const s = scene({ objs: [{ x: 200 - 50, y: 200 - 7, vx: 50, vy: 0, dbz: 35, shape: blob(4, 4) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  const a = r.approach;
  check('2 near miss is reported', !!a && a.reach === null && a.pass.miss > 4 && a.pass.miss <= 15,
    a ? `reach ${a.reach}, pass ${a.pass.miss.toFixed(1)} km` : 'none');
  if (a) check('2 it passes to the north', a.pass.ey < 0, `pass at ey ${a.pass.ey.toFixed(1)} km`);
}

// 3. The same shower, weakening through the hour: trend says so.
{
  const s = scene({ objs: [{ x: 200 - 60, y: 200, vx: 60, vy: 0, dbz: 30, dDbzPerH: -12, growPerH: -0.4, shape: blob(5, 10) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  check('3 weakening shower', r.approach && r.approach.trend && r.approach.trend.label === 'weakening',
    r.approach && r.approach.trend ? `${r.approach.trend.label} ${r.approach.trend.rel.toFixed(2)}/h` : 'no trend');
}

// 4. Growing shower: strengthening.
{
  const s = scene({ objs: [{ x: 200 - 60, y: 200, vx: 60, vy: 0, dbz: 30, dDbzPerH: 8, growPerH: 0.5, shape: blob(6, 8) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  check('4 strengthening shower', r.approach && r.approach.trend && r.approach.trend.label === 'strengthening',
    r.approach && r.approach.trend ? `${r.approach.trend.label} ${r.approach.trend.rel.toFixed(2)}/h` : 'no trend');
}

// 5. Rain moving away (west of the station, heading west): nothing approaching.
{
  const s = scene({ objs: [{ x: 200 - 40, y: 200, vx: -50, vy: 0, dbz: 35, shape: blob(7, 10) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  check('5 rain moving away is not approaching', r.nearest && !r.approach, r.approach ? 'approach found' : `nearest ${Math.round(r.nearest.d)} km`);
}

// 6. The nearest rain moves away while a farther band comes straight in: the
//    band is the approaching rain, not the nearest echo.
{
  const s = scene({ objs: [
    { x: 200 + 20, y: 200 + 5, vx: 40, vy: 0, dbz: 30, shape: blob(8, 5) },          // 40 km E, leaving
    { x: 200 - 45, y: 200 - 45, vx: 40, vy: 40, dbz: 36, shape: blob(9, 9) },        // ~127 km NW, coming SE
  ] });
  const r = trackRain({ ...s, minDbz: 20 });
  const a = r.approach;
  check('6 approaching band is not the nearest echo', !!a && a.from.d > 60 && r.nearest.d < 50,
    a ? `nearest ${Math.round(r.nearest.d)} km, approaching ${Math.round(a.from.d)} km toward ${Math.round(a.toward)}°` : 'none');
}

// 7. Below the threshold (drizzle only) nothing counts as rain.
{
  const s = scene({ objs: [{ x: 200 - 30, y: 200, vx: 60, vy: 0, dbz: 12, shape: blob(10, 10) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  check('7 drizzle below the threshold is ignored', !r.nearest && !r.approach);
  const any = trackRain({ ...s, minDbz: 6 });
  check('7 ... but counts at "any echo"', !!any.nearest && !!any.approach);
}

// 11. A shower that passes ~35 km south: not on course, but reported as the
//     closest pass; one passing 100 km away is not reported at all.
{
  const near = trackRain({ ...scene({ objs: [{ x: 200 - 60, y: 200 + 20, vx: 50, vy: 0, dbz: 35, shape: blob(30, 4) }] }), minDbz: 20 });
  const a = near.approach;
  check('11 near miss 35 km south is reported, not on course', !!a && !a.onCourse && a.pass.miss > 15 && a.pass.miss < 60 && a.pass.ey > 0,
    a ? `onCourse ${a.onCourse}, pass ${a.pass.miss.toFixed(0)} km at ey ${a.pass.ey.toFixed(0)}` : 'none');
  const far = trackRain({ ...scene({ objs: [{ x: 200 - 60, y: 200 + 50, vx: 50, vy: 0, dbz: 35, shape: blob(31, 4) }] }), minDbz: 20 });
  check('11 a pass 100 km away is not reported', !far.approach, far.approach ? `pass ${far.approach.pass.miss.toFixed(0)} km` : '');
}

// 10. A long band slanting from 90 km N down to 10 km S, west of the station,
//     moving east: its nearest edge is to the north, but the part heading
//     here is the bit level with the station - report that part.
{
  const shape = [];
  for (let i = 0; i <= 12; i++) shape.push([-i * 3.5, -40 + i * 4.5, 5]);   // px offsets along the band
  const s = scene({ objs: [{ x: 200 - 15, y: 200, vx: 50, vy: 0, dbz: 32, shape }] });
  const r = trackRain({ ...s, minDbz: 20 });
  const a = r.approach;
  check('10 on-course part of a long band, not its nearest edge', !!a && Math.abs(a.from.ey) < 15 && a.from.ex < 0,
    a ? `on course ${Math.round(a.from.d)} km at (${Math.round(a.from.ex)}, ${Math.round(a.from.ey)}); edge ${Math.round(a.lead.d)} km at (${Math.round(a.lead.ex)}, ${Math.round(a.lead.ey)})` : 'none');
}

// 9. Speed and direction across a range of motions: within 10% / 12 degrees.
for (const [vx, vy] of [[30, 0], [60, 0], [90, 0], [-45, 0], [0, 50], [40, -40], [-70, 30]]) {
  const sp = Math.hypot(vx, vy);
  const d = 80 / KM;                                  // start 80 km upwind, heading for the station
  const s = scene({ objs: [{ x: 200 - vx / sp * d, y: 200 - vy / sp * d, vx, vy, dbz: 35, shape: blob(20 + vx, 9) }] });
  const r = trackRain({ ...s, minDbz: 20 });
  const a = r.approach;
  const want = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
  check(`9 motion ${sp.toFixed(0)} km/h toward ${Math.round(want)}°`,
    !!a && Math.abs(a.speed - sp) / sp < 0.1 && angle(a.toward, want) < 12,
    a ? `${Math.round(a.speed)} km/h toward ${Math.round(a.toward)}°` : 'none');
}

// 8. Speed: a full analysis block (3 x 3 tiles) with several systems.
{
  const s = scene({ w: 768, h: 768, objs: [
    { x: 300, y: 384, vx: 55, vy: 10, dbz: 38, shape: blob(11, 14) },
    { x: 560, y: 220, vx: -20, vy: 35, dbz: 25, shape: blob(12, 30) },
    { x: 250, y: 600, vx: 30, vy: -30, dbz: 15, shape: blob(13, 40) },
    { x: 600, y: 600, vx: 0, vy: -40, dbz: 45, shape: blob(14, 8) },
  ] });
  const t0 = performance.now();
  const r = trackRain({ ...s, minDbz: 20 });
  const ms = performance.now() - t0;
  check('8 full-size analysis under 1.5 s', ms < 1500, `${Math.round(ms)} ms, ${r.windows} motion windows`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
