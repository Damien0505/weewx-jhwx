// Current-conditions tiles: value, trend chip, 6 h sparkline and sub-stats.
// Freshness isn't printed per tile: a late sensor raises the page banner, and
// a reading that has stopped updating is dimmed.

import {
  fmt, fmtTime, compassPoint, uvCategory, absoluteHumidity, fmtU, fmtUL, fmtDeg, unitLabel,
  fmtSigned, conv, unitDp,
} from './units.js';
import { TREND_RULES, pressureTendency, sparkPaths } from './trend.js';
import { ffdi, fireBand } from './fire.js';

const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Read model shared by tiles: live MQTT first, generated JSON as fallback. */
export class Readings {
  constructor(live, trends) {
    this.live = live;
    this.trends = trends;  // TrendBuffer
    this.current = null;   // data/current.json
  }

  /** { v, ts, src } for an observation. */
  get(field) {
    const L = this.live;
    if (L && L.lastSeen[field] !== undefined) {
      return { v: L.values[field], ts: L.lastSeen[field], src: 'live' };
    }
    const rec = this.current && this.current.record;
    if (rec && rec[field] !== undefined && rec[field] !== null) {
      return { v: rec[field], ts: rec.dateTime, src: 'archive' };
    }
    return { v: null, ts: null, src: null };
  }

  /** Was the field in the newest live packet?  (windDir is omitted in calm.) */
  inLatestPacket(field) {
    const L = this.live;
    return L && L.lastPacket !== null && L.lastSeen[field] === L.lastPacket;
  }

  /** Today's high/low from current.json, raised/lowered by the live value. */
  today(field) {
    const t = this.current && this.current.today && this.current.today[field];
    const gen = this.current && this.current.generated;
    let out = { max: null, maxtime: null, min: null, mintime: null };
    if (t && gen && sameLocalDay(new Date(gen * 1000), new Date())) out = { ...t };
    const r = this.get(field);
    if (r.src === 'live' && Number.isFinite(r.v) && sameLocalDay(new Date(r.ts * 1000), new Date())) {
      if (out.max === null || r.v > out.max) { out.max = r.v; out.maxtime = r.ts; }
      if (out.min === null || r.v < out.min) { out.min = r.v; out.mintime = r.ts; }
    }
    return out;
  }

  rain(key) {
    const r = this.current && this.current.rain;
    return r ? r[key] : null;
  }

  /** 'fresh' | 'stale' | 'offline' | 'archive' | 'missing' */
  state(field) {
    const L = this.live;
    if (L && L.lastSeen[field] !== undefined) return L.state(field);
    return this.get(field).src === 'archive' ? 'archive' : 'missing';
  }
}

function capStatus(R, field) {
  const t = R.trends.trend(field);
  if (!t || t.delta === null) return '—';
  return t.dir === 'up' ? 'Charging' : t.dir === 'down' ? 'Discharging' : 'Steady';
}

/** ET totals from current.json "et" (day, yesterday, last7, rain7). */
export const etOf = (R, k) => {
  const e = R.current && R.current.et;
  return e && Number.isFinite(e[k]) ? e[k] : null;
};

/** Drought factor for today (current.json), null if unknown. */
const droughtFactor = (R) => {
  const f = R.current && R.current.fire;
  return f && Number.isFinite(f.df) ? f.df : null;
};

/** FFDI now: live temperature and humidity, 10-minute mean wind. */
export function fireNow(R) {
  const v = R.trends.mean('windSpeed', 600);
  const wind = Number.isFinite(v) ? v : R.get('windSpeed').v;
  return ffdi(R.get('outTemp').v, R.get('outHumidity').v, wind, droughtFactor(R));
}

/** Highest FFDI so far today from the 10-minute history in the trend buffer. */
export function firePeakToday(R) {
  const df = droughtFactor(R);
  if (df === null) return null;
  const mid = new Date();
  mid.setHours(0, 0, 0, 0);
  const hours = (Date.now() - mid.getTime()) / 3600000;
  const T = R.trends.buckets('outTemp', hours, 600);
  const H = R.trends.buckets('outHumidity', hours, 600);
  const V = R.trends.buckets('windSpeed', hours, 600);
  let best = null;
  for (let i = 0; i < Math.min(T.length, H.length, V.length); i++) {
    const f = ffdi(T[i], H[i], V[i], df);
    if (f !== null && (best === null || f > best)) best = f;
  }
  return best;
}

