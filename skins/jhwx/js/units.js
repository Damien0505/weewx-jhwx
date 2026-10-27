// The one place that converts units and formats values for display.
//
// MQTT loop packets arrive in US units (weewx-mqtt, key suffix = unit); the
// skin's generated JSON is already metric and is never converted here.

const LOCALE = 'en-AU';

// US -> metric for each MQTT key suffix the station sends.
const FROM_US = {
  F: (v) => (v - 32) * 5 / 9,                 // degree_F -> °C
  inHg: (v) => v * 33.8639,                   // -> hPa
  mph: (v) => v * 1.609344,                   // -> km/h
  in: (v) => v * 25.4,                        // -> mm
  inch_per_hour: (v) => v * 25.4,             // -> mm/h
  foot: (v) => v * 0.3048,                    // -> m
  mile: (v) => v * 1.609344,                  // -> km
};

// Unit suffixes weewx-mqtt appends, longest first so "inch_per_hour" wins over "in".
const SUFFIXES = ['inch_per_hour', 'kg_per_meter_cubed', 'microgram_per_meter_cubed',
  'Wpm2', 'inHg', 'foot', 'mile', 'volt', 'mph', 'ppm', 'in', 'F'];

/**
 * Turn a weewx-mqtt loop packet (all values strings, US units) into
 * { observationName: metricNumber }.  Keys without a known unit suffix are
 * kept as plain numbers (outHumidity, UV, windDir, dateTime ...).
 */
export function packetToMetric(packet) {
  const out = {};
  for (const [key, raw] of Object.entries(packet)) {
    const v = Number(raw);
    if (raw === null || raw === '' || !Number.isFinite(v)) continue;
    let name = key;
    let conv = null;
    for (const s of SUFFIXES) {
      if (key.endsWith('_' + s)) {
        name = key.slice(0, -(s.length + 1));
        conv = FROM_US[s] || null;
        break;
      }
    }
    out[name] = conv ? conv(v) : v;
  }
  return out;
}

// HP1000-driver raw fields that duplicate converted ones (and are really °C
// with no suffix).  Never displayed.
export const IGNORED_FIELDS = new Set(['dewPoint', 'windChill', 'usUnits']);

const nf = new Map();
function numberFormat(dp) {
  if (!nf.has(dp)) {
    // no thousands separator: "1014.2 hPa", as in the design
    nf.set(dp, new Intl.NumberFormat(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: false }));
  }
  return nf.get(dp);
}

/** Number with fixed decimals, en-AU grouping, real minus sign; '—' if missing. */
export function fmt(v, dp = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  // avoid "-0.0"
  const r = Math.round(v * 10 ** dp) / 10 ** dp;
  return numberFormat(dp).format(r === 0 ? 0 : r).replace('-', '−');
}

