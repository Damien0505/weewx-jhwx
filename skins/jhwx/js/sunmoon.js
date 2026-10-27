// Sun & moon card.  Rise/set/transit and moon data come from data/astro.json
// (WeeWX almanac); the sun's current elevation/azimuth is computed here from
// the station's lat/lon so it moves smoothly between report cycles.

import { fmt, fmtTime, compassPoint } from './units.js';

const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

/** Sun elevation and azimuth (degrees) - NOAA solar position algorithm,
 *  accurate to well under 0.5° (no refraction). */
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M))
    + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let ha = (utcMin + eqTime + 4 * lon) / 4 - 180;
  if (ha < -180) ha += 360;
  const zen = deg(Math.acos(Math.sin(rad(lat)) * Math.sin(rad(decl))
    + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha))));
  const alt = 90 - zen;
  let az = deg(Math.atan2(Math.sin(rad(ha)),
    Math.cos(rad(ha)) * Math.sin(rad(lat)) - Math.tan(rad(decl)) * Math.cos(rad(lat)))) + 180;
  az = (az + 360) % 360;
  const ra = (deg(Math.atan2(Math.cos(rad(eps)) * Math.sin(rad(lambda)), Math.cos(rad(lambda)))) + 360) % 360;
  return { alt, az, ra, decl };
}

/** Geocentric moon right ascension / declination (degrees), low-precision
 *  series from the Astronomical Almanac (~0.3°) - plenty for which way the
 *  lit side faces. */
export function moonRaDec(date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
  const S = (a, b) => Math.sin(rad(a + b * T));
  const lam = 218.32 + 481267.881 * T + 6.29 * S(135.0, 477198.87) - 1.27 * S(259.3, -413335.36)
    + 0.66 * S(235.7, 890534.22) + 0.21 * S(269.9, 954397.74) - 0.19 * S(357.5, 35999.05)
    - 0.11 * S(186.5, 966404.03);
  const bet = 5.13 * S(93.3, 483202.02) + 0.28 * S(228.2, 960400.89)
    - 0.28 * S(318.3, 6003.15) - 0.17 * S(217.6, -407332.21);
  const eps = rad(23.439 - 0.013 * T);
  const l = rad(lam);
  const b = rad(bet);
  const ra = deg(Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)));
  const decl = deg(Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)));
  return { ra: (ra + 360) % 360, decl };
}

/** How the moon looks from the station right now, with the zenith up:
 *  illuminated fraction, `limb` = direction of the bright limb and `north` =
 *  direction of the moon's north pole, both in degrees clockwise from up. */
export function moonView(date, lat, lon) {
  const sun = sunPosition(date, lat, lon);
  const m = moonRaDec(date);
  const dA = rad(sun.ra - m.ra);
  const ds = rad(sun.decl);
  const dm = rad(m.decl);
  // position angle of the bright limb, from celestial north through east
  const chi = deg(Math.atan2(Math.cos(ds) * Math.sin(dA),
    Math.sin(ds) * Math.cos(dm) - Math.cos(ds) * Math.sin(dm) * Math.cos(dA)));
  // parallactic angle: where the zenith lies, from north through east
  const jd = date.getTime() / 86400000 + 2440587.5;
  const lst = 280.46061837 + 360.98564736629 * (jd - 2451545) + lon;
  const H = rad(lst - m.ra);
  const q = deg(Math.atan2(Math.sin(H), Math.tan(rad(lat)) * Math.cos(dm) - Math.sin(dm) * Math.cos(H)));
  const elong = Math.acos(Math.sin(ds) * Math.sin(dm) + Math.cos(ds) * Math.cos(dm) * Math.cos(dA));
  // position angles run anticlockwise on the sky (east is left with north
  // up), so with the zenith up they appear at (pa - q) anticlockwise
  return { fraction: (1 - Math.cos(elong)) / 2, limb: q - chi, north: q };
}

