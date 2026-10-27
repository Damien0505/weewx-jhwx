// History pop-up: Day / Week / Month / Year chart, almanac grid and NOAA reports.

import { loadJson } from './data.js';
import { fmt, fmtTime, compassPoint, conv, unitLabel, unitDp } from './units.js';
import { ffdiSeries, fireBand, FIRE_LEVELS } from './fire.js';

const W = 800;
const H = 260;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// What each tile's pop-up charts.  day: archive fields from day.json (and
// week.json, 30-minute bins); band/mean/bars: daily aggregates from
// month.json / year.json.  dash2: line2 is a dashed reference (no mean).
const VIEWS = {
  temp: {
    title: 'Temperature', unit: '°C', dp: 1, group: 'temp',
    day: { line: 'outTemp', line2: 'dewpoint', l1: 'Temperature', l2: 'Dew point' },
    period: { band: ['outTemp', 'min', 'max'], mean: ['outTemp', 'avg'], bandName: 'Daily high–low', lineName: 'Mean' },
  },
  hum: {
    title: 'Humidity', unit: '%', dp: 0,
    day: { line: 'outHumidity', l1: 'Relative humidity' },
    period: { band: ['outHumidity', 'min', 'max'], mean: ['outHumidity', 'avg'], bandName: 'Daily high–low', lineName: 'Mean' },
  },
  wind: {
    title: 'Wind', unit: 'km/h', dp: 1, group: 'wind',
    day: { line: 'windSpeed', line2: 'windGust', l1: 'Average speed', l2: 'Gust' },
    period: { band: ['windSpeed', 'avg', null, 'windGust', 'max'], mean: ['windSpeed', 'avg'], bandName: 'Average to max gust', lineName: 'Average' },
  },
  rain: {
    title: 'Rain', unit: 'mm', dp: 1, sum: true, group: 'rain',
    day: { bars: 'rain', binS: 1800, l1: 'Rain per 30 min', lWeek: 'Rain per 6 hours' },
    period: { bars: ['rain', 'sum'], monthName: 'Daily rain', yearName: 'Weekly rain', yearAgg: 'sum' },
  },
  baro: {
    title: 'Barometer', unit: 'hPa', dp: 1, group: 'pressure',
    day: { line: 'barometer', l1: 'Sea-level pressure' },
    period: { band: ['barometer', 'min', 'max'], mean: ['barometer', 'avg'], bandName: 'Daily high–low', lineName: 'Mean' },
  },
  solar: {
    title: 'Solar radiation', unit: 'W/m²', dp: 0, area: true,
    day: { line: 'radiation', l1: 'Solar radiation', line2: 'maxSolarRad', l2: 'Clear-sky max', dash2: true },
    period: { bars: ['radiation', 'energy'], scale: 0.001, unit: 'kWh/m²', dp: 1, monthName: 'Daily energy', yearName: 'Average daily energy', yearAgg: 'avg' },
  },
  uv: {
    title: 'UV index', unit: 'UVI', dp: 1, area: true,
    day: { line: 'UV', l1: 'UV index' },
    period: { bars: ['UV', 'max'], monthName: 'Daily max UV', yearName: 'Weekly max UV', yearAgg: 'max' },
  },
  // cap / batt: filled in from config.json options.power (see powerView)
  et: {
    title: 'Evapotranspiration', unit: 'mm', dp: 1, sum: true, group: 'rain', explainET: true,
    day: { bars: 'ET', binS: 1800, l1: 'ET per 30 min', lWeek: 'ET per 6 hours' },
    period: { bars: ['ET', 'sum'], monthName: 'Daily ET', yearName: 'Weekly ET', yearAgg: 'sum' },
  },
  fire: {
    title: 'Fire danger (Forest FFDI)', unit: 'FFDI', dp: 0, fire: true,
    // coloured rating bands behind the FFDI line; the hover names the level
    zones: FIRE_LEVELS.filter((l) => l.min > 0).map((l, i, a) => ({ from: l.min, to: i ? a[i - 1].min : Infinity, color: l.color })),
    suffix: (v) => { const b = fireBand(v); return b ? ` · ${b.name}` : ''; },
    day: { line: 'ffdi', l1: 'Forest FFDI (indicative)' },
    period: { bars: ['droughtFactor', 'avg'], unit: 'DF', dp: 1, monthName: 'Drought factor', yearName: 'Weekly mean drought factor', yearAgg: 'avg' },
  },
  indoor: {
    title: 'Indoor', unit: '°C', dp: 1, group: 'temp',
    day: { line: 'inTemp', l1: 'Indoor temperature' },
    period: { band: ['inTemp', 'min', 'max'], mean: ['inTemp', 'avg'], bandName: 'Daily high–low', lineName: 'Mean' },
  },
};

/** History view for a configured voltage reading. */
function powerView(p) {
  return {
    title: `${p.label} voltage`, unit: 'V', dp: 2,
    day: { line: p.field, l1: p.label },
    period: { band: [p.field, 'min', 'max'], mean: [p.field, 'avg'], bandName: 'Daily high–low', lineName: 'Mean' },
  };
}

// ---------------------------------------------------------------- charts

function niceScale(lo, hi) {
  const span = (hi - lo) || 1;
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const st = steps.find((x) => span / x <= 5) || 2000;
  const y0 = Math.floor(lo / st) * st;
  let y1 = Math.ceil(hi / st) * st;
  if (y1 === y0) y1 = y0 + st;
  return { y0, y1, st, n: Math.round((y1 - y0) / st) };
}

