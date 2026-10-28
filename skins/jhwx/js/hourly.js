// Hourly forecast pop-up (Open-Meteo, from the same request as the 7-day
// forecast): one day at a time, with tabs for the other days.  A strip of
// hour columns - conditions, a temperature line (feels-like dashed), chance
// and amount of rain, wind and gusts, UV by day - scrolls sideways on its own.

import { fmt, compassPoint, fmtU, fmtUL, fmtDeg, conv } from './units.js';
import { icon } from './icons.js';
import { wmo } from './forecast.js';

const COL = 58;          // px per hour column
const T_H = 104;         // temperature chart height (px)
const T_PAD = 22;        // room above/below the line for labels

const dayShort = new Intl.DateTimeFormat('en-AU', { weekday: 'short' });
const dayLong = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

/** Icon for an hour: night versions of clear / partly cloudy. */
function hourIcon(code, isDay) {
  const [text, ic] = wmo(code);
  if (!isDay && ic === 'sunny') return ['Clear', 'clearnight'];
  if (!isDay && ic === 'partly') return [text, 'partlynight'];
  return [text, ic];
}

/** '3 pm', '12 am' from 'YYYY-MM-DDTHH:MM' (station local time); a midnight
 *  part-way along the strip shows the new day's name instead. */
function hourLabel(t, first = true) {
  const h = Number(t.slice(11, 13));
  if (h === 0 && !first) return dayShort.format(new Date(`${t.slice(0, 10)}T12:00:00`));
  return `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class HourlyDialog {
  constructor(forecast) {
    this.fc = forecast;
    this.dayIndex = 0;
    this._build();
    forecast.addEventListener('update', () => { if (this.isOpen) this.render(); });
  }

  _build() {
    const ov = el('div', 'overlay');
    ov.hidden = true;
    ov.innerHTML = `
<div class="dlg hr-dlg" role="dialog" aria-modal="true" aria-labelledby="hr-h">
  <div class="dlg-head">
    <div style="min-width:0">
      <div class="dlg-kicker">Hourly forecast · Open-Meteo</div>
      <h2 id="hr-h"></h2>
      <div class="hr-sum muted"></div>
    </div>
    <div class="dlg-ctl">
      <div class="seg seg-inset hr-days" role="tablist" aria-label="Day"></div>
      <button type="button" class="icon-btn dlg-close" aria-label="Close hourly forecast">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14"/></svg>
      </button>
    </div>
  </div>
  <div class="hr-body">
    <div class="hr-wrap">
      <div class="hr-labels muted" aria-hidden="true">
        <span class="hr-l-time"></span><span class="hr-l-icon"></span>
        <span class="hr-l-temp">Temp</span>
        <span class="hr-l-pop">Rain</span><span class="hr-l-wind">Wind</span><span class="hr-l-gust">Gust</span>
        <span class="hr-l-uv">UV</span>
      </div>
      <div class="hr-scroll" tabindex="0" aria-label="Hour by hour, scroll sideways"><div class="hr-inner"></div></div>
    </div>
    <div class="hr-key muted"><span><i class="hr-sw"></i>Temperature</span><span><i class="hr-sw hr-sw-feel"></i>Feels like</span><span><i class="hr-sw hr-sw-bar"></i>Chance of rain, with mm</span><span>Wind arrows point downwind</span></div>
    <p class="hr-note muted small"></p>
  </div>
</div>`;
    document.body.append(ov);
    this.ov = ov;
    this.dlg = ov.querySelector('.dlg');
    ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
    ov.querySelector('.dlg-close').addEventListener('click', () => this.close());
    ov.querySelector('.hr-days').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-day]');
      if (b) { this.dayIndex = Number(b.dataset.day); this.render(); }
    });
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
    const f = [...this.dlg.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  open(dayIndex = 0) {
    this.dayIndex = dayIndex;
    this.returnFocus = document.activeElement;
    this.ov.hidden = false;
    document.body.classList.add('modal-open');
    if (!this.pushed) {
      try { window.history.pushState({ jhwxDialog: true }, ''); this.pushed = true; } catch (e) { /* ignore */ }
    }
    this.render();
    this.ov.querySelector('.dlg-close').focus();
  }

  close() {
    this.ov.hidden = true;
    document.body.classList.remove('modal-open');
    if (this.pushed) { this.pushed = false; window.history.back(); }
    if (this.returnFocus && this.returnFocus.focus) this.returnFocus.focus();
  }

  get isOpen() { return !this.ov.hidden; }

  render() {
    const q = (s) => this.ov.querySelector(s);
    const fc = this.fc;
    const days = [];
    for (let i = 0; i < 7; i++) { const d = fc.day(i); if (d) days.push(d); }
    q('.hr-days').replaceChildren(...days.map((d, i) => {
      const b = el('button', '', i === 0 ? 'Today' : dayShort.format(new Date(`${d.date}T12:00:00`)));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.day = String(i);
      b.setAttribute('aria-selected', String(i === this.dayIndex));
      return b;
    }));
    const day = fc.day(this.dayIndex);
    const hours = fc.hours(this.dayIndex);
    q('#hr-h').textContent = day
      ? `${this.dayIndex === 0 ? 'Today, ' : ''}${dayLong.format(new Date(`${day.date}T12:00:00`))}` : 'Hourly forecast';
    q('.hr-sum').textContent = day ? this._summary(day) : '';
    q('.hr-note').textContent = `Open-Meteo (CC BY 4.0) for the station's position · ${fc.ageText()}`
      + (this.dayIndex === 0 ? ' · Today starts at the current hour' : '');
    const inner = q('.hr-inner');
    if (!hours.length) {
      inner.replaceChildren(el('p', 'muted', fc.error ? 'Forecast unavailable.' : 'Loading forecast…'));
      return;
    }
    this._strip(inner, hours);
    q('.hr-scroll').scrollLeft = 0;
  }

  _summary(d) {
    const parts = [wmo(d.code)[0], `${fmtDeg(d.min, 0)} to ${fmtDeg(d.max, 0)}`];
    if (Number.isFinite(d.pop)) parts.push(`${d.pop}% chance of rain`);
    if (Number.isFinite(d.rain) && d.rain >= 0.1) parts.push(fmtUL('rain', d.rain, 1));
    if (Number.isFinite(d.wind)) parts.push(`wind ${compassPoint(d.dir)} up to ${fmtUL('wind', d.wind, 0)}`);
    return parts.join(' · ');
  }

  _strip(inner, hours) {
    const n = hours.length;
    const anyUv = hours.some((h) => h.isDay && Number.isFinite(h.uv) && h.uv >= 0.5);
    this.ov.querySelector('.hr-l-uv').hidden = !anyUv;
    inner.style.width = `${n * COL}px`;
    const row = (cls, make) => {
      const r = el('div', `hr-row ${cls}`);
      hours.forEach((h, i) => r.append(make(h, i)));
      return r;
    };
    const time = row('hr-time', (h, i) => el('span', h.now ? 'hr-now' : i && h.time.slice(11, 13) === '00' ? 'hr-midnight' : '',
      h.now ? 'Now' : hourLabel(h.time, i === 0)));
    const icons = row('hr-icon', (h) => {
      const [text, ic] = hourIcon(h.code, h.isDay);
      const c = el('span');
      c.innerHTML = icon(ic, 30, text);
      c.title = text;
      return c;
    });
    const pop = row('hr-pop', (h) => {
      const c = el('span');
      const p = Number.isFinite(h.pop) ? h.pop : 0;
      const bar = el('i', 'hr-bar');
      bar.style.height = `${Math.round(p * 0.34)}px`;
      const txt = el('span', 'hr-pop-t', Number.isFinite(h.pop) ? `${h.pop}%` : '—');
      const mm = el('span', 'hr-mm', Number.isFinite(h.rain) && h.rain >= 0.1 ? fmtU('rain', h.rain, 1) : '');
      c.append(bar, txt, mm);
      return c;
    });
    const wind = row('hr-wind', (h) => {
      const c = el('span');
      c.title = `${compassPoint(h.dir)} ${fmtUL('wind', h.wind, 0)}`;
      if (Number.isFinite(h.dir)) {
        // the arrow (drawn pointing down, i.e. a northerly) points where the wind blows to
        c.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="transform:rotate(${h.dir}deg)"><path d="M7 1.5v11M3.5 9L7 12.5 10.5 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      }
      c.append(el('span', 'num', fmtU('wind', h.wind, 0)));
      return c;
    });
    const gust = row('hr-gust', (h) => el('span', 'num muted', fmtU('wind', h.gust, 0)));
    const parts = [time, icons, this._tempChart(hours), pop, wind, gust];
    if (anyUv) parts.push(row('hr-uv', (h) => el('span', 'num', h.isDay && Number.isFinite(h.uv) && h.uv >= 0.5 ? fmt(h.uv, 0) : '')));
    inner.replaceChildren(...parts);
    inner.setAttribute('aria-label', hours.map((h, i) => `${h.now ? 'Now' : hourLabel(h.time, i === 0)}: ${wmo(h.code)[0]}, `
      + `${fmtDeg(h.temp, 0)}, ${Number.isFinite(h.pop) ? `${h.pop}% rain, ` : ''}wind ${compassPoint(h.dir)} ${fmtUL('wind', h.wind, 0)}`).join('; '));
  }

  /** Temperature line through the column centres, feels-like dashed. */
  _tempChart(hours) {
    const n = hours.length;
    const t = hours.map((h) => conv('temp', h.temp));
    const f = hours.map((h) => conv('temp', h.feel));
    const all = [...t, ...f].filter(Number.isFinite);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = (hi - lo) || 1;
    const x = (i) => i * COL + COL / 2;
    const y = (v) => T_PAD + (1 - (v - lo) / span) * (T_H - 2 * T_PAD);
    const path = (vals) => vals.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(vals[i - 1]) ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}` : '')).join(' ');
    const svgNS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('class', 'hr-temp');
    s.setAttribute('width', String(n * COL));
    s.setAttribute('height', String(T_H));
    s.setAttribute('aria-hidden', 'true');
    const dots = t.map((v, i) => (Number.isFinite(v)
      ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"/>`
        + `<text x="${x(i).toFixed(1)}" y="${(y(v) - 8).toFixed(1)}">${fmt(v, 0)}°</text>` : '')).join('');
    s.innerHTML = `<path class="hr-feel" d="${path(f)}"/><path class="hr-line" d="${path(t)}"/><g class="hr-dots">${dots}</g>`;
    return s;
  }
}