/** Signed number for rates: +0.6, −1.1, ±0.0 */
export function fmtSigned(v, dp = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = fmt(Math.abs(v), dp);
  const r = Math.round(v * 10 ** dp);
  return (r > 0 ? '+' : r < 0 ? '−' : '±') + s;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 337 -> 'NNW' */
export function compassPoint(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '';
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', hour12: true });
const timeSecFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const lower = (s) => s.replace(/\s?([AP])M/i, (_m, ap) => ' ' + ap.toLowerCase() + 'm');

/** epoch seconds or Date -> '2:30 pm' */
export function fmtTime(t) {
  if (t === null || t === undefined) return '—';
  return lower(timeFmt.format(t instanceof Date ? t : new Date(t * 1000)));
}
/** Date -> '2:30:05 pm' */
export function fmtClock(d) { return lower(timeSecFmt.format(d)); }
/** epoch seconds or Date -> '25 Oct 2026' */
export function fmtDate(t) {
  if (t === null || t === undefined) return '—';
  return dateFmt.format(t instanceof Date ? t : new Date(t * 1000));
}
/** Date -> 'Sunday 25 October 2026' */
export function fmtLongDate(d) { return longDateFmt.format(d).replace(',', ''); }

/** seconds -> '4 s ago', '3 min ago', '2 h ago' */
export function fmtAge(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

/** UV index category (WHO). */
export function uvCategory(uv) {
  if (uv === null || uv === undefined || !Number.isFinite(uv)) return '';
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

/** Absolute humidity, g/m³, from °C and %RH (Magnus). */
export function absoluteHumidity(tC, rh) {
  if (!Number.isFinite(tC) || !Number.isFinite(rh)) return null;
  const es = 6.112 * Math.exp(17.67 * tC / (tC + 243.5));
  return es * rh * 2.1674 / (273.15 + tC);
}

// ------------------------------------------------------------ display units
// Everything inside the app is metric.  These convert at display time to the
// viewer's choice (Units menu, remembered in this browser).

const DISPLAY = {
  temp: {
    C: { label: '°C', f: (v) => v },
    F: { label: '°F', f: (v) => v * 9 / 5 + 32 },
  },
  wind: {
    kmh: { label: 'km/h', f: (v) => v },
    ms: { label: 'm/s', f: (v) => v / 3.6 },
    mph: { label: 'mph', f: (v) => v / 1.609344 },
    kn: { label: 'kn', f: (v) => v / 1.852 },
  },
  pressure: {
    hPa: { label: 'hPa', f: (v) => v },
    kPa: { label: 'kPa', f: (v) => v / 10, dp: 1 },
    inHg: { label: 'inHg', f: (v) => v / 33.8639, dp: 1 },
    mmHg: { label: 'mmHg', f: (v) => v / 1.333224 },
  },
  rain: {
    mm: { label: 'mm', f: (v) => v },
    in: { label: 'in', f: (v) => v / 25.4, dp: 1 },
  },
  distance: {
    km: { label: 'km', f: (v) => v },
    mi: { label: 'mi', f: (v) => v / 1.609344 },
  },
};
// derived groups follow their parent's choice
// (height: metres, shown as m with km or ft with miles)
const PARENT = { tempDelta: 'temp', rainRate: 'rain', height: 'distance' };

export const UNIT_GROUPS = [
  ['temp', 'Temperature'], ['wind', 'Wind'], ['pressure', 'Pressure'], ['rain', 'Rain'], ['distance', 'Distance'],
];
export const UNIT_PRESETS = {
  Metric: { temp: 'C', wind: 'kmh', pressure: 'hPa', rain: 'mm', distance: 'km' },
  Imperial: { temp: 'F', wind: 'mph', pressure: 'inHg', rain: 'in', distance: 'mi' },
  UK: { temp: 'C', wind: 'mph', pressure: 'hPa', rain: 'mm', distance: 'mi' },
};

const prefs = { ...UNIT_PRESETS.Metric };
try {
  const saved = JSON.parse(localStorage.getItem('jhwx.units') || '{}');
  for (const [g, k] of Object.entries(saved)) if (DISPLAY[g] && DISPLAY[g][k]) prefs[g] = k;
} catch (e) { /* ignore */ }

export function unitChoices(group) {
  return Object.entries(DISPLAY[group]).map(([k, d]) => [k, d.label]);
}
export function unitPref(group) { return prefs[PARENT[group] || group]; }
export function setUnit(group, key) {
  if (!DISPLAY[group] || !DISPLAY[group][key]) return;
  prefs[group] = key;
  try { localStorage.setItem('jhwx.units', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  document.dispatchEvent(new Event('jhwx-units'));
}

function def(group) { return DISPLAY[PARENT[group] || group][unitPref(group)]; }

/** Metric value -> display value (temperature differences scale only). */
export function conv(group, v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (group === 'tempDelta') return unitPref('temp') === 'F' ? v * 9 / 5 : v;
  if (group === 'height') return unitPref('distance') === 'mi' ? v / 0.3048 : v;
  return def(group).f(v);
}
/** Unit label: '°C', 'km/h', 'in/h' ... */
export function unitLabel(group) {
  if (group === 'tempDelta') return def('temp').label;
  if (group === 'rainRate') return `${def('rain').label}/h`;
  if (group === 'height') return unitPref('distance') === 'mi' ? 'ft' : 'm';
  return def(group).label;
}
/** Decimals: the metric decimals plus any extra the unit needs (inHg 2 ...). */
export function unitDp(group, metricDp) { return group === 'height' ? metricDp : metricDp + (def(group).dp || 0); }
/** Formatted number in display units (no label). */
export function fmtU(group, v, metricDp = 1) { return fmt(conv(group, v), unitDp(group, metricDp)); }
/** Formatted number + label: '12.4 °C', '7.2 km/h'. */
export function fmtUL(group, v, metricDp = 1) {
  const s = fmtU(group, v, metricDp);
  return s === '—' ? s : `${s} ${unitLabel(group)}`;
}
/** Temperature with a bare degree sign: '12.4°'. */
export function fmtDeg(v, dp = 1) {
  const s = fmtU('temp', v, dp);
  return s === '—' ? s : `${s}°`;
}
