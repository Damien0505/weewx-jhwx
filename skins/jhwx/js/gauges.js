// Gauges view: SteelSeries-style radial gauges drawn as SVG (geometry from
// the approved mockup's gauge()).  Same readings and pop-ups as the tiles.

import { fmt, compassPoint, uvCategory, conv, fmtU, fmtUL, unitLabel, unitPref } from './units.js';

const svgNS = 'http://www.w3.org/2000/svg';

// Scale per display unit: [min, max, majors, minors, labelEvery, labelDp].
// Metric scales are the DESIGN-SPEC "Gauges mode" ones.
const SCALES = {
  temp: { C: [-10, 40, 10, 5, 1], F: [10, 110, 10, 5, 1] },
  wind: { kmh: [0, 80, 8, 5, 1], ms: [0, 24, 8, 3, 1], mph: [0, 50, 10, 5, 1], kn: [0, 45, 9, 5, 1] },
  pressure: { hPa: [990, 1040, 10, 5, 2], kPa: [99, 104, 10, 5, 2], inHg: [29.2, 30.8, 8, 4, 2, 1], mmHg: [740, 780, 8, 5, 2] },
  rain: { mm: [0, 25, 5, 5, 1], in: [0, 1, 5, 4, 1, 1] },
};

/** Gauge definitions for the current display units.  value/maxv return
 *  metric values; `group` gauges are converted for display. */
export function gaugeDefs(cfg) {
  const power = (cfg && cfg.options && cfg.options.power) || {};
  const cap = power.supercap;
  const batt = power.battery;
  const defs = [
    { id: 'g-temp', ref: 'temp', field: 'outTemp', name: 'Temp', group: 'temp',
      sections: [[-50, 0, '#4F8FE8'], [0, 30, '#3FA36B'], [30, 60, '#D9382A']],
      value: (R) => R.get('outTemp').v, maxv: (R) => R.today('outTemp').max,
      lcd: (R) => fmtUL('temp', R.get('outTemp').v, 1) },
    { id: 'g-hum', ref: 'hum', field: 'outHumidity', title: 'Humidity %', min: 0, max: 100, majors: 10, minors: 2, labelEvery: 2,
      sections: [[0, 30, '#E0892E'], [30, 70, '#3FA36B'], [70, 100, '#4F8FE8']],
      value: (R) => R.get('outHumidity').v, maxv: (R) => R.today('outHumidity').max,
      lcd: (R) => `${fmt(R.get('outHumidity').v, 0)} %` },
    { id: 'g-wind', ref: 'wind', field: 'windSpeed', name: 'Wind', group: 'wind',
      sections: [[0, 30, '#3FA36B'], [30, 50, '#E0B22E'], [50, 300, '#D9382A']],
      value: (R) => R.get('windSpeed').v, maxv: (R) => R.today('windGust').max,
      lcd: (R) => `${fmtU('wind', R.get('windSpeed').v, 1)} / ${fmtU('wind', R.get('windGust').v, 1)}` },
    { id: 'g-dir', ref: 'wind', field: 'windDir', title: 'Direction', min: 0, max: 360, majors: 8, minors: 3, compass: true,
      names: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
      value: (R) => R.get('windDir').v, maxv: () => null,
      calm: (R) => {
        const s = R.get('windSpeed').v;
        return (Number.isFinite(s) && s < 0.05) || (R.get('windSpeed').src === 'live' && !R.inLatestPacket('windDir'));
      },
      lcd: (R, def) => (def.calm(R) ? 'Calm' : `${fmt(R.get('windDir').v, 0)}° ${compassPoint(R.get('windDir').v)}`) },
    { id: 'g-baro', ref: 'baro', field: 'barometer', name: 'Pressure', group: 'pressure',
      sections: [[900, 1005, '#4F8FE8'], [1005, 1025, '#3FA36B'], [1025, 1100, '#E0B22E']],
      value: (R) => R.get('barometer').v, maxv: (R) => R.today('barometer').max,
      lcd: (R) => fmtU('pressure', R.get('barometer').v, 1) },
    { id: 'g-rain', ref: 'rain', field: 'dayRain', name: 'Rain', group: 'rain',
      sections: [[0, 10, '#7FB5F0'], [10, 20, '#4F8FE8'], [20, 1000, '#2F5FB8']],
      value: (R) => { const d = R.get('dayRain'); return d.src === 'live' ? d.v : R.rain('day'); },
      maxv: () => null,
      lcd: (R, def) => fmtUL('rain', def.value(R), 1) },
    { id: 'g-solar', ref: 'solar', field: 'radiation', title: 'Solar W/m²', min: 0, max: 1200, majors: 6, minors: 4,
      sections: [[0, 400, '#E9C46A'], [400, 800, '#F0A23A'], [800, 1200, '#E06C2E']],
      value: (R) => R.get('radiation').v, maxv: (R) => R.today('radiation').max,
      lcd: (R) => fmt(R.get('radiation').v, 0) },
    { id: 'g-uv', ref: 'uv', field: 'UV', title: 'UV index', min: 0, max: 12, majors: 12, minors: 2, labelEvery: 2,
      sections: [[0, 3, '#3FA36B'], [3, 8, '#E0B22E'], [8, 12, '#D9382A']],
      value: (R) => R.get('UV').v, maxv: (R) => R.today('UV').max,
      lcd: (R) => `${fmt(R.get('UV').v, 1)} ${uvCategory(R.get('UV').v)}`.trim() },
  ];
  // voltage gauges from [[power]]: supercap 0..max, battery min..max with the
  // Low / Fair / Good thresholds as coloured sections
  if (cap) {
    const lo = cap.min;
    const hi = cap.max;
    defs.push({ id: 'g-cap', ref: 'cap', field: cap.field, title: `${cap.label} V`, min: lo, max: hi,
      majors: Math.round(hi - lo), minors: 5, optional: true,
      sections: [[lo, lo + (hi - lo) / 6, '#E0892E'], [lo + (hi - lo) / 6, hi, '#3FA36B']],
      value: (R) => R.get(cap.field).v, maxv: (R) => R.today(cap.field).max,
      lcd: (R) => `${fmt(R.get(cap.field).v, 2)} V` });
  }
  if (batt) {
    const lo = batt.min;
    const hi = batt.max;
    const low = Number.isFinite(batt.low) ? batt.low : lo;
    const fair = Number.isFinite(batt.fair) ? batt.fair : low;
    defs.push({ id: 'g-batt', ref: 'batt', field: batt.field, title: `${batt.label} V`, min: lo, max: hi,
      majors: 8, minors: 2, labelEvery: 2, labelDp: 1, optional: true,
      sections: [[lo, low, '#D9382A'], [low, fair, '#E0B22E'], [fair, hi, '#3FA36B']],
      value: (R) => R.get(batt.field).v, maxv: (R) => R.today(batt.field).max,
      lcd: (R) => `${fmt(R.get(batt.field).v, 2)} V` });
  }

  for (const d of defs) {
    if (!d.group) continue;
    const [min, max, majors, minors, labelEvery, labelDp] = SCALES[d.group][unitPref(d.group)];
    Object.assign(d, { min, max, majors, minors, labelEvery, labelDp, title: `${d.name} ${unitLabel(d.group)}` });
    d.sections = d.sections.map(([a, b, c]) => [conv(d.group, a), conv(d.group, b), c]);
  }
  return defs;
}