/** Battery words from the configured thresholds (options.power.battery). */
function battStatus(v, b) {
  if (!Number.isFinite(v)) return '—';
  if (Number.isFinite(b.low) && v < b.low) return 'Low – replace soon';
  if (Number.isFinite(b.fair) && v < b.fair) return 'Fair';
  return Number.isFinite(b.low) || Number.isFinite(b.fair) ? 'Good' : '—';
}

const hiLo = (t, dp = 1) => (t.max === null ? '—' : `${fmtDeg(t.max, dp)} / ${fmtDeg(t.min, dp)}`);
const atTime = (v, ts, dp, u = '') => (v === null || v === undefined ? '—' : `${fmt(v, dp)}${u} · ${fmtTime(ts)}`);

/** Rain chip: raining now (rate) or how long it has been dry. */
function rainTrend(R) {
  const rate = R.get('rainRate').v;
  const lastPacketRain = R.inLatestPacket('rain') && R.get('rain').v > 0;
  if ((Number.isFinite(rate) && rate > 0) || lastPacketRain) {
    return { dir: 'up', text: `Raining · ${fmtUL('rainRate', rate || 0, 1)}` };
  }
  const last = Math.max(R.trends.lastRainTs || 0, (R.current && R.current.rain && R.current.rain.last_rain) || 0);
  if (!last) return { dir: 'steady', text: 'Dry' };
  const h = (Date.now() / 1000 - last) / 3600;
  return {
    dir: 'steady',
    text: h < 1 ? `Dry ${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `Dry ${Math.floor(h)} h` : `Dry ${Math.floor(h / 24)} d`,
  };
}

/** Tile definitions.  `field` drives the age line and staleness; `trend` is
 *  the field whose 1 h (pressure 3 h) change drives the chip; `spark` the
 *  sparkline field and mode. */
export function tileDefs(cfg) {
  const outdoor = cfg.sensors.outdoor;
  const opt = cfg.options || {};
  const cap = (opt.power || {}).supercap;
  const batt = (opt.power || {}).battery;
  const capF = cap ? cap.field : '';
  const battF = batt ? batt.field : '';
  const consoleName = cfg.sensors.console;
  const defs = [
    {
      id: 'temp', label: 'Temperature', field: 'outTemp', sensor: outdoor, unit: () => unitLabel('temp'),
      trend: 'outTemp', spark: { field: 'outTemp' },
      value: (R) => fmtU('temp', R.get('outTemp').v, 1),
      subs: (R) => [
        ['Feels like', fmtDeg(R.get('appTemp').v, 1)],
        ['Dew point', fmtDeg(R.get('dewpoint').v, 1)],
        ['Today high / low', hiLo(R.today('outTemp'))],
      ],
    },
    {
      id: 'hum', label: 'Humidity', field: 'outHumidity', sensor: outdoor, unit: '%',
      trend: 'outHumidity', spark: { field: 'outHumidity' },
      value: (R) => fmt(R.get('outHumidity').v, 0),
      subs: (R) => {
        const t = R.today('outHumidity');
        const ah = absoluteHumidity(R.get('outTemp').v, R.get('outHumidity').v);
        return [
          ['Today high', atTime(t.max, t.maxtime, 0, '%')],
          ['Today low', atTime(t.min, t.mintime, 0, '%')],
          ['Absolute', ah === null ? '—' : `${fmt(ah, 1)} g/m³`],
        ];
      },
    },
    {
      id: 'wind', label: 'Wind', field: 'windSpeed', sensor: outdoor, unit: () => unitLabel('wind'), compass: true,
      trend: 'windSpeed',
      value: (R) => fmtU('wind', R.get('windSpeed').v, 1),
      calm: (R) => {
        const s = R.get('windSpeed').v;
        return (Number.isFinite(s) && s < 0.05) || (R.get('windSpeed').src === 'live' && !R.inLatestPacket('windDir'));
      },
      dir: (R) => R.get('windDir').v,
      subs: (R, def) => {
        const g = R.today('windGust');
        const d = R.get('windDir').v;
        return [
          ['Gust', fmtUL('wind', R.get('windGust').v, 1)],
          ['Direction', def.calm(R) || !Number.isFinite(d) ? 'Calm' : `${compassPoint(d)} ${fmt(d, 0)}°`],
          ['Max gust today', g.max === null ? '—' : `${fmtU('wind', g.max, 1)} · ${fmtTime(g.maxtime)}`],
        ];
      },
    },
    {
      id: 'rain', label: 'Rain today', field: 'dayRain', sensor: cfg.sensors.rain, unit: () => unitLabel('rain'),
      trendFn: rainTrend, spark: { field: 'rain', mode: 'cumsum' },
      value: (R) => {
        const d = R.get('dayRain');
        return fmtU('rain', d.src === 'live' ? d.v : R.rain('day'), 1);
      },
      subs: (R) => [
        ['Rate', fmtUL('rainRate', R.get('rainRate').v, 1)],
        ['Last 24 h', fmtUL('rain', R.get('rain24').src ? R.get('rain24').v : R.rain('last24h'), 1)],
        ['Month / year', `${fmtU('rain', R.rain('month'), 1)} / ${fmtUL('rain', R.rain('year'), 1)}`],
      ],
    },
    {
      id: 'baro', label: 'Barometer', field: 'barometer', sensor: consoleName, unit: () => unitLabel('pressure'),
      trend: 'barometer', spark: { field: 'barometer' },
      value: (R) => fmtU('pressure', R.get('barometer').v, 1),
      subs: (R) => {
        const t = R.today('barometer');
        return [
          ['Tendency', pressureTendency(R.trends.delta('barometer', TREND_RULES.barometer.window))],
          ['Today high', fmtUL('pressure', t.max, 1)],
          ['Today low', fmtUL('pressure', t.min, 1)],
        ];
      },
    },
    {
      id: 'solar', label: 'Solar radiation', field: 'radiation', sensor: outdoor, unit: 'W/m²',
      trend: 'radiation', spark: { field: 'radiation' },
      value: (R) => fmt(R.get('radiation').v, 0),
      subs: (R) => {
        const t = R.today('radiation');
        const e = R.current && R.current.today && R.current.today.radiation_energy;
        return [
          ['Max today', atTime(t.max, t.maxtime, 0)],
          ['Energy today', Number.isFinite(e) ? `${fmt(e / 1000, 2)} kWh/m²` : '—'],
          ['Clear-sky max now', `${fmt(R.get('maxSolarRad').v, 0)} W/m²`],
        ];
      },
    },
    {
      id: 'uv', label: 'UV index', field: 'UV', sensor: outdoor,
      trend: 'UV', spark: { field: 'UV' },
      unit: (R) => uvCategory(R.get('UV').v),
      value: (R) => fmt(R.get('UV').v, 1),
      subs: (R) => {
        const t = R.today('UV');
        return [
          ['Max today', atTime(t.max, t.maxtime, 1)],
          ['Protection advised', (() => {
            const t = R.current && R.current.today && R.current.today.uv_window;
            return t && t.from ? `${fmtTime(t.from)} – ${fmtTime(t.to)}` : '—';
          })()],
          ['Tomorrow (forecast)', (() => {
            const d = R.forecast && R.forecast.day(1);
            return d && Number.isFinite(d.uv) ? `${fmt(d.uv, 0)} · ${uvCategory(d.uv)}` : '—';
          })()],
        ];
      },
    },
    {
      // reference ET (FAO-56 Penman-Monteith, calculated by WeeWX each record)
      id: 'et', label: 'Evapotranspiration', field: 'ET', sensor: outdoor, unit: () => unitLabel('rain'),
      spark: { field: 'ET', mode: 'cumsum' },
      value: (R) => fmtU('rain', etOf(R, 'day'), 1),
      subs: (R) => {
        const et7 = etOf(R, 'last7');
        const rain7 = etOf(R, 'rain7');
        const bal = Number.isFinite(et7) && Number.isFinite(rain7) ? rain7 - et7 : null;
        return [
          ['Yesterday', fmtUL('rain', etOf(R, 'yesterday'), 1)],
          ['Last 7 days', fmtUL('rain', et7, 1)],
          ['Rain − ET, 7 days', bal === null ? '—'
            : `${fmtSigned(conv('rain', bal), unitDp('rain', 1))} ${unitLabel('rain')} · ${bal < 0 ? 'drying' : 'wetting'}`],
        ];
      },
    },
    {
      id: 'fire', label: 'Fire danger', field: 'outTemp', sensor: 'Indicative',
      enabled: Boolean(opt.fire && opt.fire.enabled),
      value: (R) => fmt(fireNow(R), 0),
      unit: (R) => { const b = fireBand(fireNow(R)); return b ? b.name : ''; },
      band: (R) => fireBand(fireNow(R)),
      subs: (R) => {
        const f = R.current && R.current.fire;
        const pk = firePeakToday(R);
        const pb = fireBand(pk);
        return [
          ['Drought factor', f && Number.isFinite(f.df) ? `${fmt(f.df, 1)} of 10` : '—'],
          ['Soil dryness (KBDI)', f && Number.isFinite(f.kbdi) ? `${fmt(f.kbdi, 0)} mm` : '—'],
          ['Peak today', pk === null ? '—' : `${fmt(pk, 0)} · ${pb.name}`],
        ];
      },
    },
    {
      // voltage tiles: configured in [[power]], and hidden while the field is empty
      id: 'cap', label: cap ? cap.label : '', field: capF, sensor: outdoor, unit: 'V', optional: true,
      enabled: Boolean(cap),
      trend: capF, spark: { field: capF },
      value: (R) => fmt(R.get(capF).v, 2),
      subs: (R) => {
        const t = R.today(capF);
        return [
          ['Status', capStatus(R, capF)],
          ['Today high', atTime(t.max, t.maxtime, 2, ' V')],
          ['Today low', atTime(t.min, t.mintime, 2, ' V')],
        ];
      },
    },
    {
      id: 'batt', label: batt ? batt.label : '', field: battF, sensor: outdoor, unit: 'V', optional: true,
      enabled: Boolean(batt),
      trend: battF, spark: { field: battF },
      value: (R) => fmt(R.get(battF).v, 2),
      subs: (R) => {
        const t = R.today(battF);
        return [
          ['Status', battStatus(R.get(battF).v, batt)],
          ['Today high', atTime(t.max, t.maxtime, 2, ' V')],
          ['Today low', atTime(t.min, t.mintime, 2, ' V')],
        ];
      },
    },
    {
      id: 'indoor', label: 'Indoor', field: 'inTemp', sensor: consoleName, unit: () => unitLabel('temp'),
      trend: 'inTemp', spark: { field: 'inTemp' },
      value: (R) => fmtU('temp', R.get('inTemp').v, 1),
      subs: (R) => [
        ['Humidity', `${fmt(R.get('inHumidity').v, 0)}%`],
        ['Today high / low', hiLo(R.today('inTemp'))],
        ['Sensor', `${consoleName} console`],
      ],
    },
  ];
  return defs.filter((d) => d.enabled !== false);
}

const svgNS = 'http://www.w3.org/2000/svg';

function compassSvg() {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('width', '52'); s.setAttribute('height', '52'); s.setAttribute('viewBox', '0 0 52 52');
  s.setAttribute('role', 'img'); s.classList.add('compass');
  s.innerHTML = '<circle cx="26" cy="26" r="23" style="fill:var(--surface2);stroke:var(--line)" stroke-width="1.5"/>'
    + '<path d="M26 5v4M26 43v4M5 26h4M43 26h4" style="stroke:var(--muted)" stroke-width="1.5"/>'
    + '<path class="needle" d="M26 9 L31 29 L26 25 L21 29 Z" style="fill:var(--accent)"/>';
  return s;
}

const ARROWS = {
  up: '<path d="M7 12V2M3 6l4-4 4 4"/>',
  down: '<path d="M7 2v10M3 8l4 4 4-4"/>',
  steady: '<path d="M2 7h10M8 3l4 4-4 4"/>',
};
const WORDS = { up: 'rising', down: 'falling', steady: 'steady' };

function sparkSvg() {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('width', '104'); s.setAttribute('height', '34'); s.setAttribute('viewBox', '0 0 112 34');
  s.setAttribute('preserveAspectRatio', 'none'); s.setAttribute('aria-hidden', 'true');
  s.classList.add('spark');
  s.innerHTML = '<path class="area" style="fill:var(--accentSoft)"/>'
    + '<path class="line" style="fill:none;stroke:var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  return s;
}

/** Build the tile buttons once; returns an update(R) function. */
export function mountTiles(container, defs, onOpen) {
  const views = defs.map((def) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.tile = def.id;
    b.innerHTML = `<div class="tile-top"><span class="tile-label"></span><span class="trend" data-dir="steady"></span></div>
      <div class="tile-main"><div class="tile-value"><span class="v">—</span><span class="u"></span></div></div>
      <dl class="tile-subs"></dl>`;
    b.querySelector('.tile-label').textContent = def.label;
    b.dataset.sensor = def.sensor;
    const compass = def.compass ? compassSvg() : null;
    if (compass) b.querySelector('.tile-main').append(compass);
    const spark = def.spark ? sparkSvg() : null;
    if (spark) b.querySelector('.tile-main').append(spark);
    b.addEventListener('click', () => onOpen && onOpen(def.id));
    container.append(b);
    return {
      def, b, compass, spark, trendKey: '',
      v: b.querySelector('.v'), u: b.querySelector('.u'), subs: b.querySelector('.tile-subs'),
      trend: b.querySelector('.trend'),
    };
  });

  return function update(R) {
    for (const t of views) {
      const { def } = t;
      t.b.hidden = Boolean(def.optional) && R.get(def.field).v === null;
      if (t.b.hidden) continue;
      const value = def.value(R);
      const unit = typeof def.unit === 'function' ? def.unit(R) : def.unit;
      t.v.textContent = value;
      t.u.textContent = unit;
      if (def.band) {
        const band = def.band(R);
        t.u.classList.toggle('band', Boolean(band));
        t.u.style.background = band ? band.color : '';
        t.u.style.color = band ? band.ink : '';
      }
      const subs = def.subs(R, def);
      if (t.subs.childElementCount !== subs.length) {
        t.subs.replaceChildren(...subs.map(() => {
          const row = document.createElement('div');
          row.append(document.createElement('dt'), document.createElement('dd'));
          return row;
        }));
      }
      subs.forEach(([k, v], i) => {
        const row = t.subs.children[i];
        row.children[0].textContent = k;
        row.children[1].textContent = v;
      });
      const state = R.state(def.field);
      t.b.dataset.state = state;
      if (t.compass) {
        const calm = def.calm(R);
        const d = def.dir(R);
        t.compass.dataset.calm = String(calm || !Number.isFinite(d));
        t.compass.querySelector('.needle').style.transform = `rotate(${Number.isFinite(d) ? d : 0}deg)`;
        t.compass.setAttribute('aria-label', calm ? 'Calm' : `Wind from ${compassPoint(d)} ${fmt(d, 0)} degrees`);
      }
      const tr = def.trendFn ? def.trendFn(R) : def.trend ? R.trends.trend(def.trend) : null;
      let trendWords = '';
      if (tr) {
        const key = `${tr.dir}|${tr.text}`;
        if (key !== t.trendKey) {
          t.trendKey = key;
          t.trend.dataset.dir = tr.dir;
          t.trend.innerHTML = tr.text
            ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ARROWS[tr.dir]}</svg>`
            : '';
          t.trend.append(tr.text);
        }
        if (tr.text) trendWords = def.trendFn ? `, ${tr.text}` : `, ${WORDS[tr.dir]} ${tr.text}`;
      }
      if (t.spark) {
        const p = sparkPaths(R.trends.buckets(def.spark.field, 6, 300, def.spark.mode || 'mean'));
        t.spark.querySelector('.line').setAttribute('d', p.line);
        t.spark.querySelector('.area').setAttribute('d', p.area);
      }
      const notLive = state === 'offline' ? '. Not updating' : state === 'archive' ? '. From the archive record' : '';
      t.b.setAttribute('aria-label', `${def.label}: ${value} ${unit}${trendWords}${notLive}. Open history`);
    }
  };
}
