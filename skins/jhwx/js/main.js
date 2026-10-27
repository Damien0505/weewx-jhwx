// Bootstraps the dashboard and owns app state.

import { loadJson, secondsToNextCycle } from './data.js';
import { LiveFeed } from './live.js';
import { initTheme } from './theme.js';
import { Readings, tileDefs, mountTiles } from './tiles.js';
import { TrendBuffer, addPowerTrends } from './trend.js';
import { HistoryDialog } from './history.js';
import { renderHero } from './hero.js';
import { renderSunMoon } from './sunmoon.js';
import { Forecast, renderForecast } from './forecast.js';
import { MapsPanel } from './maps.js';
import { gaugeDefs, mountGauges } from './gauges.js';
import {
  fmt, fmtClock, fmtLongDate, fmtTime, fmtDate, UNIT_GROUPS, UNIT_PRESETS, unitChoices, unitPref, setUnit,
} from './units.js';
import { Layout } from './layout.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  cfg: null,
  live: null,
  readings: null,
  updateTiles: null,
};

function setText(sel, text) {
  const el = $(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

function renderHeader() {
  const now = new Date();
  setText('#clock-time', fmtClock(now));
  setText('#clock-date', fmtLongDate(now));
}

// A sensor is late once nothing from it has arrived for one usual packet
// interval plus this much (network and upload jitter).
const LATE_GRACE_S = 5;

/** Each sensor and the loop fields only it supplies. */
const sensorFields = (cfg) => [
  [cfg.sensors.outdoor, ['outTemp', 'outHumidity', 'windSpeed', 'radiation', 'UV']],
  [cfg.sensors.rain, ['rainRate', 'dayRain']],
  [cfg.sensors.console, ['inTemp', 'inHumidity', 'barometer']],
];

const clock = (ts) => fmtClock(new Date(ts * 1000));

/** Banner: live feed down, or one sensor late (nothing for an interval + 5 s). */
function renderBanner() {
  const L = state.live;
  const banner = $('#live-banner');
  const cur = state.readings.current;
  let msg = '';
  if (!L || L.lastPacket === null) {
    const t = performance.now();
    if (t > 15000 || (L && L.status === 'error')) msg = 'Live feed unavailable';
    else if (t > 5000) msg = 'Waiting for the live feed';
  } else {
    const every = Math.round(L.cadence());
    const limit = L.cadence() + LATE_GRACE_S;
    if ((Date.now() - L.lastPacketRx) / 1000 > limit) {
      msg = `No live data since ${clock(L.lastPacket)} (usually every ${every} s)`;
    } else {
      const late = new Map();                  // last-seen time -> sensor names
      for (const [name, fields] of sensorFields(state.cfg)) {
        const seen = fields.map((f) => L.lastSeen[f]).filter((x) => x !== undefined);
        if (!seen.length) continue;            // a station without this sensor
        const last = Math.max(...seen);
        if (L.lastPacket - last > limit) late.set(last, [...(late.get(last) || []), name]);
      }
      if (late.size) {
        const parts = [...late].map(([t, names]) => `${names.join(' and ')} since ${clock(t)}`);
        msg = `No data from ${parts.join(', ')} (usually every ${every} s)`;
      }
    }
  }
  if (msg && (!L || L.lastPacket === null) && cur && cur.record && cur.record.dateTime) {
    msg += ` · showing the archive record from ${fmtTime(cur.record.dateTime)}`;
  }
  banner.hidden = !msg;
  if (msg) setText('#live-banner-text', msg);
}

function renderFooter() {
  const R = state.readings;
  const L = state.live;
  const cfg = state.cfg;
  const chips = [];
  const v = (f, dp, u) => {
    const r = R.get(f);
    return r.v === null ? null : `${fmt(r.v, dp)} ${u}`;
  };
  const power = cfg.options.power;
  for (const [k, dp] of [['supercap', 1], ['battery', 2]]) {
    const p = power[k];
    const val = p ? v(p.field, dp, 'V') : null;
    if (val) chips.push([p.label, val]);
  }
  if (L && L.lastPacket !== null) chips.push(['Loop interval', `${Math.round(L.cadence())} s`]);
  if (cfg.station.archive_interval_s) chips.push(['Archive interval', `${cfg.station.archive_interval_s / 60} min`]);
  const cur = R.current;
  if (cur && cur.record && cur.record.dateTime) {
    const next = cur.record.dateTime + (cfg.station.archive_interval_s || 300);
    chips.push(['Archive record', `${fmtTime(cur.record.dateTime)} · next ${fmtTime(next)}`]);
  }
  if (cfg.history_start) chips.push(['History since', fmtDate(cfg.history_start)]);
  if (cfg.cutover) chips.push([cfg.station.hardware_short || 'Station', `since ${fmtDate(cfg.cutover)}`]);
  const box = $('#health');
  box.replaceChildren(...chips.map(([k, val]) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.append(`${k} `);
    const b = document.createElement('b');
    b.textContent = val;
    c.append(b);
    return c;
  }));
}

function renderAll() {
  renderHeader();
  renderNow();
  if (state.updateTiles) state.updateTiles(state.readings);
  if (state.updateGauges && !$('#gauges').hidden) state.updateGauges(state.readings);
  if (state.history) state.history.updateHeader();
  renderBanner();
  renderFooter();
}

/** Hero + sun & moon (cloud cover from the live feed if it carries one). */
function renderNow() {
  if (!state.cfg) return;
  const pos = renderSunMoon($('#sunmoon'), state.astro, state.cfg);
  // cloud cover: Open-Meteo current, else the live feed's (DivumWX-injected) value
  const cc = state.readings.get('cloudcover');
  const cloud = state.forecast && state.forecast.cloudCover !== null ? state.forecast.cloudCover : (cc.src ? cc.v : null);
  renderHero($('#hero'), state.readings, state.trends, state.cfg, pos.alt, cloud);
  if (state.forecast) {
    $('#hero .hero-outlook').textContent = state.forecast.outlook();
    renderForecast($('#forecast'), state.forecast);
  }
}

async function refreshAstro() {
  try {
    state.astro = await loadJson('astro');
  } catch (e) {
    console.warn(e);
  }
  setTimeout(refreshAstro, 15 * 60 * 1000);
}

async function refreshCurrent() {
  let wait = 60;
  try {
    const [cur, day] = await Promise.all([
      loadJson('current'),
      loadJson('day').catch((e) => { console.warn(e); return null; }),
    ]);
    state.readings.current = cur;
    if (day) state.trends.seed(day);
    const iv = state.cfg.station.archive_interval_s || 300;
    wait = secondsToNextCycle(cur.record && cur.record.dateTime, iv);
    renderAll();
  } catch (e) {
    console.warn(e);
  }
  setTimeout(refreshCurrent, wait * 1000);
}

/** Tiles / Gauges switch, remembered per browser.  Tiles stay rendered
 *  (hidden) because gauges mirror their trend chips and ages. */
function initView(group) {
  let view = 'tiles';
  try { view = localStorage.getItem('jhwx.view') || 'tiles'; } catch (e) { /* ignore */ }
  const sync = () => {
    $('#tiles').hidden = view === 'gauges';
    $('#gauges').hidden = view !== 'gauges';
    for (const b of group.querySelectorAll('button[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    renderAll();
  };
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    try { localStorage.setItem('jhwx.view', view); } catch (e2) { /* ignore */ }
    sync();
  });
  sync();
}

/** Units pop-over: presets plus one choice per unit group. */
function initUnits(btn, pop) {
  const build = () => {
    pop.replaceChildren();
    const h = document.createElement('div');
    h.className = 'pop-h';
    h.textContent = 'Display units';
    const presets = document.createElement('div');
    presets.className = 'pop-presets';
    for (const [name, p] of Object.entries(UNIT_PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-sec';
      b.textContent = name;
      b.setAttribute('aria-pressed', String(Object.entries(p).every(([g, k]) => unitPref(g) === k)));
      b.addEventListener('click', () => { for (const [g, k] of Object.entries(p)) setUnit(g, k); });
      presets.append(b);
    }
    pop.append(h, presets);
    for (const [g, label] of UNIT_GROUPS) {
      const row = document.createElement('div');
      row.className = 'pop-row';
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = label;
      const seg = document.createElement('div');
      seg.className = 'seg seg-inset';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', label);
      for (const [k, text] of unitChoices(g)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.setAttribute('aria-pressed', String(unitPref(g) === k));
        b.addEventListener('click', () => setUnit(g, k));
        seg.append(b);
      }
      row.append(l, seg);
      pop.append(row);
    }
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = 'Saved in this browser. Pressure-chart isobars stay in hPa.';
    pop.append(note);
  };
  const open = (on) => {
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) build();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); open(pop.hidden); });
  // clicks inside stay inside (the content is rebuilt on every choice)
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { open(false); btn.focus(); } });
  document.addEventListener('jhwx-units', () => { if (!pop.hidden) build(); });
}