/** Static geometry (ticks, labels, range arcs) and an angle function. */
export function gaugeGeometry(o) {
  const pt = (a, rr) => {
    const r = a * Math.PI / 180;
    return `${(100 + rr * Math.sin(r)).toFixed(1)} ${(100 - rr * Math.cos(r)).toFixed(1)}`;
  };
  const a0 = o.compass ? 0 : -135;
  const sw = o.compass ? 360 : 270;
  const clamp = (v) => Math.min(o.max, Math.max(o.min, v));
  const ang = (v) => a0 + sw * (clamp(v) - o.min) / (o.max - o.min);
  let major = '';
  let minor = '';
  const lastMaj = o.compass ? o.majors - 1 : o.majors;
  for (let k = 0; k <= lastMaj; k++) {
    const a = a0 + sw * k / o.majors;
    major += `M${pt(a, 83)} L${pt(a, 72)} `;
  }
  const totMin = o.majors * o.minors;
  for (let k = 0; k < totMin + (o.compass ? 0 : 1); k++) {
    if (k % o.minors === 0) continue;
    const a = a0 + sw * k / totMin;
    minor += `M${pt(a, 83)} L${pt(a, 78)} `;
  }
  const labels = [];
  const step = o.labelEvery || 1;
  for (let k = 0; k <= lastMaj; k += step) {
    const a = a0 + sw * k / o.majors;
    const r = a * Math.PI / 180;
    const n = o.min + (o.max - o.min) * k / o.majors;
    const t = o.names ? o.names[k] : o.labelDp ? n.toFixed(o.labelDp) : String(Math.round(n));
    labels.push({ x: (100 + 60 * Math.sin(r)) / 2, y: (100 - 60 * Math.cos(r)) / 2, t });
  }
  const arc = (sec) => {
    const a1 = ang(sec[0]);
    const a2 = ang(sec[1]);
    return { d: `M${pt(a1, 86.5)} A86.5 86.5 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${pt(a2, 86.5)}`, c: sec[2] };
  };
  return { major, minor, labels, arcs: (o.sections || []).map(arc), ang };
}

