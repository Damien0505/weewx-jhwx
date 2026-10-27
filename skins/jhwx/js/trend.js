// Rolling per-field history for trend arrows, rates and sparklines.
//
// Seeded from data/day.json (archive records, metric) at load, then topped up
// from live loop packets.  Live samples are kept at most one per minute per
// field (the newest in each minute wins), and 25 hours are retained.

import { fmtSigned, conv, unitDp } from './units.js';

const KEEP_S = 25 * 3600;
const LIVE_STEP_S = 60;
const SMOOTH_S = 300;          // average +/- 5 min around each end of a comparison

// Comparison window and dead-band per field (metric units), from FIELD-MAP.md.
export const TREND_RULES = {
  outTemp: { window: 3600, band: 0.2, dp: 1, per: '/h', group: 'tempDelta' },
  inTemp: { window: 3600, band: 0.2, dp: 1, per: '/h', group: 'tempDelta' },
  outHumidity: { window: 3600, band: 2, dp: 0, per: '/h' },
  barometer: { window: 3 * 3600, band: 0.5, dp: 1, per: '/3h', group: 'pressure' },
  windSpeed: { window: 3600, band: 2, dp: 1, per: '/h', group: 'wind' },
  radiation: { window: 3600, band: 50, dp: 0, per: '/h' },
  UV: { window: 3600, band: 0.5, dp: 1, per: '/h' },
};

/** Trend rules for the install's voltage readings (config.json options.power). */
export function addPowerTrends(power) {
  if (power.supercap) TREND_RULES[power.supercap.field] = { window: 3600, band: 0.05, dp: 2, per: '/h' };
  if (power.battery) TREND_RULES[power.battery.field] = { window: 3600, band: 0.02, dp: 2, per: '/h' };
}

export class TrendBuffer {
  constructor() {
    this.data = {};        // field -> [[ts, v], ...] ascending
    this.lastRainTs = null;
  }

  _series(field) {
    if (!this.data[field]) this.data[field] = [];
    return this.data[field];
  }

  /** Seed from day.json { series: { t: [...], field: [...] } }. */
  seed(day) {
    const s = day && day.series;
    if (!s || !Array.isArray(s.t)) return;
    for (const [field, vals] of Object.entries(s)) {
      if (field === 't' || field === 'interval' || !Array.isArray(vals)) continue;
      const arr = this._series(field);
      const merged = new Map(arr.map((p) => [p[0], p[1]]));
      s.t.forEach((ts, i) => {
        if (vals[i] !== null && vals[i] !== undefined) merged.set(ts, vals[i]);
      });
      this.data[field] = [...merged.entries()].sort((a, b) => a[0] - b[0]);
    }
    const rain = s.rain || [];
    for (let i = rain.length - 1; i >= 0; i--) {
      if (rain[i] > 0) { this.noteRain(s.t[i]); break; }
    }
  }

  /** Add one live packet's metric fields at station time ts. */
  push(ts, fields) {
    for (const [field, v] of Object.entries(fields)) {
      if (field === 'dateTime' || !Number.isFinite(v)) continue;
      const arr = this._series(field);
      const last = arr[arr.length - 1];
      if (last && ts < last[0]) continue;
      if (field === 'rain') {
        // rain is an increment per packet: accumulate within the minute
        if (last && Math.floor(last[0] / LIVE_STEP_S) === Math.floor(ts / LIVE_STEP_S)) last[1] += v;
        else arr.push([ts, v]);
        if (v > 0) this.noteRain(ts);
      } else if (last && Math.floor(last[0] / LIVE_STEP_S) === Math.floor(ts / LIVE_STEP_S)) {
        last[0] = ts; last[1] = v;
      } else {
        arr.push([ts, v]);
      }
      const cut = ts - KEEP_S;
      while (arr.length && arr[0][0] < cut) arr.shift();
    }
  }

  noteRain(ts) {
    if (ts && (this.lastRainTs === null || ts > this.lastRainTs)) this.lastRainTs = ts;
  }