/** Edit mode: Edit button / edit bar, and no pop-ups while arranging. */
function initEdit(layout) {
  const btn = $('#edit-btn');
  const bar = $('#edit-bar');
  const set = (on) => {
    layout.setEditing(on);
    btn.setAttribute('aria-pressed', String(on));
    bar.hidden = !on;
  };
  btn.addEventListener('click', () => set(!layout.editing));
  $('#edit-done').addEventListener('click', () => set(false));
  $('#edit-reset').addEventListener('click', () => layout.reset());
  // tiles and gauges open history on click: not while editing
  document.addEventListener('click', (e) => {
    if (layout.editing && e.target.closest('.tile') && !e.target.closest('.edit-ctl')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  layout.addEventListener('change', () => {
    if (state.maps && state.maps.map) setTimeout(() => state.maps.map.invalidateSize(), 50);
  });
}

const labelItems = (container, sel) => {
  for (const c of container.children) {
    const t = c.querySelector(sel);
    if (t) c.dataset.editLabel = t.textContent;
  }
};

function mountGaugeView() {
  const box = $('#gauges');
  box.replaceChildren();
  state.updateGauges = mountGauges(box, gaugeDefs(state.cfg), (id) => state.history.open(id));
  labelItems(box, '.g-title');
}

function brokerUrl(cfg) {
  // ?mqtt=wss://host/path overrides the configured broker (local previews).
  const override = new URLSearchParams(window.location.search).get('mqtt');
  return override || cfg.mqtt.url;
}

async function main() {
  initTheme($('#theme-seg'));
  renderHeader();
  setInterval(renderHeader, 1000);

  try {
    state.cfg = await loadJson('config');
  } catch (e) {
    $('#live-banner').hidden = false;
    setText('#live-banner-text', `Cannot load station configuration: ${e.message}`);
    return;
  }
  const cfg = state.cfg;
  // older config.json without install options: everything optional off
  cfg.options = cfg.options || { power: {}, fire: { enabled: false }, mslp: { enabled: true } };
  addPowerTrends(cfg.options.power);
  if (cfg.options.lightning && cfg.options.lightning.enabled) $('.credit-lightning').hidden = false;
  setText('#station-name', cfg.station.location);
  setText('#station-sub', cfg.station.subtitle || '');
  document.title = `${cfg.station.location} weather`;

  state.live = new LiveFeed(brokerUrl(cfg), cfg.mqtt.topic);
  state.trends = new TrendBuffer();
  state.readings = new Readings(state.live, state.trends);
  state.history = new HistoryDialog(cfg, (id) => {
    const t = document.querySelector(`.tile[data-tile="${id}"]`);
    const q = (s) => (t ? t.querySelector(s).textContent : '');
    return {
      src: t ? t.dataset.sensor : '',
      now: `${q('.v')} ${q('.u')}`.trim(),
      trendText: q('.trend'),
      trendDir: t ? t.querySelector('.trend').dataset.dir : 'steady',
    };
  });
  state.updateTiles = mountTiles($('#tiles'), tileDefs(cfg), (id) => state.history.open(id));
  $('#noaa-btn').addEventListener('click', () => state.history.open('temp', { noaa: true }));
  if (cfg.options.fire.enabled) $('#hero .hero-fire').addEventListener('click', () => state.history.open('fire'));
  mountGaugeView();
  labelItems($('#tiles'), '.tile-label');
  initView($('#view-seg'));

  const layout = new Layout();
  state.layout = layout;
  layout.register('sections', $('#sections'), 'data-section');
  layout.register('now', $('#now-row'), 'data-section');
  layout.register('tiles', $('#tiles'), 'data-tile');
  layout.register('gauges', $('#gauges'), 'data-gauge');
  initEdit(layout);
  initUnits($('#units-btn'), $('#units-pop'));
  document.addEventListener('jhwx-units', () => {
    mountGaugeView();          // scales depend on the units
    layout.apply('gauges');
    renderAll();
    if (state.history.isOpen) state.history.render();
    if (state.maps) state.maps.renderSide();
  });

  state.live.addEventListener('packet', (e) => {
    state.trends.push(e.detail.ts, e.detail.fields);
    renderAll();
    if (state.maps) state.maps.liveUpdate();
  });
  state.live.addEventListener('status', renderAll);
  state.live.start();

  state.forecast = new Forecast(cfg.station.latitude, cfg.station.longitude);
  state.forecast.addEventListener('update', renderAll);
  state.forecast.start();
  state.readings.forecast = state.forecast;

  state.maps = new MapsPanel($('#maps'), cfg, state.readings);
  state.maps.start();

  await Promise.all([refreshCurrent(), refreshAstro()]);
  setInterval(renderAll, 1000);
}

main();
