// "Now" hero card: conditions icon + text, big temperature, trend sentence,
// key stats and the archive timing line.

import { fmtTime, compassPoint, fmtSigned, fmtU, fmtUL, fmtDeg, conv, unitDp, unitLabel } from './units.js';
import { icon } from './icons.js';
import { pressureTendency, TREND_RULES } from './trend.js';
import { currentConditions } from './conditions.js';
import { fireNow } from './tiles.js';
import { fireBand } from './fire.js';

const WORD = { up: 'Rising', down: 'Falling', steady: 'Steady' };
const ARROW = {
  up: '<path d="M7 12V2M3 6l4-4 4 4"/>',
  down: '<path d="M7 2v10M3 8l4 4 4-4"/>',
  steady: '<path d="M2 7h10M8 3l4 4-4 4"/>',
};

// Convective cloud base above the station: the dew point falls about 2 °C
// per km in rising air and the temperature about 10 °C (dry adiabatic), so
// the gap closes at ~8 °C/km: 1000 ft per 4.4 °F of spread = 124.7 m per °C.
// (The same estimate DivumWX uses, without adding the station elevation.)
function cloudBase(t, td) {
  if (!Number.isFinite(t) || !Number.isFinite(td)) return '—';
  const m = Math.max(0, t - td) * 124.7;
  if (m < 30) return 'At ground level';
  return `${Math.round(conv('height', m) / 10) * 10} ${unitLabel('height')}`;
}

export function renderHero(root, R, trends, cfg, sunAlt, cloud) {
  const q = (s) => root.querySelector(s);
  const cond = currentConditions(R, trends, sunAlt, cloud);
  const key = cond.icon;
  if (root.dataset.icon !== key) {
    root.dataset.icon = key;
    q('.hero-icon').innerHTML = icon(cond.icon, 104, cond.text);
  }
  q('.hero-cond').textContent = `Now · ${cond.text}`;
  q('.hero-temp').textContent = fmtU('temp', R.get('outTemp').v, 1);
  q('.hero-unit').textContent = unitLabel('temp');

  const tr = trends.trend('outTemp');
  const trendEl = q('.hero-trend');
  if (tr && tr.delta !== null) {
    trendEl.dataset.dir = tr.dir;
    trendEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ARROW[tr.dir]}</svg>`;
    trendEl.append(`${WORD[tr.dir]} · ${fmtSigned(conv('tempDelta', tr.delta), unitDp('tempDelta', 1))} ${unitLabel('temp')} in the last hour`);
  } else {
    trendEl.textContent = '';
  }

  // fire danger badge, only when there is a rating (Moderate and above)
  const ffdi = fireNow(R);
  const band = fireBand(ffdi);
  const fire = q('.hero-fire');
  fire.hidden = !(cfg.options && cfg.options.fire.enabled) || !band || ffdi < 12;
  if (!fire.hidden) {
    fire.textContent = `Fire danger ${band.name} · FFDI ${Math.round(ffdi)}`;
    fire.style.background = band.color;
    fire.style.color = band.ink;
    fire.setAttribute('aria-label', `Fire danger ${band.name}, forest fire danger index ${Math.round(ffdi)}, indicative. Open history`);
  }

  const t = R.today('outTemp');
  const ws = R.get('windSpeed').v;
  const wd = R.get('windDir').v;
  const calm = (Number.isFinite(ws) && ws < 0.05) || (R.get('windSpeed').src === 'live' && !R.inLatestPacket('windDir'));
  const d3 = trends.delta('barometer', TREND_RULES.barometer.window);
  const dayRain = R.get('dayRain');
  const stats = [
    ['Feels like', fmtUL('temp', R.get('appTemp').v, 1)],
    ['Today high / low', t.max === null ? '—' : `${fmtDeg(t.max, 1)} / ${fmtDeg(t.min, 1)}`],
    ['Wind', calm ? 'Calm' : `${fmtUL('wind', ws, 1)} ${Number.isFinite(wd) ? compassPoint(wd) : ''}`.trim()],
    ['Gust', fmtUL('wind', R.get('windGust').v, 1)],
    ['Rain today', fmtUL('rain', dayRain.src === 'live' ? dayRain.v : R.rain('day'), 1)],
    ['Pressure', `${fmtUL('pressure', R.get('barometer').v, 1)}${d3 === null ? '' : ` · ${pressureTendency(d3).toLowerCase()}`}`],
    ['Dew point', fmtUL('temp', R.get('dewpoint').v, 1)],
    ['Cloud base', cloudBase(R.get('outTemp').v, R.get('dewpoint').v)],
  ];
  const grid = q('.hero-stats');
  if (grid.childElementCount !== stats.length) {
    grid.replaceChildren(...stats.map(() => {
      const d = document.createElement('div');
      d.innerHTML = '<div class="k"></div><div class="v num"></div>';
      return d;
    }));
  }
  stats.forEach(([k, v], i) => {
    grid.children[i].children[0].textContent = k;
    grid.children[i].children[1].textContent = v;
  });

  const cur = R.current;
  const iv = cfg.station.archive_interval_s || 300;
  if (cur && cur.record && cur.record.dateTime) {
    q('.hero-archive').textContent = `Archive record ${fmtTime(cur.record.dateTime)} · next ${fmtTime(cur.record.dateTime + iv)} · interval ${iv / 60} min`;
  }
  return cond;
}