  _mean(field, from, to) {
    const arr = this.data[field];
    if (!arr) return null;
    let sum = 0;
    let n = 0;
    for (const [ts, v] of arr) {
      if (ts < from) continue;
      if (ts > to) break;
      sum += v; n += 1;
    }
    return n ? sum / n : null;
  }

  /** Mean over the last `seconds` up to the field's newest value. */
  mean(field, seconds) {
    const now = this.newest(field);
    return now === null ? null : this._mean(field, now - seconds, now);
  }

  newest(field) {
    const arr = this.data[field];
    return arr && arr.length ? arr[arr.length - 1][0] : null;
  }

  /** Change over the field's comparison window, or null if not enough data. */
  delta(field, window) {
    const now = this.newest(field);
    if (now === null) return null;
    const cur = this._mean(field, now - SMOOTH_S, now);
    const past = this._mean(field, now - window - SMOOTH_S, now - window + SMOOTH_S);
    if (cur === null || past === null) return null;
    return cur - past;
  }

  /** { dir: 'up'|'down'|'steady', text, delta } using TREND_RULES. */
  trend(field) {
    const rule = TREND_RULES[field];
    if (!rule) return null;
    const d = this.delta(field, rule.window);
    if (d === null) return { dir: 'steady', text: '', delta: null };
    const dir = Math.abs(d) < rule.band ? 'steady' : d > 0 ? 'up' : 'down';
    // bands are in metric; only the text is converted (pressure differences
    // convert by the same factor, so conv() works for them too)
    const shown = rule.group ? conv(rule.group, d) - (rule.group === 'pressure' ? conv('pressure', 0) : 0) : d;
    const dp = rule.group ? unitDp(rule.group, rule.dp) : rule.dp;
    return { dir, text: `${fmtSigned(shown, dp)} ${rule.per}`, delta: d };
  }

  /** Values in fixed buckets over the last `hours`, for sparklines.  Buckets
   *  with no data are null so the line breaks there.  `mode`: 'mean' or
   *  'cumsum' (running total, for rain). */
  buckets(field, hours = 6, step = 300, mode = 'mean') {
    const arr = this.data[field];
    const end = this.newest(field);
    if (!arr || end === null) return [];
    const start = end - hours * 3600;
    const n = Math.ceil((end - start) / step);
    const sums = new Array(n).fill(0);
    const counts = new Array(n).fill(0);
    for (const [ts, v] of arr) {
      if (ts <= start) continue;
      const i = Math.min(n - 1, Math.floor((ts - start - 1e-6) / step));
      sums[i] += v; counts[i] += 1;
    }
    if (mode === 'cumsum') {
      let run = 0;
      return sums.map((s) => (run += s));
    }
    return sums.map((s, i) => (counts[i] ? s / counts[i] : null));
  }
}

/** Barometric tendency words over 3 h (Met Office / WMO style), hPa. */
export function pressureTendency(d3h) {
  if (d3h === null || d3h === undefined || !Number.isFinite(d3h)) return '—';
  const a = Math.abs(d3h);
  if (a < 0.5) return 'Steady';
  const way = d3h > 0 ? 'Rising' : 'Falling';
  if (a < 1.6) return `${way} slowly`;
  if (a < 3.6) return way;
  if (a < 6) return `${way} quickly`;
  return `${way} very rapidly`;
}

/** SVG path data for a sparkline of `vals` in a w x h box (nulls break the line). */
export function sparkPaths(vals, w = 112, h = 34, pad = 3) {
  const nums = vals.filter((v) => v !== null && Number.isFinite(v));
  if (nums.length < 2) return { line: '', area: '' };
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (i) => (vals.length === 1 ? 0 : i * w / (vals.length - 1));
  const Y = (v) => h - pad - (v - lo) / (hi - lo) * (h - 2 * pad);
  let line = '';
  let area = '';
  let seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const d = seg.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
      line += d + ' ';
      area += `${d} L${X(seg[seg.length - 1][0]).toFixed(1)} ${h} L${X(seg[0][0]).toFixed(1)} ${h} Z `;
    }
    seg = [];
  };
  vals.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) flush();
    else seg.push([i, v]);
  });
  flush();
  return { line: line.trim(), area: area.trim() };
}
