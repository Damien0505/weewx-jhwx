// Heatmaps pop-up (header button): a year x month table per reading - lowest,
// mean and highest temperature, rainfall, rain days and strongest gust - each
// cell coloured by its value, with a Year column and all-years rows below.
// Data: data/heatmap.json (daily summaries, refreshed hourly by WeeWX).

import { loadJson } from './data.js';
import { fmt, conv, unitLabel, unitDp } from './units.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const RELOAD_MS = 30 * 60 * 1000;

// Colour stops in metric units (the cell colour doesn't change with the
// display unit, so a hot month is the same red in °C and °F).
const TEMP = [[-5, '#2C5FD6'], [0, '#3FA0E8'], [5, '#5CC6D8'], [10, '#7CCB8A'], [15, '#C6DB6A'],
  [20, '#F2C94C'], [25, '#F29A3C'], [30, '#E2552D'], [35, '#B5202A'], [40, '#7A0F2E']];
const RAIN = [[0, '#EEF5FA'], [25, '#C4DDF0'], [50, '#8FBFE5'], [100, '#4D93D1'], [150, '#2366B3'], [250, '#163F7E']];
const DAYS = [[0, '#EEF5FA'], [5, '#C4DDF0'], [10, '#8FBFE5'], [15, '#4D93D1'], [20, '#2366B3'], [25, '#163F7E']];
const GUST = [[20, '#DCEFD6'], [40, '#9ED38C'], [60, '#F2C94C'], [80, '#F29A3C'], [100, '#E2552D'], [120, '#B5202A']];