// Protractor (viewBox 300 x 156): a semicircle centred on the horizon.  The
// dot's angle above the horizon is the sun's true elevation, measured from
// the left (sunrise) end in the morning and from the right (sunset) end in
// the afternoon; at solar noon it crosses over at today's highest elevation.
const CX = 150;
const CY = 142;
const R = 118;

/** Point at elevation `alt` degrees on the morning (left) or afternoon side. */
function pt(alt, am) {
  const a = rad(Math.max(0, Math.min(90, alt)));
  return [CX + (am ? -1 : 1) * R * Math.cos(a), CY - R * Math.sin(a)];
}
const P = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
/** Arc along the circle from alt a0 to a1 on one side (always the short way). */
function arc(a0, a1, am) {
  if (Math.abs(a1 - a0) < 0.05) return '';
  // morning: upward is clockwise; afternoon: downward is clockwise
  const sweep = (am ? a1 > a0 : a1 < a0) ? 1 : 0;
  return `M${P(pt(a0, am))} A${R} ${R} 0 0 ${sweep} ${P(pt(a1, am))}`;
}

/** Dashed semicircle with 30/60/90° ticks (drawn once per card). */
function drawScale(root) {
  if (root.dataset.scale) return;
  root.dataset.scale = '1';
  root.querySelector('.sm-arc').setAttribute('d', `M${CX - R} ${CY} A${R} ${R} 0 0 1 ${CX + R} ${CY}`);
  let d = '';
  const labels = [];
  for (const a of [30, 60, 90]) {
    for (const am of a === 90 ? [true] : [true, false]) {
      const c = Math.cos(rad(a)) * (am ? -1 : 1);
      const sn = Math.sin(rad(a));
      d += `M${(CX + c * (R + 3)).toFixed(1)} ${(CY - sn * (R + 3)).toFixed(1)} `
        + `L${(CX + c * (R + 9)).toFixed(1)} ${(CY - sn * (R + 9)).toFixed(1)} `;
      labels.push(`<text x="${(CX + c * (R + 19)).toFixed(1)}" y="${(CY - sn * (R + 19) + 3.5).toFixed(1)}">${a}°</text>`);
    }
  }
  root.querySelector('.sm-ticks').setAttribute('d', d.trim());
  root.querySelector('.sm-tlabels').innerHTML = labels.join('');
}