/** Build SVG paths for a chart.  x is time (epoch s) in [t0, t1]. */
function buildChart(spec) {
  const { t0, t1, lines = [], band = null, bars = null, area = false, gapS } = spec;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (v) => { if (v !== null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  lines.forEach((l) => l.v.forEach(take));
  if (band) band.forEach((b) => { take(b[1]); take(b[2]); });
  if (bars) bars.v.forEach(take);
  if (!Number.isFinite(lo)) return null;
  if (bars || area || spec.zones) lo = Math.min(lo, 0);
  if (spec.minHi !== undefined) hi = Math.max(hi, spec.minHi);
  const sc = niceScale(lo, hi);
  const X = (t) => (t - t0) / (t1 - t0) * W;
  const Y = (v) => H - (v - sc.y0) / (sc.y1 - sc.y0) * H;

  const path = (t, v) => {
    let d = '';
    let pen = false;
    for (let i = 0; i < t.length; i++) {
      const ok = v[i] !== null && Number.isFinite(v[i]);
      const gap = i > 0 && gapS && t[i] - t[i - 1] > gapS;
      if (!ok || gap) pen = false;
      if (!ok) continue;
      d += `${pen ? 'L' : 'M'}${X(t[i]).toFixed(1)} ${Y(v[i]).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };
  const out = { sc, lines: lines.map((l) => ({ ...l, d: path(l.t, l.v) })) };
  if (spec.zones) {
    out.zones = spec.zones
      .filter((z) => z.from < sc.y1)
      .map((z) => ({ y: Y(Math.min(z.to, sc.y1)), h: Y(z.from) - Y(Math.min(z.to, sc.y1)), color: z.color }));
  }

  if (area && lines[0]) {
    // filled area under the first line, closed per continuous run
    const { t, v } = lines[0];
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        d += `M${X(run[0][0]).toFixed(1)} ${H} ` + run.map(([a, b]) => `L${X(a).toFixed(1)} ${Y(b).toFixed(1)}`).join(' ')
          + ` L${X(run[run.length - 1][0]).toFixed(1)} ${H} Z `;
      }
      run = [];
    };
    for (let i = 0; i < t.length; i++) {
      const ok = v[i] !== null && Number.isFinite(v[i]);
      if (!ok || (i > 0 && gapS && t[i] - t[i - 1] > gapS)) flush();
      if (ok) run.push([t[i], v[i]]);
    }
    flush();
    out.area = d.trim();
  }
  if (band) {
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length > 0) {
        const pts = run.length === 1 ? [[run[0][0] - spec.slotS * 0.3, run[0][1], run[0][2]], [run[0][0] + spec.slotS * 0.3, run[0][1], run[0][2]]] : run;
        d += pts.map(([t, l, h], k) => `${k ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(h).toFixed(1)}`).join(' ');
        for (let k = pts.length - 1; k >= 0; k--) d += ` L${X(pts[k][0]).toFixed(1)} ${Y(pts[k][1]).toFixed(1)}`;
        d += ' Z ';
      }
      run = [];
    };
    band.forEach(([t, l, h]) => {
      if (l === null || h === null || !Number.isFinite(l) || !Number.isFinite(h)) flush();
      else run.push([t, l, h]);
    });
    flush();
    out.band = d.trim();
  }
  if (bars) {
    const slot = spec.slotS / (t1 - t0) * W;
    const bw = Math.max(1, slot * 0.68);
    out.bars = bars.t.map((t, i) => {
      const v = bars.v[i];
      if (v === null || !(v > 0)) return '';
      const x = X(t) + (slot - bw) / 2;
      return `M${x.toFixed(1)} ${Y(v).toFixed(1)} h${bw.toFixed(1)} V${H} h-${bw.toFixed(1)} Z`;
    }).join(' ');
  }
  // dotted mean line per dataset
  const avg = (v) => {
    const ok = v.filter((x) => x !== null && Number.isFinite(x));
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  };
  const means = bars ? [avg(bars.v)] : lines.map((l) => (l.noMean ? null : avg(l.v)));
  out.means = means.map((m) => (m === null ? null : { v: m, d: `M0 ${Y(m).toFixed(1)} L${W} ${Y(m).toFixed(1)}`, y: Y(m) }));
  let grid = '';
  for (let k = 0; k <= sc.n; k++) {
    const y = (k * H / sc.n).toFixed(1);
    grid += `M0 ${y} L${W} ${y} `;
  }
  out.grid = grid.trim();
  // enough decimals for the step itself (2.5 -> 1, 0.25 -> 2)
  const dec = [0, 1, 2].find((d) => Math.abs(sc.st * 10 ** d - Math.round(sc.st * 10 ** d)) < 1e-9) ?? 2;
  out.yLabels = [];
  for (let k = 0; k <= sc.n; k++) out.yLabels.push(fmt(sc.y1 - k * sc.st, dec));
  out.X = X;
  out.Y = Y;
  return out;
}

// ------------------------------------------------------------ data shaping

/** View with its unit, decimals and converter for the current display units. */
function withUnits(view) {
  if (!view.group) return { ...view, cv: (a) => a };
  return {
    ...view,
    unit: unitLabel(view.group),
    dp: unitDp(view.group, view.dp),
    cv: (a) => a.map((x) => (x === null || x === undefined ? null : conv(view.group, x))),
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayTime = (x) => `${WEEKDAYS[new Date(x * 1000).getDay()]} ${fmtTime(x)}`;

/** Day (5-minute records) or week (30-minute bins) chart. */
function dayChart(view, day, cfg, week = false) {
  const s = day.series;
  const t0 = day.start;
  const t1 = day.stop;
  const gapS = week ? 3 * 1800 : 3 * 300;
  const tLabel = week ? dayTime : fmtTime;
  const spec = { t0, t1, gapS, area: !!view.area };
  const legend = [];
  if (view.zones) {
    // show the band above the highest value, so "how far from High" is visible
    const vals = (s[view.day.line] || []).filter((x) => x !== null && Number.isFinite(x));
    const top = vals.length ? Math.max(...vals) : 0;
    const next = [...view.zones].sort((a, b) => a.from - b.from).find((z) => z.from > top);
    spec.zones = view.zones;
    spec.minHi = next ? next.from * 1.25 : top;   // a strip of the next band
  }
  if (view.day.bars) {
    const bin = week ? 21600 : view.day.binS;
    const n = Math.ceil((t1 - t0) / bin);
    const v = new Array(n).fill(null);
    const src = s[view.day.bars] || [];
    s.t.forEach((t, i) => {
      const r = src[i];
      if (r === null || r === undefined) return;
      // day: record t closes its interval; week: t opens its 30-minute bin
      const k = Math.min(n - 1, Math.floor((t - t0 - (week ? 0 : 1)) / bin));
      v[k] = (v[k] || 0) + r;
    });
    spec.bars = { t: v.map((_x, k) => t0 + k * bin), v: view.cv(v) };
    spec.slotS = bin;
    const name = week ? view.day.lWeek : view.day.l1;
    legend.push(['var(--accent)', name]);
    spec.hover = {
      t: spec.bars.t.map((x) => x + bin / 2),
      rows: [{ name, color: 'var(--accent)', v: spec.bars.v, bar: true }],
      label: (x) => `${tLabel(x - bin / 2)} – ${fmtTime(x + bin / 2)}`,
    };
  } else {
    spec.lines = [{ t: s.t, v: view.cv(s[view.day.line] || []), cls: 'l1' }];
    legend.push(['var(--accent)', view.day.l1]);
    spec.hover = { t: s.t, rows: [{ name: view.day.l1, color: 'var(--accent)', v: spec.lines[0].v }], label: tLabel };
    if (view.day.line2 && s[view.day.line2]) {
      const color = view.day.dash2 ? 'var(--muted)' : 'var(--up)';
      spec.lines.push({ t: s.t, v: view.cv(s[view.day.line2]), cls: 'l2', noMean: !!view.day.dash2 });
      legend.push([color, view.day.l2]);
      spec.hover.rows.push({ name: view.day.l2, color, v: spec.lines[1].v });
    }
  }
  const chart = buildChart(spec);
  if (chart) chart.dash2 = !!view.day.dash2;
  const xl = [];
  if (week) {
    const d = new Date(t0 * 1000);
    d.setHours(24, 0, 0, 0);
    for (let t = d.getTime() / 1000; t <= t1; t += 86400) {
      const dt = new Date(t * 1000);
      // noon of each day carries the label; DST days still land within the day
      xl.push([t + 43200, `${WEEKDAYS[dt.getDay()]} ${dt.getDate()}`]);
    }
  } else {
    for (let t = Math.ceil(t0 / 10800) * 10800; t <= t1; t += 10800) xl.push([t, fmtTime(t).replace(':00', '')]);
  }
  const what = week ? (view.day.bars ? '6-hour totals' : '30-minute averages') : (view.day.bars ? '30-minute totals' : '5-minute values');
  return finishChart(chart, view, spec, legend, xl, `${week ? 'Last 7 days' : 'Last 24 hours'} · ${what} · ${view.unit}`, cfg);
}

function weekly(days, vals, agg) {
  // group daily values into 7-day blocks starting at the first day
  const t = [];
  const v = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = vals.slice(i, i + 7).filter((x) => x !== null && Number.isFinite(x));
    t.push(days[i]);
    if (!chunk.length) v.push(null);
    else if (agg === 'sum') v.push(chunk.reduce((a, b) => a + b, 0));
    else if (agg === 'max') v.push(Math.max(...chunk));
    else if (agg === 'min') v.push(Math.min(...chunk));
    else v.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  return { t, v };
}

function periodChart(view, data, range, cfg) {
  const d = data.daily;
  const p = view.period;
  const yearly = range === 'year';
  const t0 = data.start;
  const t1 = data.stop;
  const slotS = yearly ? 7 * 86400 : 86400;
  const unit = p.unit || view.unit;
  const spec = { t0, t1, slotS };
  if (view.fire) spec.minHi = 10;      // drought factor runs 0-10
  const legend = [];
  const get = (obs, agg) => view.cv((d[obs] && d[obs][agg]) || d.days.map(() => null));
  const dayLabel = (x) => {
    const dt = new Date(x * 1000);
    return `${yearly ? 'Week of ' : ''}${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
  };
  if (p.bars) {
    let vals = get(p.bars[0], p.bars[1]).map((x) => (x === null ? null : x * (p.scale || 1)));
    let t = d.days;
    if (yearly) ({ t, v: vals } = weekly(d.days, vals, p.yearAgg || 'sum'));
    spec.bars = { t, v: vals };
    legend.push(['var(--accent)', yearly ? p.yearName : p.monthName]);
    spec.hover = {
      t: t.map((x) => x + slotS / 2),
      rows: [{ name: yearly ? p.yearName : p.monthName, color: 'var(--accent)', v: vals, bar: true }],
      label: (x) => dayLabel(x - slotS / 2),
    };
  } else {
    const lo = get(p.band[0], p.band[1]);
    const hi = p.band[3] ? get(p.band[3], p.band[4]) : get(p.band[0], p.band[2]);
    const mean = get(p.mean[0], p.mean[1]);
    let t = d.days.map((x) => x + 43200);
    let L = lo;
    let Hh = hi;
    let M = mean;
    if (yearly) {
      t = weekly(d.days, lo, 'min').t.map((x) => x + 3.5 * 86400);
      L = weekly(d.days, lo, 'min').v;
      Hh = weekly(d.days, hi, 'max').v;
      M = weekly(d.days, mean, 'avg').v;
    }
    spec.band = t.map((x, i) => [x, L[i], Hh[i]]);
    spec.lines = [{ t, v: M, cls: 'l1' }];
    spec.gapS = slotS * 1.5;
    legend.push(['var(--accentSoft)', p.bandName], ['var(--accent)', p.lineName]);
    // wind: the band's low edge is the average itself, so list it once
    const rows = [{ name: p.band[3] ? 'Max gust' : 'High', color: 'var(--muted)', v: Hh },
      { name: p.lineName, color: 'var(--accent)', v: M }];
    if (!p.band[3]) rows.push({ name: 'Low', color: 'var(--muted)', v: L });
    spec.hover = {
      t,
      rows,
      label: (x) => dayLabel(yearly ? x - 3.5 * 86400 : x - 43200),
    };
  }
  const chart = buildChart(spec);
  const xl = [];
  const start = new Date(t0 * 1000);
  if (yearly) {
    for (let m = 0; m < 12; m++) xl.push([new Date(start.getFullYear(), m, 1).getTime() / 1000, MONTHS[m]]);
  } else {
    const dim = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    for (const day of [1, 6, 11, 16, 21, 26, dim]) {
      xl.push([new Date(start.getFullYear(), start.getMonth(), day, 12).getTime() / 1000, day === 1 ? `1 ${MONTHS[start.getMonth()]}` : String(day)]);
    }
  }
  const sub = yearly
    ? `${start.getFullYear()} · weekly values · ${unit}`
    : `${MONTHS_LONG[start.getMonth()]} ${start.getFullYear()} · daily values · ${unit}`;
  return finishChart(chart, { ...view, unit, dp: p.dp !== undefined ? p.dp : view.dp }, spec, legend, xl, sub, cfg);
}

function finishChart(chart, view, spec, legend, xl, sub, cfg) {
  if (!chart) return { empty: true, sub, legend };
  // summary chips
  const fmtU = (v) => `${fmt(v, view.dp)} ${view.unit}`;
  let stats = [];
  if (spec.bars) {
    const v = spec.bars.v.filter((x) => x !== null && Number.isFinite(x));
    const tot = v.reduce((a, b) => a + b, 0);
    stats = view.sum
      ? [['Total', fmtU(tot)], ['Peak', fmtU(v.length ? Math.max(...v) : null)]]
      : [['Highest', fmtU(v.length ? Math.max(...v) : null)], ['Average', fmtU(v.length ? tot / v.length : null)]];
  } else {
    const his = spec.band ? spec.band.map((b) => b[2]) : spec.lines[0].v;
    const los = spec.band ? spec.band.map((b) => b[1]) : spec.lines[0].v;
    const mean = spec.lines[0].v.filter((x) => x !== null && Number.isFinite(x));
    const h = his.filter((x) => x !== null && Number.isFinite(x));
    const l = los.filter((x) => x !== null && Number.isFinite(x));
    stats = [['Highest', fmtU(h.length ? Math.max(...h) : null)], ['Lowest', fmtU(l.length ? Math.min(...l) : null)],
      ['Mean', fmtU(mean.length ? mean.reduce((a, b) => a + b, 0) / mean.length : null)]];
  }
  let marker = null;
  if (cfg.cutover && cfg.cutover > spec.t0 && cfg.cutover < spec.t1) {
    const d = new Date(cfg.cutover * 1000);
    const when = spec.t1 - spec.t0 > 86400 * 1.5 ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${fmtTime(cfg.cutover)}` : fmtTime(cfg.cutover);
    marker = { x: chart.X(cfg.cutover), label: `${cfg.station.hardware_short || 'Station'} from ${when}` };
  }
  // a label hard against either edge would collide with its neighbour
  const xLabels = xl.map(([t, label]) => ({ pct: Math.max(0, Math.min(100, chart.X(t) / W * 100)), label }))
    .filter((x) => x.pct === 0 || (x.pct > 4 && x.pct < 96));
  const hover = spec.hover
    ? { ...spec.hover, t0: spec.t0, t1: spec.t1, unit: view.unit, dp: view.dp, suffix: spec.zones ? view.suffix : null }
    : null;
  return { ...chart, stats, legend, xLabels, sub, marker, hover };
}

// --------------------------------------------------------------- almanac

function almanacRows(id, alm, cfg) {
  const T = alm.today;
  const P = [alm.today, alm.month, alm.year, alm.record];
  const at = (t, col) => {
    if (!t) return '';
    const d = new Date(t * 1000);
    if (col === 0) return fmtTime(t);
    const ds = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return col === 3 ? `${ds} ${d.getFullYear()}` : ds;
  };
  // metric suffix -> display unit group (values are converted, the suffix relabelled)
  const G = { '°': 'temp', ' km/h': 'wind', ' mm': 'rain', ' mm/h': 'rainRate', ' km': 'distance', ' hPa': 'pressure' };
  const val = (v, dp, u = '') => {
    if (v === null || v === undefined) return '—';
    const g = G[u];
    if (!g) return `${fmt(v, dp)}${u}`;
    return `${fmt(conv(g, v), unitDp(g, dp))}${u === '°' ? '°' : ` ${unitLabel(g)}`}`;
  };
  const vt = (o, k, dp, u, col) => (o && o[k] !== null && o[k] !== undefined ? `${val(o[k], dp, u)} · ${at(o[`${k}time`], col)}` : '—');
  const row = (label, fn) => [label, ...P.map((p, col) => (p ? fn(p, col) : '—'))];
  const since = (obs) => (cfg.record_cutoff && cfg.record_cutoff[obs] ? ` (since ${at(cfg.record_cutoff[obs], 3)})` : '');
  switch (id) {
    case 'temp':
      return [
        row('Highest', (p, c) => vt(p.outTemp, 'max', 1, '°', c)),
        row('Lowest', (p, c) => vt(p.outTemp, 'min', 1, '°', c)),
        row('Mean', (p) => val(p.outTemp && p.outTemp.avg, 1, '°')),
        row('Dew point high / low', (p) => (p.dewpoint ? `${val(p.dewpoint.max, 1, '°')} / ${val(p.dewpoint.min, 1, '°')}` : '—')),
      ];
    case 'hum':
      return [
        row('Highest', (p, c) => vt(p.outHumidity, 'max', 0, '%', c)),
        row('Lowest', (p, c) => vt(p.outHumidity, 'min', 0, '%', c)),
        row('Mean', (p) => val(p.outHumidity && p.outHumidity.avg, 0, '%')),
      ];
    case 'wind':
      return [
        row('Max gust', (p, c) => (p.windGust && p.windGust.max !== null
          ? `${val(p.windGust.max, 1, ' km/h')}${p.windGust.dir !== null && p.windGust.dir !== undefined ? ` ${compassPoint(p.windGust.dir)}` : ''} · ${at(p.windGust.maxtime, c)}` : '—')),
        row('Max average', (p, c) => vt(p.windSpeed, 'max', 1, ' km/h', c)),
        row('Wind run', (p) => (p.windrun ? val(p.windrun.sum, 0, ' km') : '—')),
        row('Dominant direction', (p) => (p.windDir && p.windDir.dominant !== null && p.windDir.dominant !== undefined ? compassPoint(p.windDir.dominant) : '—')),
      ];
    case 'rain':
      return [
        row('Total', (p) => (p.rain && p.rain.sum !== undefined ? val(p.rain.sum, 1, ' mm') : '—')),
        row('Max rate', (p, c) => vt(p.rainRate, 'max', 1, ' mm/h', c)),
        row('Rain days', (p, c) => (c === 0 || !p.rain || p.rain.days === undefined ? '—' : String(p.rain.days))),
        row('Wettest day', (p, c) => (c === 0 || !p.rain || !p.rain.wettest ? '—' : `${val(p.rain.wettest.value, 1, ' mm')} · ${at(p.rain.wettest.time, c)}`)),
      ];
    case 'baro':
      return [
        row(`Highest${since('barometer')}`, (p, c) => vt(p.barometer, 'max', 1, ' hPa', c)),
        row('Lowest', (p, c) => vt(p.barometer, 'min', 1, ' hPa', c)),
        row('Mean', (p) => val(p.barometer && p.barometer.avg, 1, ' hPa')),
      ];
    case 'solar':
      return [
        row(`Max radiation${since('radiation')}`, (p, c) => vt(p.radiation, 'max', 0, ' W/m²', c)),
        row('Energy', (p) => (p.radiation && p.radiation.energy_kwh !== undefined ? val(p.radiation.energy_kwh, 1, ' kWh/m²') : '—')),
        row('Sunshine hours', (p) => (p.radiation && p.radiation.sunshine_h !== undefined ? val(p.radiation.sunshine_h, 1, ' h') : '—')),
      ];
    case 'uv':
      return [
        row(`Max UVI${since('UV')}`, (p, c) => vt(p.UV, 'max', 1, '', c)),
        row('Days UVI 11+', (p, c) => (c === 0 || !p.UV || p.UV.days_extreme === undefined ? '—' : String(p.UV.days_extreme))),
        row('Protection advised', (p, c) => (c === 0 && T.UV && T.UV.protect_from ? `${fmtTime(T.UV.protect_from)} – ${fmtTime(T.UV.protect_to)}` : '—')),
      ];
    case 'et':
      return [
        row(`Total${since('ET')}`, (p) => (p.ET && p.ET.sum !== undefined ? val(p.ET.sum, 1, ' mm') : '—')),
        row('Rain − ET', (p) => (p.ET && Number.isFinite(p.ET.balance)
          ? `${p.ET.balance > 0 ? '+' : ''}${val(p.ET.balance, 1, ' mm')}` : '—')),
        row('Highest day', (p, c) => (c === 0 || !p.ET || !p.ET.highest ? '—'
          : `${val(p.ET.highest.value, 1, ' mm')} · ${at(p.ET.highest.time, c)}`)),
      ];
    case 'cap':
    case 'batt': {
      const p = cfg.options.power[id === 'cap' ? 'supercap' : 'battery'];
      if (!p) return [];
      const obs = p.field;
      return [
        row('Highest', (p, c) => vt(p[obs], 'max', 2, ' V', c)),
        row('Lowest', (p, c) => vt(p[obs], 'min', 2, ' V', c)),
        row('Mean', (p) => val(p[obs] && p[obs].avg, 2, ' V')),
      ];
    }
    case 'indoor':
      return [
        row('Highest', (p, c) => vt(p.inTemp, 'max', 1, '°', c)),
        row('Lowest', (p, c) => vt(p.inTemp, 'min', 1, '°', c)),
        row('Humidity high / low', (p) => (p.inHumidity ? `${val(p.inHumidity.max, 0, '%')} / ${val(p.inHumidity.min, 0, '%')}` : '—')),
      ];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ dialog

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class HistoryDialog {
  constructor(cfg, getHeader) {
    this.cfg = cfg;
    const power = (cfg.options && cfg.options.power) || {};
    if (power.supercap) VIEWS.cap = powerView(power.supercap);
    if (power.battery) VIEWS.batt = powerView(power.battery);
    this.getHeader = getHeader;   // id -> { src, now, trendText, trendDir }
    this.cache = {};
    this.range = 'day';
    this.id = null;
    this._build();
  }

  async _load(name) {
    const c = this.cache[name];
    if (c && Date.now() - c.at < 120000) return c.data;
    const data = await loadJson(name);
    this.cache[name] = { at: Date.now(), data };
    return data;
  }

  _build() {
    const ov = el('div', 'overlay');
    ov.hidden = true;
    ov.innerHTML = `
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-h">
  <div class="dlg-head">
    <div style="min-width:0">
      <div class="dlg-kicker"></div>
      <h2 id="dlg-h"></h2>
      <div class="dlg-now"><span class="dlg-val num"></span><span class="trend dlg-trend"></span></div>
    </div>
    <div class="dlg-ctl">
      <div class="seg seg-inset" role="tablist" aria-label="Period">
        <button type="button" role="tab" data-range="day">Day</button>
        <button type="button" role="tab" data-range="week">Week</button>
        <button type="button" role="tab" data-range="month">Month</button>
        <button type="button" role="tab" data-range="year">Year</button>
      </div>
      <button type="button" class="icon-btn dlg-close" aria-label="Close history">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14"/></svg>
      </button>
    </div>
  </div>
  <div class="dlg-chart">
    <div class="chart-top"><span class="chart-sub"></span><div class="legend"></div></div>
    <div class="chart-wrap">
      <div class="ylabels mono"></div>
      <div class="chart-col">
        <div class="chart-svg-wrap">
          <svg class="chart" viewBox="0 0 800 260" preserveAspectRatio="none" role="img">
            <g class="c-zones"></g>
            <path class="c-grid" vector-effect="non-scaling-stroke"/>
            <path class="c-band"/><path class="c-area"/><path class="c-bars"/>
            <path class="c-line2" vector-effect="non-scaling-stroke"/>
            <path class="c-line" vector-effect="non-scaling-stroke"/>
            <path class="c-marker" vector-effect="non-scaling-stroke"/>
            <path class="c-mean" vector-effect="non-scaling-stroke"/>
            <path class="c-mean2" vector-effect="non-scaling-stroke"/>
          </svg>
          <span class="mean-label mono" hidden></span>
          <div class="c-hover" hidden><div class="c-vline"></div><div class="c-dots"></div><div class="c-tip"></div></div>
          <span class="marker-label mono" hidden></span>
          <div class="chart-empty" hidden>No data for this period yet.</div>
        </div>
        <div class="xlabels mono"></div>
      </div>
    </div>
    <div class="stats"></div>
  </div>
  <div class="dlg-explain" hidden></div>
  <div class="dlg-alm">
    <h3 class="alm-h"></h3>
    <div class="alm-scroll"><div class="alm" role="table"></div></div>
  </div>
  <div class="dlg-noaa" id="dlg-noaa">
    <div class="noaa-head">
      <div><h3>NOAA climatological summary</h3><p class="muted">Plain-text reports generated by WeeWX on each report cycle.</p></div>
      <div class="noaa-ctl">
        <label for="noaa-sel" class="muted">Report</label>
        <select id="noaa-sel"></select>
        <a class="btn-sec noaa-view" target="_blank" rel="noopener">View full report</a>
        <a class="btn-pri noaa-dl" download>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>
          Download .txt</a>
      </div>
    </div>
    <pre class="noaa-pre mono"></pre>
  </div>
</div>`;
    document.body.append(ov);
    this.ov = ov;
    this.dlg = ov.querySelector('.dlg');
    ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
    ov.querySelector('.dlg-close').addEventListener('click', () => this.close());
    ov.querySelector('[role=tablist]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (b) { this.range = b.dataset.range; this.render(); }
    });
    ov.querySelector('#noaa-sel').addEventListener('change', () => this._showNoaa());
    const wrap = ov.querySelector('.chart-svg-wrap');
    wrap.addEventListener('pointermove', (e) => this._hover(e));
    wrap.addEventListener('pointerdown', (e) => this._hover(e));
    wrap.addEventListener('pointerleave', () => { ov.querySelector('.c-hover').hidden = true; });
    ov.addEventListener('keydown', (e) => this._onKey(e));
    // the phone's Back button closes the pop-up instead of leaving the page
    window.addEventListener('popstate', () => {
      this.pushed = false;
      if (this.isOpen) this.close();
    });
  }

  _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...this.dlg.querySelectorAll('button, a[href], select, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /** A reading's history (chart + almanac), or with `noaa` the NOAA reports
   *  on their own (header button only). */
  open(id, { noaa = false } = {}) {
    this.id = VIEWS[id] ? id : 'temp';
    this.noaa = noaa;
    this.dlg.dataset.mode = noaa ? 'noaa' : 'history';
    this.returnFocus = document.activeElement;
    this.range = 'day';
    this.ov.hidden = false;
    document.body.classList.add('modal-open');
    if (!this.pushed) {
      try { window.history.pushState({ jhwxDialog: true }, ''); this.pushed = true; } catch (e) { /* ignore */ }
    }
    if (noaa) {
      this.token = null;
      this.ov.querySelector('.dlg-kicker').textContent = 'Climatological summaries';
      this.ov.querySelector('#dlg-h').textContent = 'NOAA reports';
      this._loadNoaaIndex();
      setTimeout(() => this.ov.querySelector('#noaa-sel').focus(), 50);
    } else {
      this.render();
      this.ov.querySelector('.dlg-close').focus();
    }
  }

  close() {
    this.ov.hidden = true;
    document.body.classList.remove('modal-open');
    if (this.pushed) { this.pushed = false; window.history.back(); }
    if (this.returnFocus && this.returnFocus.focus) this.returnFocus.focus();
  }

  get isOpen() { return !this.ov.hidden; }

  /** Refresh the header line (value, trend) while open. */
  updateHeader() {
    if (!this.isOpen || this.noaa) return;
    const h = this.getHeader(this.id);
    const q = (s) => this.ov.querySelector(s);
    q('.dlg-kicker').textContent = `History · ${h.src}`;
    q('.dlg-val').textContent = h.now;
    const tr = q('.dlg-trend');
    tr.dataset.dir = h.trendDir || 'steady';
    tr.textContent = h.trendText || '';
  }

  async render() {
    const view = withUnits(VIEWS[this.id]);
    const q = (s) => this.ov.querySelector(s);
    q('#dlg-h').textContent = view.title;
    q('.alm-h').textContent = `Almanac · ${view.title}`;
    for (const b of this.ov.querySelectorAll('[data-range]')) b.setAttribute('aria-selected', String(b.dataset.range === this.range));
    this.updateHeader();
    const token = Symbol('render');
    this.token = token;
    let chart;
    try {
      let data = await this._load(this.range);
      if (view.fire) data = await this._fireData(data);
      if (this.range === 'day' || this.range === 'week') chart = dayChart(view, data, this.cfg, this.range === 'week');
      else chart = periodChart(view, data, this.range, this.cfg);
    } catch (e) {
      console.warn(e);
      chart = { empty: true, sub: 'Could not load chart data', legend: [] };
    }
    if (this.token !== token) return;
    this._drawChart(chart, view);
    this._drawExplain(view);
    try {
      const alm = await this._load('almanac');
      if (this.token === token) this._drawAlmanac(almanacRows(this.id, alm.almanac, this.cfg), alm.almanac);
    } catch (e) {
      console.warn(e);
    }
  }

  /** Plain-language key under the chart (fire danger only). */
  _drawExplain(view) {
    const box = this.ov.querySelector('.dlg-explain');
    box.hidden = !view.fire && !view.explainET;
    if (view.explainET) {
      box.innerHTML = `
      <h3>What evapotranspiration means</h3>
      <p class="muted">The water a well-watered lawn would lose in this weather, by evaporation from the soil
      and transpiration from the grass (reference ET, FAO-56 Penman–Monteith, calculated by WeeWX from this
      station’s sunshine, temperature, humidity and wind). Sunny, warm, dry and windy days use the most.
      Compare it with rain: when ET is higher, the soil is drying out and a garden needs roughly the
      difference in watering; when rain is higher, it is wetting up.</p>`;
      return;
    }
    if (!view.fire) return;
    const period = this.range === 'month' || this.range === 'year';
    const rows = FIRE_LEVELS.slice().reverse().map((l) => `
      <div class="fx-row"><span class="fx-chip" style="background:${l.color};color:${l.ink}">${l.name}</span>
        <span class="fx-range mono">${l.range}</span><span>${l.advice}</span></div>`).join('');
    box.innerHTML = `
      <h3>What the levels mean</h3>
      <div class="fx-rows">${rows}</div>
      <p class="muted">${period
    ? '<strong>Drought factor</strong> (this chart) measures how dry the fuel is, from 0 (soaked by recent rain) to 10 (fully dry, nothing has fallen for weeks). It comes from this station’s rain and daily maximum temperature. On top of it, hot, dry and windy weather drives the fire danger index above.'
    : '<strong>Forest Fire Danger Index</strong> (McArthur) combines temperature, humidity, wind and how dry the fuel is (the drought factor, from this station’s rain history). The higher it climbs, the faster a fire would spread and the harder it would be to control.'}
      Calculated from this weather station, so it is indicative only: ${this._officialFire()}</p>`;
  }

  /** "for official ratings ... check <link>" from the install's fire_danger options. */
  _officialFire() {
    const f = (this.cfg.options && this.cfg.options.fire) || {};
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const link = f.info_url && /^https?:\/\//.test(f.info_url)
      ? `<a href="${esc(f.info_url)}" target="_blank" rel="noopener">${esc(f.info_name || f.info_url)}</a>` : esc(f.info_name || '');
    if (!link) return 'for official ratings and warnings check your local fire agency.';
    return `for official ratings and warnings check ${link}${f.info_extra ? ` ${esc(f.info_extra)}` : ''}.`;
  }

  /** Fire danger is derived: FFDI per record from temperature, humidity and
   *  wind with that day's drought factor; daily drought factor for periods. */
  async _fireData(data) {
    const f = (await this._load('fire')).fire;
    const daily = f && f.daily;
    if (data.series) return { ...data, series: { ...data.series, ffdi: ffdiSeries(data.series, daily) } };
    const byDay = new Map(daily ? daily.days.map((d, i) => [d, daily.df[i]]) : []);
    const days = data.daily.days;
    return { ...data, daily: { days, droughtFactor: { avg: days.map((d) => byDay.get(d) ?? null) } } };
  }

  _drawChart(c, view) {
    const q = (s) => this.ov.querySelector(s);
    q('.chart-sub').textContent = c.sub;
    q('.legend').replaceChildren(...(c.legend || []).map(([color, text]) => {
      const s = el('span', 'lg');
      const sw = el('span', 'sw');
      sw.style.background = color;
      s.append(sw, text);
      return s;
    }));
    const svg = q('svg.chart');
    q('.chart-empty').hidden = !c.empty;
    svg.style.visibility = c.empty ? 'hidden' : '';
    const set = (cls, d) => svg.querySelector(cls).setAttribute('d', d || '');
    set('.c-grid', c.grid);
    svg.querySelector('.c-zones').innerHTML = (c.zones || []).map((z) => `<rect x="0" y="${z.y.toFixed(1)}" width="800" height="${Math.max(0, z.h).toFixed(1)}" style="fill:${z.color}" class="c-zone"/>`).join('');
    set('.c-band', c.band);
    set('.c-area', c.area);
    set('.c-bars', c.bars);
    const l1 = c.lines && c.lines[0];
    const l2 = c.lines && c.lines[1];
    set('.c-line', l1 && l1.d);
    set('.c-line2', l2 && l2.d);
    svg.querySelector('.c-line2').classList.toggle('dash', Boolean(c.dash2));
    set('.c-marker', c.marker ? `M${c.marker.x.toFixed(1)} 0 V260` : '');
    const m1 = c.means && c.means[0];
    const m2 = c.means && c.means[1];
    set('.c-mean', m1 && m1.d);
    set('.c-mean2', m2 && m2.d);
    const mlab = q('.mean-label');
    mlab.hidden = !m1;
    if (m1) {
      mlab.textContent = `mean ${fmt(m1.v, c.hover ? c.hover.dp : view.dp)}`;
      mlab.style.top = `${(m1.y / H) * 100}%`;
    }
    this.chart = c.empty ? null : c;
    q('.c-hover').hidden = true;
    const ml = q('.marker-label');
    ml.hidden = !c.marker;
    if (c.marker) {
      ml.textContent = c.marker.label;
      ml.style.left = `${c.marker.x / 8}%`;
    }
    svg.setAttribute('aria-label', `${view.title} chart, ${c.sub}`);
    q('.ylabels').replaceChildren(...(c.yLabels || []).map((t) => el('span', '', t)));
    q('.xlabels').classList.toggle('dense', (c.xLabels || []).length > 7);
    q('.xlabels').replaceChildren(...(c.xLabels || []).map((x) => {
      const s = el('span', '', x.label);
      s.style.left = `${x.pct}%`;
      return s;
    }));
    q('.stats').replaceChildren(...(c.stats || []).map(([k, v]) => {
      const d = el('div', 'stat');
      d.append(el('span', 'muted', `${k} `), el('strong', 'num', v));
      return d;
    }));
  }

  /** Crosshair + value read-out at the data point nearest the pointer. */
  _hover(e) {
    const c = this.chart;
    const box = this.ov.querySelector('.c-hover');
    if (!c || !c.hover || !c.hover.t.length) { box.hidden = true; return; }
    const wrap = this.ov.querySelector('.chart-svg-wrap');
    const r = wrap.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const h = c.hover;
    const t = h.t0 + f * (h.t1 - h.t0);
    let i = 0;
    for (let k = 1; k < h.t.length; k++) if (Math.abs(h.t[k] - t) < Math.abs(h.t[i] - t)) i = k;
    const rows = h.rows.map((row) => ({ ...row, val: row.v[i] })).filter((row) => row.val !== null && Number.isFinite(row.val));
    if (!rows.length) { box.hidden = true; return; }
    box.hidden = false;
    const xPct = Math.max(0, Math.min(100, c.X(h.t[i]) / W * 100));
    box.querySelector('.c-vline').style.left = `${xPct}%`;
    box.querySelector('.c-dots').replaceChildren(...rows.map((row) => {
      const d = el('span', 'c-dot');
      d.style.left = `${xPct}%`;
      d.style.top = `${Math.max(0, Math.min(100, c.Y(row.val) / H * 100))}%`;
      d.style.background = row.color;
      return d;
    }));
    const tip = box.querySelector('.c-tip');
    tip.replaceChildren(el('div', 'c-tip-t', h.label(h.t[i])), ...rows.map((row) => {
      const line = el('div', 'c-tip-r');
      const sw = el('span', 'sw');
      sw.style.background = row.color;
      line.append(sw, `${row.name} `, el('strong', 'num', `${fmt(row.val, h.dp)} ${h.unit}${h.suffix ? h.suffix(row.val) : ''}`));
      return line;
    }));
    // keep the read-out inside the chart: right of the line, or left near the edge
    tip.style.left = xPct > 60 ? '' : `calc(${xPct}% + 12px)`;
    tip.style.right = xPct > 60 ? `calc(${100 - xPct}% + 12px)` : '';
  }

  _drawAlmanac(rows, alm) {
    const q = (s) => this.ov.querySelector(s);
    const now = new Date(alm.periods.today.stop * 1000);
    const heads = ['', 'Today', MONTHS_LONG[now.getMonth()], String(now.getFullYear()), 'Station record'];
    const grid = q('.alm');
    const mk = (cells, head) => {
      const r = el('div', head ? 'alm-row alm-head' : 'alm-row');
      r.setAttribute('role', 'row');
      cells.forEach((c, i) => {
        const s = el('span', i === 0 && !head ? 'muted' : i === 1 && !head ? 'b' : '', c);
        s.setAttribute('role', head ? 'columnheader' : i === 0 ? 'rowheader' : 'cell');
        s.dataset.col = heads[i];
        r.append(s);
      });
      return r;
    };
    grid.replaceChildren(mk(heads, true), ...rows.map((r) => mk(r, false)));
    q('.dlg-alm').hidden = !rows.length;
  }

  async _loadNoaaIndex() {
    const sel = this.ov.querySelector('#noaa-sel');
    if (sel.options.length) return;
    try {
      const idx = await this._load('noaa-index');
      const opts = [];
      for (const m of idx.months) {
        const [y, mo] = m.split('-');
        opts.push([`NOAA/NOAA-${m}.txt`, `${MONTHS_LONG[Number(mo) - 1]} ${y} (month)`]);
      }
      for (const y of idx.years) opts.push([`NOAA/NOAA-${y}.txt`, `${y} (year)`]);
      sel.replaceChildren(...opts.map(([v, t]) => { const o = el('option', '', t); o.value = v; return o; }));
      this._showNoaa();
    } catch (e) {
      console.warn(e);
    }
  }

  async _showNoaa() {
    const sel = this.ov.querySelector('#noaa-sel');
    const file = sel.value;
    if (!file) return;
    this.ov.querySelector('.noaa-view').href = file;
    const dl = this.ov.querySelector('.noaa-dl');
    dl.href = file;
    dl.setAttribute('download', file.split('/').pop());
    const pre = this.ov.querySelector('.noaa-pre');
    try {
      const r = await fetch(file, { cache: 'no-store' });
      const text = await r.text();
      pre.textContent = text;
    } catch (e) {
      pre.textContent = `Could not load ${file}`;
    }
  }
}