// yearScale: Year-column values are put on the monthly scale (totals / 12)
const MAPS = [
  { key: 't_min', tab: 'Min temp', title: 'Lowest temperature', group: 'temp', dp: 1, stops: TEMP,
    note: 'The coldest reading in each month and year.' },
  { key: 't_avg', tab: 'Mean temp', title: 'Mean temperature', group: 'temp', dp: 1, stops: TEMP,
    note: 'The average of every reading in each month and year.' },
  { key: 't_max', tab: 'Max temp', title: 'Highest temperature', group: 'temp', dp: 1, stops: TEMP,
    note: 'The hottest reading in each month and year.' },
  { key: 'rain', tab: 'Rainfall', title: 'Rainfall', group: 'rain', dp: 0, stops: RAIN, yearScale: 12,
    note: 'Total rain in each month and year.' },
  { key: 'rain_days', tab: 'Rain days', title: 'Rain days', dp: 0, stops: DAYS, yearScale: 12,
    note: 'Days with at least 0.2 mm of rain.' },
  { key: 'gust', tab: 'Max gust', title: 'Strongest gust', group: 'wind', dp: 0, stops: GUST,
    note: 'The strongest gust in each month and year.' },
];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Interpolated colour for a metric value on a list of [value, '#rrggbb'] stops. */
function colourFor(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return last[1];
  const i = stops.findIndex((s) => s[0] > v);
  const [v0, c0] = stops[i - 1];
  const [v1, c1] = stops[i];
  const f = (v - v0) / (v1 - v0);
  const a = hex(c0);
  const b = hex(c1);
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`;
}

/** Dark or light text, whichever reads better on the cell colour. */
function inkFor(colour) {
  const rgb = colour.startsWith('#') ? hex(colour) : colour.slice(4, -1).split(',').map(Number);
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? '#12202C' : '#FFFFFF';
}

export class HeatmapDialog {
  constructor() {
    this.key = 't_max';
    this.data = null;
    this.loadedAt = 0;
    this.error = null;
    this._build();
    document.addEventListener('jhwx-units', () => { if (this.isOpen) this.render(); });
  }

  _build() {
    const ov = el('div', 'overlay');
    ov.hidden = true;
    ov.innerHTML = `
<div class="dlg hm-dlg" role="dialog" aria-modal="true" aria-labelledby="hm-h">
  <div class="dlg-head">
    <div style="min-width:0">
      <div class="dlg-kicker">Heatmaps · monthly climate</div>
      <h2 id="hm-h">Heatmaps</h2>
      <div class="hm-sub muted"></div>
    </div>
    <div class="dlg-ctl">
      <button type="button" class="icon-btn dlg-close" aria-label="Close heatmaps">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14"/></svg>
      </button>
    </div>
  </div>
  <div class="hm-body">
    <div class="seg seg-inset hm-tabs" role="tablist" aria-label="Reading"></div>
    <div class="hm-scroll" tabindex="0"><table class="hm-table"></table></div>
    <div class="hm-legend muted"></div>
    <p class="hm-note muted small"></p>
  </div>
</div>`;
    document.body.append(ov);
    this.ov = ov;
    this.dlg = ov.querySelector('.dlg');
    ov.querySelector('.hm-tabs').replaceChildren(...MAPS.map((m) => {
      const b = el('button', '', m.tab);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.key = m.key;
      return b;
    }));
    ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
    ov.querySelector('.dlg-close').addEventListener('click', () => this.close());
    ov.querySelector('.hm-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (b) { this.key = b.dataset.key; this.render(); }
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

  async open() {
    this.returnFocus = document.activeElement;
    this.ov.hidden = false;
    document.body.classList.add('modal-open');
    if (!this.pushed) {
      try { window.history.pushState({ jhwxDialog: true }, ''); this.pushed = true; } catch (e) { /* ignore */ }
    }
    this.render();
    this.ov.querySelector('.dlg-close').focus();
    if (!this.data || Date.now() - this.loadedAt > RELOAD_MS) {
      try {
        const d = await loadJson('heatmap');
        if (!d.grid || !d.grid.years) throw new Error('no data yet');
        this.data = d;
        this.loadedAt = Date.now();
        this.error = null;
      } catch (e) {
        console.warn(e);
        this.error = e.message || String(e);
      }
      if (this.isOpen) this.render();
    }
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
    const map = MAPS.find((m) => m.key === this.key) || MAPS[0];
    for (const b of q('.hm-tabs').children) b.setAttribute('aria-selected', String(b.dataset.key === map.key));
    const unit = map.group ? unitLabel(map.group) : 'days';
    q('#hm-h').textContent = map.title;
    const table = q('.hm-table');
    const g = this.data && this.data.grid;
    if (!g) {
      q('.hm-sub').textContent = '';
      q('.hm-legend').replaceChildren();
      q('.hm-note').textContent = '';
      table.replaceChildren(el('caption', 'muted', this.error ? `Heatmaps unavailable (${this.error}).` : 'Loading…'));
      return;
    }
    const first = new Date(g.first * 1000);
    q('.hm-sub').textContent = `${unit} · ${map.note}`;
    q('.dlg-kicker').textContent = `Heatmaps · since ${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}`;
    const grid = g[map.key];
    const dp = map.group ? unitDp(map.group, map.dp) : 0;
    const show = (v) => (map.group ? conv(map.group, v) : v);
    const now = new Date();
    // months (and years) with under half their days recorded are faded and,
    // like the month and year in progress, left out of the all-years rows
    const days = g.days || { m: g.years.map(() => new Array(12).fill(null)), y: g.years.map(() => null) };
    const isNow = (y, mi) => y === now.getFullYear() && (mi === undefined || mi === now.getMonth());
    const sparseM = (yi, mi) => {
      const n = days.m[yi][mi];
      return n !== null && n < new Date(g.years[yi], mi + 1, 0).getDate() / 2;
    };
    const sparseY = (yi) => days.y[yi] !== null && days.y[yi] < 183;
    const cell = (v, scaleBy, title, cls = '', n = null) => {
      const td = el('td', `hm-c ${cls}`.trim());
      if (v === null || v === undefined) {
        td.classList.add('hm-none');
        td.textContent = '–';
        return td;
      }
      const bg = colourFor(map.stops, v / (scaleBy || 1));
      td.style.background = bg;
      td.style.color = inkFor(bg);
      td.textContent = fmt(show(v), dp);
      td.title = `${title}: ${fmt(show(v), dp)} ${unit}${n !== null ? ` (${n} day${n === 1 ? '' : 's'} recorded)` : ''}`;
      return td;
    };

    const head = el('tr');
    head.append(el('th', 'hm-corner', unit), ...MONTHS.map((m) => el('th', '', m)), el('th', 'hm-ycol', 'Year'));
    const thead = el('thead');
    thead.append(head);

    const tbody = el('tbody');
    g.years.forEach((y, yi) => {
      const tr = el('tr');
      tr.append(el('th', 'hm-year', String(y)));
      grid.m[yi].forEach((v, mi) => {
        const cur = isNow(y, mi);
        const cls = cur ? 'hm-cur' : sparseM(yi, mi) ? 'hm-part' : '';
        tr.append(cell(v, 1, `${MONTHS_LONG[mi]} ${y}${cur ? ' (so far)' : ''}`, cls, days.m[yi][mi]));
      });
      const ycls = `hm-ycol${!isNow(y) && sparseY(yi) ? ' hm-part' : ''}`;
      tr.append(cell(grid.y[yi], map.yearScale, `${y}${isNow(y) ? ' (so far)' : ''}`, ycls, days.y[yi]));
      tbody.append(tr);
    });

    // all-years rows: lowest, mean and highest of each column, from complete
    // enough months and years only
    const tfoot = el('tfoot');
    const gap = el('tr', 'hm-gap');
    const gapTd = el('td');
    gapTd.colSpan = 14;
    gap.setAttribute('aria-hidden', 'true');
    gap.append(gapTd);
    tfoot.append(gap);
    const col = (mi) => (mi < 12
      ? grid.m.map((r, yi) => (isNow(g.years[yi], mi) || sparseM(yi, mi) ? null : r[mi]))
      : grid.y.map((v, yi) => (isNow(g.years[yi]) || sparseY(yi) ? null : v)))
      .filter((v) => v !== null && v !== undefined);
    for (const [label, fn] of [
      ['Lowest', (a) => Math.min(...a)],
      ['Mean', (a) => a.reduce((s, x) => s + x, 0) / a.length],
      ['Highest', (a) => Math.max(...a)],
    ]) {
      const tr = el('tr');
      tr.append(el('th', 'hm-year', label));
      for (let mi = 0; mi <= 12; mi++) {
        const a = col(mi);
        const v = a.length ? fn(a) : null;
        const name = mi < 12 ? MONTHS_LONG[mi] : 'Year';
        tr.append(cell(v, mi < 12 ? 1 : map.yearScale, `${label} ${name}, all years`, mi < 12 ? '' : 'hm-ycol'));
      }
      tfoot.append(tr);
    }
    table.replaceChildren(thead, tbody, tfoot);

    // legend: the colour stops, in display units
    q('.hm-legend').replaceChildren(...map.stops.map(([v, c]) => {
      const s = el('span', 'hm-key');
      const sw = el('i');
      sw.style.background = c;
      s.append(sw, fmt(show(v), map.group ? unitDp(map.group, 0) : 0));
      return s;
    }));
    q('.hm-note').textContent = 'Outlined: the month so far. Faded: less than half the month (or year) '
      + 'recorded. Neither counts in the Lowest / Mean / Highest rows.'
      + `${map.yearScale ? ' Year cells are coloured by their monthly average.' : ''}`
      + ' Built hourly from the station’s daily records.';
  }
}
