// 7-day forecast from Open-Meteo (CC BY 4.0) for the station's lat/lon.
// Also supplies current cloud cover (night-time conditions icon), today's
// outlook line, tomorrow's UV maximum and the hourly forecast (hourly.js).

import { fmtAge, compassPoint, fmtUL, fmtDeg, unitPref } from './units.js';
import { icon } from './icons.js';

const URL_BASE = 'https://api.open-meteo.com/v1/forecast';
const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15000;
const TODAY_MIN_H = 12;       // hourly 'Today' shows at least this many hours

// WMO weather interpretation codes -> [text, icon]
const WMO = {
  0: ['Clear', 'sunny'], 1: ['Mostly clear', 'sunny'], 2: ['Partly cloudy', 'partly'], 3: ['Cloudy', 'cloudy'],
  45: ['Fog', 'cloudy'], 48: ['Rime fog', 'cloudy'],
  51: ['Light drizzle', 'showers'], 53: ['Drizzle', 'showers'], 55: ['Heavy drizzle', 'showers'],
  56: ['Freezing drizzle', 'showers'], 57: ['Freezing drizzle', 'showers'],
  61: ['Light rain', 'showers'], 63: ['Rain', 'showers'], 65: ['Heavy rain', 'heavyrain'],
  66: ['Freezing rain', 'showers'], 67: ['Freezing rain', 'heavyrain'],
  71: ['Light snow', 'cloudy'], 73: ['Snow', 'cloudy'], 75: ['Heavy snow', 'cloudy'], 77: ['Snow grains', 'cloudy'],
  80: ['Showers', 'showers'], 81: ['Showers', 'showers'], 82: ['Heavy showers', 'heavyrain'],
  85: ['Snow showers', 'cloudy'], 86: ['Snow showers', 'cloudy'],
  95: ['Thunderstorms', 'thunder'], 96: ['Thunderstorms, hail', 'thunder'], 99: ['Thunderstorms, hail', 'thunder'],
};
export const wmo = (code) => WMO[code] || ['—', 'cloudy'];

export class Forecast extends EventTarget {
  constructor(lat, lon) {
    super();
    this.lat = lat;
    this.lon = lon;
    this.data = null;
    this.fetchedAt = null;
    this.error = null;
  }

  url() {
    const p = new URLSearchParams({
      latitude: this.lat,
      longitude: this.lon,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,'
        + 'precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max',
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,'
        + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day',
      current: 'cloud_cover,weather_code',
      timezone: 'auto',
      forecast_days: '7',
      wind_speed_unit: 'kmh',
    });
    return `${URL_BASE}?${p}`;
  }

  async start() {
    let next = REFRESH_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(this.url(), { signal: ctl.signal });
      if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
      const d = await r.json();
      if (!d.daily || !Array.isArray(d.daily.time)) throw new Error('Open-Meteo: unexpected response');
      this.data = d;
      this.fetchedAt = Date.now();
      this.error = null;
    } catch (e) {
      this.error = e.name === 'AbortError' ? 'Open-Meteo timed out' : String(e.message || e);
      next = RETRY_MS;
    } finally {
      clearTimeout(timer);
    }
    this.dispatchEvent(new Event('update'));
    setTimeout(() => this.start(), next);
  }

  get cloudCover() {
    const c = this.data && this.data.current;
    return c && Number.isFinite(c.cloud_cover) ? c.cloud_cover : null;
  }

  day(i) {
    const d = this.data && this.data.daily;
    if (!d || i >= d.time.length) return null;
    return {
      date: d.time[i],
      code: d.weather_code[i],
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      rain: d.precipitation_sum[i],
      pop: d.precipitation_probability_max[i],
      wind: d.wind_speed_10m_max[i],
      dir: d.wind_direction_10m_dominant[i],
      uv: d.uv_index_max[i],
    };
  }

  /** Hours of day `i` (station local time).  Today's start at the current hour
   *  and run on into tomorrow if fewer than TODAY_MIN_H are left. */
  hours(i) {
    const d = this.data;
    const day = this.day(i);
    if (!day || !d.hourly || !Array.isArray(d.hourly.time)) return [];
    const h = d.hourly;
    // the current hour at the station, as Open-Meteo writes it ('YYYY-MM-DDTHH')
    const nowHour = new Date(Date.now() + (d.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 13);
    const out = [];
    h.time.forEach((t, k) => {
      if (i === 0) {
        if (t.slice(0, 13) < nowHour || (!t.startsWith(day.date) && out.length >= TODAY_MIN_H)) return;
      } else if (!t.startsWith(day.date)) return;
      out.push({
        time: t, now: t.slice(0, 13) === nowHour,
        temp: h.temperature_2m[k], feel: h.apparent_temperature[k],
        pop: h.precipitation_probability[k], rain: h.precipitation[k], code: h.weather_code[k],
        wind: h.wind_speed_10m[k], dir: h.wind_direction_10m[k], gust: h.wind_gusts_10m[k],
        uv: h.uv_index[k], isDay: h.is_day[k] === 1,
      });
    });
    return out;
  }

  /** "Rest of today (Open-Meteo): rain, max 14°, 80% chance of rain." */
  outlook() {
    const t = this.day(0);
    if (!t) return '';
    const parts = [wmo(t.code)[0].toLowerCase(), `max ${fmtDeg(t.max, 0)}`];
    if (Number.isFinite(t.pop) && t.pop > 0) parts.push(`${t.pop}% chance of rain`);
    return `Today (Open-Meteo): ${parts.join(', ')}.`;
  }

  ageText() {
    if (this.error && !this.data) return this.error;
    const a = this.fetchedAt ? fmtAge((Date.now() - this.fetchedAt) / 1000) : '—';
    return this.error ? `${a} · ${this.error}` : `updated ${a}`;
  }
}