function buildGauge(def) {
  const g = gaugeGeometry(def);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile gauge';
  b.dataset.gauge = def.id;
  const wrap = document.createElement('div');
  wrap.className = 'g-face';
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('viewBox', '0 0 200 200');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<defs><linearGradient id="bz-${def.id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F1F3F5"/><stop offset=".45" stop-color="#7D8790"/>
      <stop offset=".7" stop-color="#C9CED3"/><stop offset="1" stop-color="#5E6870"/></linearGradient></defs>
    <circle cx="100" cy="100" r="98" fill="url(#bz-${def.id})"/>
    <circle cx="100" cy="100" r="90" style="fill:var(--gaugeFace)"/>
    ${g.arcs.map((a) => `<path d="${a.d}" style="fill:none;stroke:${a.c}" stroke-width="5"/>`).join('')}
    <path d="${g.major}" style="fill:none;stroke:var(--gaugeTick)" stroke-width="2"/>
    <path d="${g.minor}" style="fill:none;stroke:var(--gaugeTick);opacity:.55" stroke-width="1"/>
    <path class="g-max" d="M100 14 L95.5 6 L104.5 6 Z" style="fill:${def.compass ? 'transparent' : '#D9382A'}"/>
    <path class="g-needle" d="M97.4 104 L100 20 L102.6 104 Z" style="fill:#D9382A"/>
    <circle cx="100" cy="100" r="8.5" style="fill:#3A444D"/>
    <circle cx="100" cy="100" r="3.5" style="fill:#C9CED3"/>`;
  wrap.append(s);
  for (const l of g.labels) {
    const span = document.createElement('span');
    span.className = 'g-label';
    span.style.left = `${l.x.toFixed(1)}%`;
    span.style.top = `${l.y.toFixed(1)}%`;
    span.textContent = l.t;
    wrap.append(span);
  }
  const title = document.createElement('span');
  title.className = 'g-title';
  title.textContent = def.title;
  const lcd = document.createElement('span');
  lcd.className = 'g-lcd';
  wrap.append(title, lcd);
  const foot = document.createElement('div');
  foot.className = 'g-foot';
  foot.innerHTML = '<span class="trend" data-dir="steady"></span>';
  b.append(wrap, foot);
  return { def, b, g, needle: s.querySelector('.g-needle'), max: s.querySelector('.g-max'), lcd, foot };
}

export function mountGauges(container, defs, onOpen) {
  const views = defs.map((def) => {
    const v = buildGauge(def);
    v.b.addEventListener('click', () => onOpen && onOpen(def.ref));
    container.append(v.b);
    return v;
  });
  return function update(R) {
    for (const v of views) {
      const { def } = v;
      v.b.hidden = Boolean(def.optional) && R.get(def.field).v === null;
      if (v.b.hidden) continue;
      const toUnit = (x) => (def.group ? conv(def.group, x) : x);
      const val = toUnit(def.value(R));
      const calm = def.calm ? def.calm(R) : false;
      v.needle.style.display = calm || !Number.isFinite(val) ? 'none' : '';
      if (Number.isFinite(val)) v.needle.setAttribute('transform', `rotate(${v.g.ang(val).toFixed(1)} 100 100)`);
      const mx = toUnit(def.maxv(R));
      v.max.style.display = Number.isFinite(mx) ? '' : 'none';
      if (Number.isFinite(mx)) v.max.setAttribute('transform', `rotate(${v.g.ang(mx).toFixed(1)} 100 100)`);
      const text = def.lcd(R, def);
      v.lcd.textContent = text;
      v.b.dataset.state = R.state(def.field === 'windDir' ? 'windSpeed' : def.field);
      // trend chip mirrors the matching tile
      const tile = document.querySelector(`.tile[data-tile="${def.ref}"]`);
      if (tile) {
        const src = tile.querySelector('.trend');
        const dst = v.foot.querySelector('.trend');
        if (dst.innerHTML !== src.innerHTML) dst.innerHTML = src.innerHTML;
        dst.dataset.dir = src.dataset.dir;
      }
      v.b.setAttribute('aria-label', `${def.title}: ${text}. Open history`);
    }
  };
}