function hm(sec) {
  const m = Math.round(Math.abs(sec) / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
function ms(sec) {
  const s = Math.round(Math.abs(sec));
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

/** Shadow over the 64x64 moon disc (r=30 at 32,32) for an illuminated
 *  fraction, with the bright limb toward the right; rotate it into place. */
export function moonShadowPath(fraction) {
  const k = Math.max(0, Math.min(1, fraction));
  const rx = (Math.abs(1 - 2 * k) * 30).toFixed(2);
  // dark limb down the left side, terminator back up: bulging right for a
  // crescent (mostly dark), left for a gibbous moon
  return `M32 2 A30 30 0 0 0 32 62 A${rx} 30 0 0 ${k < 0.5 ? 0 : 1} 32 2 Z`;
}

/** Sun times moved to today if astro.json is from another day (e.g. a report
 *  that stalled, or a page left open past midnight): within a day or two the
 *  times only drift by a minute or so, which beats hiding the sun. */
function sameDay(sun, t) {
  if (!sun.transit) return sun;
  const days = Math.round((t - sun.transit) / 86400);
  if (!days) return sun;
  const out = { ...sun };
  for (const k of ['rise', 'set', 'transit', 'civil_dawn', 'civil_dusk']) {
    if (out[k]) out[k] += days * 86400;
  }
  // yesterday_* stays relative to the shifted day only if we shifted by one
  if (days !== 1) { out.yesterday_rise = null; out.yesterday_set = null; }
  else { out.yesterday_rise = sun.rise; out.yesterday_set = sun.set; }
  return out;
}

export function renderSunMoon(root, astro, cfg, now = new Date()) {
  const q = (s) => root.querySelector(s);
  const lat = cfg.station.latitude;
  const lon = cfg.station.longitude;
  const pos = sunPosition(now, lat, lon);
  const t = now.getTime() / 1000;
  const s = astro && astro.sun && sameDay(astro.sun, t);

  drawScale(root);
  if (s && s.rise && s.set) {
    const day = t >= s.rise && t <= s.set;
    const noon = s.transit && s.transit > s.rise && s.transit < s.set ? s.transit : (s.rise + s.set) / 2;
    const peak = sunPosition(new Date(noon * 1000), lat, lon).alt;
    const am = t < noon;
    // today's track: up the left to the noon elevation, down the right
    q('.sm-track').setAttribute('d', `${arc(0, peak, true)} ${arc(peak, 0, false)}`.trim());
    const alt = Math.max(0, pos.alt);
    const p = pt(alt, am);
    q('.sm-elapsed').setAttribute('d', !day ? ''
      : am ? arc(0, alt, true) : `${arc(0, peak, true)} ${arc(peak, alt, false)}`.trim());
    q('.sm-ray').setAttribute('d', day ? `M${CX} ${CY} L${P(p)}` : '');
    for (const sel of ['.sm-glow', '.sm-dot']) {
      const e = q(sel);
      e.setAttribute('cx', p[0].toFixed(1));
      e.setAttribute('cy', p[1].toFixed(1));
      e.style.display = day ? '' : 'none';
    }
    q('.sm-arcsvg').setAttribute('aria-label', day
      ? `Sun ${am ? 'rising' : 'setting'}, elevation ${fmt(pos.alt, 1)} degrees; highest today ${fmt(peak, 1)} degrees`
      : 'The sun is below the horizon');
    q('.sm-rise').textContent = fmtTime(s.rise);
    q('.sm-set').textContent = fmtTime(s.set);
    const len = s.set - s.rise;
    q('.sm-daylen').textContent = hm(len);
    const ch = q('.sm-daychg');
    if (s.yesterday_rise && s.yesterday_set) {
      const d = len - (s.yesterday_set - s.yesterday_rise);
      ch.textContent = `${d >= 0 ? '+' : '−'}${ms(d)}`;
      ch.dataset.dir = d >= 0 ? 'up' : 'down';
    } else {
      ch.textContent = '';
    }
    q('.sm-noon').textContent = s.transit ? fmtTime(s.transit) : '—';
  }
  q('.sm-alt').textContent = `${fmt(pos.alt, 1)}°`;
  q('.sm-az').textContent = `${fmt(pos.az, 0)}° ${compassPoint(pos.az)}`;

  const m = astro && astro.moon;
  if (m) {
    // drawn as seen from the station: shadow and photo turned so the zenith is up
    const v = moonView(now, lat, lon);
    const dark = q('.sm-moondark');
    dark.setAttribute('d', moonShadowPath(v.fraction));
    dark.setAttribute('transform', `rotate(${(v.limb - 90).toFixed(1)} 32 32)`);
    q('.sm-moonimg').setAttribute('transform', `rotate(${v.north.toFixed(1)} 32 32)`);
    const phase = m.phase || '';
    q('.sm-phase').textContent = `${phase}${phase ? ' · ' : ''}${fmt(m.fullness, 0)}%`;
    q('.sm-moonsvg').setAttribute('aria-label', `${phase} moon, ${fmt(m.fullness, 0)} percent illuminated`);
    const nextFull = m.next_full;
    const nextNew = m.next_new;
    const next = nextFull && (!nextNew || nextFull < nextNew)
      ? ['Full moon', nextFull] : ['New moon', nextNew];
    const dd = new Date(next[1] * 1000);
    q('.sm-next').textContent = next[1]
      ? `${next[0]} ${dd.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')}`
      : '';
    q('.sm-moonrs').textContent = `Rise ${fmtTime(m.rise)} · Set ${fmtTime(m.set)}`;
  }
  return pos;
}