const dayFmt = new Intl.DateTimeFormat('en-AU', { weekday: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' });

/** Day cards; each opens that day's hourly forecast (data-day).  Rebuilt only
 *  when the data or display units change, so a click is never lost. */
export function renderForecast(root, fc) {
  const grid = root.querySelector('.fc-grid');
  root.querySelector('.fc-age').textContent = `Open-Meteo · station lat/lon from weewx.conf · ${fc.ageText()}`;
  if (!fc.data) {
    if (!grid.childElementCount) grid.textContent = fc.error ? 'Forecast unavailable.' : 'Loading forecast…';
    return;
  }
  const key = `${fc.fetchedAt}|${unitPref('temp')}|${unitPref('rain')}|${unitPref('wind')}|${new Date().toDateString()}`;
  if (grid.dataset.key === key) return;
  grid.dataset.key = key;
  const days = [];
  for (let i = 0; i < 7; i++) { const d = fc.day(i); if (d) days.push(d); }
  const lo = Math.min(...days.map((d) => d.min));
  const hi = Math.max(...days.map((d) => d.max));
  const span = (hi - lo) || 1;
  grid.replaceChildren(...days.map((d, i) => {
    const [text, ic] = wmo(d.code);
    const dt = new Date(`${d.date}T12:00:00`);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fc-day';
    el.dataset.day = String(i);
    const rain = Number.isFinite(d.rain) && d.rain >= 0.1 ? fmtUL('rain', d.rain, d.rain < 10 ? 1 : 0) : '—';
    el.innerHTML = `
      <div class="fc-top"><span class="fc-name"></span><span class="fc-date"></span></div>
      <div class="fc-cond">${icon(ic, 40, text)}<span class="fc-desc"></span></div>
      <div class="fc-range">
        <span class="fc-lo num"></span>
        <div class="fc-bar"><div class="fc-fill" style="left:${((d.min - lo) / span * 100).toFixed(1)}%;width:${Math.max(4, (d.max - d.min) / span * 100).toFixed(1)}%"></div></div>
        <span class="fc-hi num"></span>
      </div>
      <div class="fc-rain"><span class="fc-pop"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5C6 1.5 2.5 5.6 2.5 7.6a3.5 3.5 0 0 0 7 0C9.5 5.6 6 1.5 6 1.5z" style="fill:#2F7BD8"/></svg><span></span></span><span class="muted fc-mm"></span></div>
      <div class="muted fc-wind"></div>`;
    el.querySelector('.fc-name').textContent = i === 0 ? 'Today' : dayFmt.format(dt);
    el.querySelector('.fc-date').textContent = dateFmt.format(dt);
    el.querySelector('.fc-desc').textContent = text;
    el.querySelector('.fc-lo').textContent = fmtDeg(d.min, 0);
    el.querySelector('.fc-hi').textContent = fmtDeg(d.max, 0);
    el.querySelector('.fc-pop span').textContent = Number.isFinite(d.pop) ? `${d.pop}%` : '—';
    el.querySelector('.fc-mm').textContent = rain;
    el.querySelector('.fc-wind').textContent = `Wind ${compassPoint(d.dir)} ${fmtUL('wind', d.wind, 0)}`;
    el.setAttribute('aria-label', `${i === 0 ? 'Today' : dayFmt.format(dt)}: ${text}, ${fmtDeg(d.min, 0)} to ${fmtDeg(d.max, 0)}. Show hourly forecast`);
    return el;
  }));
}
