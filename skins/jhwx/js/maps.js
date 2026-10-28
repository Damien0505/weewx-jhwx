// Maps panel: Rain radar (RainViewer) / Pressure / Lightning (Xweather, via
// data/lightning.json) / Earthquakes (EMSC), on one
// Leaflet map with a side panel.  Each external source reports its own age
// and error state.

import { fmt, fmtTime, fmtDate, fmtAge, compassPoint, fmtUL } from './units.js';

// distances/speeds in the viewer's units, rounded for a map read-out
const dist = (km, step = 1) => fmtUL('distance', Math.round(km / step) * step, 0);
import { analyseRadar } from './radarstats.js';
import { isobars, ISOBAR_HPA } from './mslp.js';
import { loadJson } from './data.js';

const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_REFRESH_MS = 10 * 60 * 1000;
const RADAR_FRAMES = 7;            // -60 min ... now at 10-min steps
const RADAR_STEP_MS = 700;
const RADAR_MAX_ZOOM = 7;          // RainViewer free tier
const RADAR_COLOUR = 2;            // "Universal Blue"
const EMSC = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const QUAKE_REFRESH_MS = 10 * 60 * 1000;
// viewer-chosen look-back and ranges (remembered in this browser)
const QUAKE_DAYS = [1, 7, 30, 90];
const QUAKE_FAR_KM = [1000, 2000, 3000, 5000, 10000];   // M4+
const QUAKE_NEAR_KM = [0, 100, 200, 300, 500, 1000];    // M2+ (0 = off)
const QUAKE_DEFAULT = { days: 30, far: 5000, near: 300 };
const QUAKE_STORE = 'jhwx.quakes';
const QUAKE_LIMIT = 4000;          // per request; 90 days of M4+ within 10,000 km is ~3,000
const QUAKE_LIST_MAX = 100;
const KM_PER_DEG = 111.195;
// QuakeML event types EMSC uses
const QUAKE_TYPES = {
  ke: 'Earthquake', se: 'Suspected earthquake', ki: 'Induced earthquake', si: 'Suspected induced earthquake',
  kr: 'Rockburst', sr: 'Suspected rockburst', qb: 'Quarry blast', sqb: 'Suspected quarry blast',
  ex: 'Explosion', sex: 'Suspected explosion', km: 'Mining-induced', sm: 'Suspected mining-induced',
};
const LIGHTNING_REFRESH_MS = 2 * 60 * 1000;   // re-read data/lightning.json (WeeWX checks every 10-30 min)
const TIMEOUT_MS = 15000;

// OpenStreetMap standard tiles (tile usage policy: attribution, light use).
// Dark theme darkens the base layer with a CSS filter (.basemap in app.css).
const BASEMAP = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const BASEMAP_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const R_EARTH = 6371;
const rad = (d) => d * Math.PI / 180;

/** Great-circle distance (km) and initial bearing (deg) from a to b. */
export function distBearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const dist = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { dist, bearing: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : (e.message || String(e)));
  } finally {
    clearTimeout(timer);
  }
}

export class MapsPanel {
  constructor(root, cfg, readings) {
    this.root = root;
    this.cfg = cfg;
    this.readings = readings;
    this.lat = cfg.station.latitude;
    this.lon = cfg.station.longitude;
    this.tab = 'radar';
    this.radar = { frames: [], layers: [], index: 0, playing: true, fetchedAt: null, error: null, stats: null, statsError: null };
    this.quakes = { events: [], fetchedAt: null, error: null, prefs: this.quakePrefs(), seq: 0, timer: null,
      markers: new Map(), sel: null, hl: null, truncated: false };
    this.mslp = { data: null, step: null, error: null, loadedAt: 0, chart: null };
    this.ltg = { data: null, error: null };
  }

  start() {
    if (typeof L === 'undefined') {
      this.root.querySelector('.map-side').textContent = 'Map library failed to load.';
      return;
    }
    const map = L.map(this.root.querySelector('.map'), {
      center: [this.lat, this.lon], zoom: RADAR_MAX_ZOOM, zoomControl: true,
      attributionControl: true, worldCopyJump: true,
      zoomSnap: 0,          // the pressure chart frames its grid exactly (+/- buttons still step 1)
    });
    this.map = map;
    this.base = L.tileLayer(BASEMAP, { maxZoom: 12, className: 'basemap', attribution: BASEMAP_ATTRIB }).addTo(map);
    this.stationMarker = L.circleMarker([this.lat, this.lon], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: '#D9382A', fillOpacity: 1,
    }).bindTooltip(this.cfg.station.location).addTo(map);
    this.overlay = L.layerGroup().addTo(map);
    this.quakeRenderer = L.canvas({ padding: 0.5 });   // thousands of dots stay quick
    this.rings = L.layerGroup().addTo(map);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (this.tab === 'mslp') this.mslpView(); }, 200);
    });
    this.root.querySelector('.map-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b) this.show(b.dataset.tab);
    });
    this.root.querySelector('.rad-play').addEventListener('click', () => {
      this.radar.playing = !this.radar.playing;
      this.renderRadarControls();
    });
    this.root.querySelector('.rad-chips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-frame]');
      if (!b) return;
      this.radar.playing = false;
      this.setFrame(Number(b.dataset.frame));
      this.renderRadarControls();
    });
    this.root.querySelector('.mslp-chips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-step]');
      if (!b) return;
      this.mslp.step = Number(b.dataset.step);
      this.drawMslp();
    });
    this.quakeControls();
    document.addEventListener('jhwx-units', () => this.quakeControls());   // range labels follow the distance unit
    map.on('moveend', () => { if (this.tab === 'quakes') this.renderQuakeList(); });
    this.loadRadar();
    this.loadQuakes();
    this.loadLightning();
    setInterval(() => {
      if (this.tab === 'radar' && this.radar.playing && this.radar.layers.length) {
        this.setFrame((this.radar.index + 1) % this.radar.layers.length);
        this.renderRadarControls();
      }
    }, RADAR_STEP_MS);
    // Leaflet needs a size recalculation once the section is laid out
    setTimeout(() => map.invalidateSize(), 200);
    this.show('radar');
  }

  show(tab) {
    this.tab = tab;
    for (const b of this.root.querySelectorAll('.map-tabs button')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
    for (const p of this.root.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== tab;
    this.rings.clearLayers();
    this.overlay.clearLayers();
    for (const l of this.radar.layers) if (this.map.hasLayer(l)) this.map.removeLayer(l);
    if (tab !== 'mslp') this.mapHeight('');
    if (tab === 'radar') {
      for (const l of this.radar.layers) l.addTo(this.map);
      this.setFrame(this.radar.index);
      this.drawNearestEcho();
      this.map.setView([this.lat, this.lon], Math.round(Math.min(this.map.getZoom(), RADAR_MAX_ZOOM)) || RADAR_MAX_ZOOM);
    } else if (tab === 'mslp') {
      this.mslpView();
      this.loadMslp();
    } else if (tab === 'quakes') {
      this.quakeRings();
      this.drawQuakes();
      this.quakeView();
    } else {
      this.drawRings([25, 50, 100]);
      this.drawLightning();
      this.map.setView([this.lat, this.lon], 8);
    }
    this.renderSide();
  }

  drawRings(kms, label = (km) => dist(km)) {
    const col = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
    for (const km of kms) {
      L.circle([this.lat, this.lon], { radius: km * 1000, color: col, weight: 1, fill: false, dashArray: '4 6' })
        .bindTooltip(label(km), { permanent: false }).addTo(this.rings);
    }
  }

  // ------------------------------------------------------------- radar
  async loadRadar() {
    try {
      const idx = await getJson(RADAR_INDEX);
      const past = (idx.radar && idx.radar.past) || [];
      const frames = past.slice(-RADAR_FRAMES);
      const same = frames.length === this.radar.frames.length
        && frames.every((f, i) => f.path === this.radar.frames[i].path);
      if (!same) {
        for (const l of this.radar.layers) if (this.map.hasLayer(l)) this.map.removeLayer(l);
        this.radar.frames = frames;
        this.radar.layers = frames.map((f) => L.tileLayer(
          `${idx.host}${f.path}/256/{z}/{x}/{y}/${RADAR_COLOUR}/1_1.png`,
          { opacity: 0, maxNativeZoom: RADAR_MAX_ZOOM, maxZoom: 12, zIndex: 10,
            attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>' },
        ));
        this.radar.index = frames.length - 1;
        if (this.tab === 'radar') {
          for (const l of this.radar.layers) l.addTo(this.map);
          this.setFrame(this.radar.index);
        }
        if (frames.length) this.analyseRadar(idx.host, frames);
      }
      this.radar.fetchedAt = Date.now();
      this.radar.error = null;
    } catch (e) {
      this.radar.error = `RainViewer ${e.message}`;
    }
    this.renderRadarControls();
    this.renderSide();
    setTimeout(() => this.loadRadar(), RADAR_REFRESH_MS);
  }

  async analyseRadar(host, frames) {
    try {
      this.radar.stats = await analyseRadar(host, frames, this.lat, this.lon);
      this.radar.statsError = null;
    } catch (e) {
      console.warn(e);
      this.radar.statsError = `radar analysis ${e.message || e}`;
    }
    if (this.tab === 'radar') { this.overlay.clearLayers(); this.drawNearestEcho(); }
    this.renderSide();
  }

  drawNearestEcho() {
    const n = this.radar.stats && this.radar.stats.nearest;
    if (!n || this.radar.stats.atStation) return;
    L.polyline([[this.lat, this.lon], [n.lat, n.lon]], { color: '#D9382A', weight: 1.5, dashArray: '4 5', interactive: false })
      .addTo(this.overlay);
    L.circleMarker([n.lat, n.lon], { radius: 6, color: '#D9382A', weight: 2, fill: false })
      .bindTooltip(`Nearest echo · ${dist(n.dist)} ${compassPoint(n.bearing)}`).addTo(this.overlay);
  }

  setFrame(i) {
    const n = this.radar.layers.length;
    if (!n) return;
    this.radar.index = Math.max(0, Math.min(n - 1, i));
    this.radar.layers.forEach((l, k) => l.setOpacity(k === this.radar.index ? 0.75 : 0));
  }

  renderRadarControls() {
    const r = this.radar;
    const play = this.root.querySelector('.rad-play');
    play.setAttribute('aria-pressed', String(r.playing));
    play.querySelector('.lbl').textContent = r.playing ? 'Pause' : 'Play';
    play.querySelector('.ic-play').style.display = r.playing ? 'none' : '';
    play.querySelector('.ic-pause').style.display = r.playing ? '' : 'none';
    const chips = this.root.querySelector('.rad-chips');
    if (chips.childElementCount !== r.frames.length) {
      chips.replaceChildren(...r.frames.map((f, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.frame = String(i);
        return b;
      }));
    }
    const last = r.frames.length ? r.frames[r.frames.length - 1].time : 0;
    r.frames.forEach((f, i) => {
      const b = chips.children[i];
      const mins = Math.round((last - f.time) / 60);
      b.textContent = mins ? `−${mins}` : 'Now';
      b.title = fmtTime(f.time);
      b.setAttribute('aria-label', `Radar at ${fmtTime(f.time)}`);
      b.setAttribute('aria-pressed', String(i === r.index));
    });
    const f = r.frames[r.index];
    this.root.querySelector('.rad-time').textContent = f ? `Frame ${fmtTime(f.time)}` : '';
  }

  /** The station gauge's view of rain now, as the Rain tile decides it: a
   *  rate, "raining" if the newest packet tipped, or null when dry. */
  gaugeRain() {
    const R = this.readings;
    const rate = R.get('rainRate').v;
    if (Number.isFinite(rate) && rate > 0) return fmtUL('rainRate', rate, 1);
    if (R.inLatestPacket('rain') && R.get('rain').v > 0) return 'raining';
    return null;
  }

  /** Called for each live packet: redraw the radar facts when the gauge's
   *  rain state changes, so they never disagree with the Rain tile. */
  liveUpdate() {
    const g = this.gaugeRain();
    if (g === this.lastGauge) return;
    this.lastGauge = g;
    if (this.tab === 'radar') this.renderSide();
  }

  /** [label, value] rows for the radar side panel. */
  radarFacts() {
    const s = this.radar.stats;
    const gauge = this.gaugeRain();
    this.lastGauge = gauge;
    if (!s) return [['Rain at station', gauge || (this.radar.statsError ? '—' : 'checking…')]];
    const radius = 250;
    const rows = [];
    rows.push(['Nearest rain echo', s.nearest ? (s.atStation ? 'Over the station' : `${dist(s.nearest.dist)} ${compassPoint(s.nearest.bearing)}`)
      : `None within ${dist(radius)}`]);
    if (s.nearest) {
      rows.push(['Movement', !s.motion ? 'Too little to track'
        : s.motion.still ? 'Little movement' : `Toward ${compassPoint(s.motion.toward)} at ~${fmtUL('wind', s.motion.speed, 0)}`]);
      if (!s.atStation && s.motion && !s.motion.still) {
        let arr = 'Not heading this way';
        if (s.arrival) {
          const mins = (s.arrival - Date.now() / 1000) / 60;
          arr = mins < 15 ? 'Any time now (estimate)' : mins < 90 ? `~${Math.round(mins / 10) * 10} min (estimate)` : `~${Math.round(mins / 30) / 2} h (estimate)`;
        }
        rows.push(['Possible arrival', arr]);
      }
    }
    rows.push(['Rain at station', gauge ? `${gauge} (gauge)` : s.atStation ? 'Echo overhead, gauge dry' : 'None now']);
    rows.push(['Radar frame', fmtTime(s.time)]);
    return rows;
  }

  // ------------------------------------------------------------- mslp
  /** Map box height ('' = the stylesheet's), keeping Leaflet in step. */
  mapHeight(px) {
    const el = this.map.getContainer();
    if (el.style.height === px) return;
    el.style.height = px;
    this.map.invalidateSize({ animate: false });
  }

  /** Frame the pressure grid edge to edge: the map box takes the grid's
   *  shape (Mercator), then the grid fills it exactly, nothing cropped. */
  mslpView() {
    const d = this.mslp.data;
    const n = d && d.lat ? Math.max(...d.lat) : this.lat + 21;
    const s = d && d.lat ? Math.min(...d.lat) : this.lat - 21;
    const w = d && d.lon ? Math.min(...d.lon) : this.lon - 39;
    const e = d && d.lon ? Math.max(...d.lon) : this.lon + 39;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const ratio = ((merc(n) - merc(s)) / (2 * Math.PI)) / ((e - w) / 360);
    const width = this.map.getContainer().clientWidth;
    this.mapHeight(`${Math.round(Math.min(720, Math.max(260, width * ratio)))}px`);
    const b = L.latLngBounds([[s, w], [n, e]]);
    const z = this.map.getBoundsZoom(b, true);
    const p = this.map.project(b.getNorthWest(), z).add(this.map.project(b.getSouthEast(), z)).divideBy(2);
    this.map.setView(this.map.unproject(p, z), z, { animate: false });
    this.mslp.framed = Boolean(d);
  }

  async loadMslp() {
    // the skin refreshes the grid every few hours; re-read it every 30 min
    if (this.mslp.data && Date.now() - this.mslp.loadedAt < 30 * 60 * 1000) { this.drawMslp(); return; }
    try {
      const d = await loadJson('mslp');
      if (d.disabled) throw new Error('turned off in the skin settings');
      if (!d.p || !d.p.length) throw new Error(d.error || 'no data yet');
      this.mslp.data = d;
      this.mslp.loadedAt = Date.now();
      this.mslp.error = d.error ? `latest refresh failed (${d.error})` : null;
      // start at the step nearest now
      const now = Date.now() / 1000;
      let best = 0;
      d.times.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(d.times[best] - now)) best = i; });
      if (this.mslp.step === null || this.mslp.step >= d.times.length) this.mslp.step = best;
    } catch (e) {
      this.mslp.error = `MSLP ${e.message || e}`;
    }
    if (this.tab === 'mslp') {
      if (!this.mslp.framed && this.mslp.data) this.mslpView();   // first load: frame the real grid
      this.drawMslp();
    }
  }

  drawMslp() {
    const m = this.mslp;
    if (this.tab !== 'mslp') return;
    this.overlay.clearLayers();
    const chips = this.root.querySelector('.mslp-chips');
    if (m.data) {
      const d = m.data;
      if (chips.childElementCount !== d.times.length) {
        chips.replaceChildren(...d.times.map((t, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.step = String(i);
          return b;
        }));
      }
      d.times.forEach((t, i) => {
        const b = chips.children[i];
        const dt = new Date(t * 1000);
        const hour = dt.toLocaleTimeString('en-AU', { hour: 'numeric', hour12: true }).replace(/\s/g, '').toLowerCase();
        b.textContent = `${dt.toLocaleDateString('en-AU', { weekday: 'short' })} ${hour}`;
        b.setAttribute('aria-pressed', String(i === m.step));
        b.setAttribute('aria-label', `Pressure chart for ${dt.toLocaleString('en-AU')}`);
      });
      const chart = isobars(d, m.step);
      m.chart = chart;
      const col = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#333';
      const labelled = [];
      for (const line of chart.lines) {
        const major = line.level % (ISOBAR_HPA * 5) === 0;
        L.polyline(line.pts, { color: col, weight: major ? 1.8 : 1.1, opacity: 0.75, interactive: false, smoothFactor: 0.5 })
          .addTo(this.overlay);
        if (line.pts.length < 10) continue;
        const p = line.pts[Math.floor(line.pts.length / 2)];
        if (labelled.some((q) => q.level === line.level && Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 8)) continue;
        labelled.push({ level: line.level, p });
        L.marker(p, {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'isobar-lbl', html: `<span>${line.level}</span>`, iconSize: null }),
        }).addTo(this.overlay);
      }
      for (const c of chart.centres) {
        L.marker([c.lat, c.lon], {
          keyboard: false,
          icon: L.divIcon({ className: `hl-lbl hl-${c.type}`, html: `<div><b>${c.type}</b><span>${Math.round(c.p)}</span></div>`, iconSize: null }),
        }).bindTooltip(`${c.type === 'H' ? 'High' : 'Low'} ${Math.round(c.p)} hPa`).addTo(this.overlay);
      }
    }
    this.renderSide();
  }

  mslpFacts() {
    const m = this.mslp;
    if (!m.data || !m.chart) return [];
    const t = m.data.times[m.step];
    const rows = [['Chart time', new Date(t * 1000).toLocaleString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    })]];
    rows.push(['Model pressure here', fmtUL('pressure', m.chart.at(this.lat, this.lon), 1)]);
    const baro = this.readings.get('barometer').v;
    if (Number.isFinite(baro)) rows.push(['Station barometer now', fmtUL('pressure', baro, 1)]);
    const near = (type) => {
      let best = null;
      for (const c of m.chart.centres) {
        if (c.type !== type) continue;
        const db = distBearing(this.lat, this.lon, c.lat, c.lon);
        if (!best || db.dist < best.dist) best = { ...db, p: c.p };
      }
      return best ? `${fmtUL('pressure', best.p, 0)} · ${dist(best.dist, 10)} ${compassPoint(best.bearing)}` : 'none on the chart';
    };
    rows.push(['Nearest high', near('H')], ['Nearest low', near('L')]);
    return rows;
  }

  // ----------------------------------------------------------- quakes
  quakePrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(QUAKE_STORE) || '{}') || {}; } catch (e) { /* ignore */ }
    const pick = (v, list, d) => (list.includes(Number(v)) ? Number(v) : d);
    return {
      days: pick(saved.days, QUAKE_DAYS, QUAKE_DEFAULT.days),
      far: pick(saved.far, QUAKE_FAR_KM, QUAKE_DEFAULT.far),
      near: pick(saved.near, QUAKE_NEAR_KM, QUAKE_DEFAULT.near),
    };
  }

  /** Fill the look-back and range pickers under the map (labels follow the
   *  distance unit) and refetch when one changes. */
  quakeControls() {
    const ctl = this.root.querySelector('.quake-ctl');
    if (!ctl) return;
    const lists = {
      days: QUAKE_DAYS.map((d) => [d, d === 1 ? '24 hours' : `${d} days`]),
      far: QUAKE_FAR_KM.map((km) => [km, dist(km)]),
      near: QUAKE_NEAR_KM.map((km) => [km, km ? dist(km) : 'off']),
    };
    for (const sel of ctl.querySelectorAll('select[data-q]')) {
      const key = sel.dataset.q;
      sel.replaceChildren(...lists[key].map(([v, text]) => new Option(text, String(v))));
      sel.value = String(this.quakes.prefs[key]);
    }
    if (ctl.dataset.wired) return;
    ctl.dataset.wired = '1';
    ctl.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-q]');
      if (!sel) return;
      const p = this.quakes.prefs;
      p[sel.dataset.q] = Number(sel.value);
      try { localStorage.setItem(QUAKE_STORE, JSON.stringify(p)); } catch (e2) { /* ignore */ }
      this.quakes.sel = null;
      if (this.tab === 'quakes') {
        this.rings.clearLayers();
        this.quakeRings();
        if (sel.dataset.q === 'far') this.quakeView();
      }
      this.loadQuakes();
    });
  }

  quakeRings() {
    const p = this.quakes.prefs;
    this.drawRings([p.far], (km) => `M4+ within ${dist(km)}`);
    if (p.near) this.drawRings([p.near], (km) => `M2+ within ${dist(km)}`);
  }

  /** Frame the M4+ range around the station. */
  quakeView() {
    const km = this.quakes.prefs.far;
    const dLat = km / KM_PER_DEG;
    const dLon = Math.min(180, km / (KM_PER_DEG * Math.max(0.2, Math.cos(rad(this.lat)))));
    this.map.fitBounds([[Math.max(-80, this.lat - dLat), this.lon - dLon], [Math.min(80, this.lat + dLat), this.lon + dLon]],
      { animate: false });
  }

  async loadQuakes() {
    const Q = this.quakes;
    clearTimeout(Q.timer);
    const seq = ++Q.seq;
    const p = Q.prefs;
    const start = new Date(Date.now() - p.days * 86400000).toISOString().slice(0, 19);
    const q = (minmag, km) => `${EMSC}?${new URLSearchParams({
      format: 'json', lat: this.lat, lon: this.lon, maxradius: (km / KM_PER_DEG).toFixed(2), minmag,
      starttime: start, limit: QUAKE_LIMIT, orderby: 'time',
    })}`;
    try {
      const [far, near] = await Promise.all([getJson(q(4, p.far)), p.near ? getJson(q(2, p.near)) : { features: [] }]);
      if (seq !== Q.seq) return;           // the viewer changed the settings meanwhile
      const seen = new Map();
      for (const f of [...far.features, ...near.features]) {
        const e = f.properties;
        if (seen.has(e.unid)) continue;
        const db = distBearing(this.lat, this.lon, e.lat, e.lon);
        // draw on the world copy nearest the station (Tonga east of Australia, not far west)
        const lonN = e.lon + 360 * Math.round((this.lon - e.lon) / 360);
        seen.set(e.unid, { ...e, t: Date.parse(e.time) / 1000, lonN, ...db });
      }
      Q.events = [...seen.values()].sort((a, b) => b.t - a.t);
      Q.truncated = far.features.length >= QUAKE_LIMIT || near.features.length >= QUAKE_LIMIT;
      Q.fetchedAt = Date.now();
      Q.error = null;
    } catch (e) {
      if (seq !== Q.seq) return;
      Q.error = `EMSC ${e.message}`;
    }
    if (this.tab === 'quakes') {
      const keep = Q.sel;                  // a refresh keeps the open event open
      this.overlay.clearLayers();
      this.drawQuakes();
      if (keep && Q.markers.has(keep)) { Q.sel = keep; this.pickQuake(keep, true); }
    }
    this.renderSide();
    Q.timer = setTimeout(() => this.loadQuakes(), QUAKE_REFRESH_MS);
  }

  quakeColour(t) {
    const age = Date.now() / 1000 - t;
    if (age < 86400) return '#D93A2B';
    if (age < 7 * 86400) return '#F08A24';
    return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
  }

  drawQuakes() {
    const Q = this.quakes;
    Q.markers = new Map();
    // oldest first, so the newest are drawn on top
    for (let i = Q.events.length - 1; i >= 0; i--) {
      const e = Q.events[i];
      const c = this.quakeColour(e.t);
      const m = L.circleMarker([e.lat, e.lonN], {
        renderer: this.quakeRenderer,
        radius: Math.max(3, (e.mag - 1) * 3), color: c, weight: 1.5, fillColor: c, fillOpacity: 0.35,
      }).bindTooltip(`M${fmt(e.mag, 1)} ${e.flynn_region} · ${fmtTime(e.t)}`)
        .bindPopup(() => this.quakeDetail(e, true), { maxWidth: 280, minWidth: 220, className: 'quake-pop', autoPanPaddingTopLeft: [56, 12] })
        .addTo(this.overlay);
      m.on('popupopen', () => { Q.sel = e.unid; this.markQuake(); this.renderQuakeList(true); });
      m.on('popupclose', () => { if (Q.sel === e.unid) { Q.sel = null; this.markQuake(); this.renderQuakeList(); } });
      Q.markers.set(e.unid, m);
    }
  }

  /** Events inside the current map view (any world copy). */
  quakesInView() {
    const b = this.map.getBounds();
    return this.quakes.events.filter((e) => [0, 360, -360].some((k) => b.contains([e.lat, e.lonN + k])));
  }

  /** Details for one event: the map popup (a heading and the key rows, small
   *  enough for a phone-sized map) or in full under its list entry. */
  quakeDetail(e, popup) {
    const heading = popup;
    const box = document.createElement('div');
    box.className = 'quake-detail';
    if (heading) {
      const h = document.createElement('div');
      h.className = 'qd-h';
      const mag = document.createElement('span');
      mag.className = 'mag';
      mag.style.background = this.quakeColour(e.t);
      mag.textContent = fmt(e.mag, 1);
      const name = document.createElement('b');
      name.textContent = e.flynn_region;
      h.append(mag, name);
      box.append(h);
    }
    const when = new Date(e.t * 1000);
    const utc = when.toISOString().slice(11, 16);
    const rows = [
      ['Magnitude', `M${fmt(e.mag, 1)}${e.magtype ? ` (${e.magtype})` : ''}`],
      ['Time', `${fmtDate(e.t)} ${fmtTime(e.t)} (${utc} UTC)`],
      ['Age', fmtAge(Date.now() / 1000 - e.t)],
      ['Depth', dist(e.depth)],
      ['From the station', `${dist(e.dist)} ${compassPoint(e.bearing)} (${Math.round(e.bearing)}°)`],
      ['Location', `${fmt(Math.abs(e.lat), 2)}°${e.lat < 0 ? 'S' : 'N'}, ${fmt(Math.abs(e.lon), 2)}°${e.lon < 0 ? 'W' : 'E'}`],
      ['Type', QUAKE_TYPES[e.evtype] || e.evtype || '—'],
      ['Reported by', e.auth || '—'],
    ];
    const up = Date.parse(e.lastupdate);
    if (Number.isFinite(up)) rows.push(['Last revised', fmtAge(Date.now() / 1000 - up / 1000)]);
    if (popup) {
      const brief = ['Time', 'Depth', 'From the station'];
      rows.splice(0, rows.length, ...rows.filter(([k]) => brief.includes(k)));
      rows[0] = ['Time', `${fmtDate(e.t)} ${fmtTime(e.t)}`];
    }
    const dl = document.createElement('dl');
    dl.className = 'side-facts';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      row.append(dt, dd);
      dl.append(row);
    }
    const a = document.createElement('a');
    a.href = `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(e.unid)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Full details on EMSC ↗';
    box.append(dl, a);
    return box;
  }

  /** List the events in the map view, newest first; the picked one opens up. */
  renderQuakeList(scroll) {
    const list = this.quakeListEl;
    if (this.tab !== 'quakes' || !list || !list.isConnected) return;
    const Q = this.quakes;
    const shown = this.quakesInView();
    const inView = shown.length;
    // the picked event stays listed even once the map moves off it
    const picked = Q.sel && !shown.some((e) => e.unid === Q.sel) && Q.events.find((e) => e.unid === Q.sel);
    if (picked) shown.unshift(picked);
    const focused = document.activeElement && document.activeElement.closest
      && document.activeElement.closest('.quake-list .q-item');
    const refocus = focused && focused.dataset.unid;
    list.replaceChildren();
    for (const e of shown.slice(0, QUAKE_LIST_MAX)) {
      const li = document.createElement('li');
      const open = Q.sel === e.unid;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q-item';
      btn.dataset.unid = e.unid;
      btn.setAttribute('aria-expanded', String(open));
      const badge = document.createElement('span');
      badge.className = 'mag';
      badge.style.background = this.quakeColour(e.t);
      badge.textContent = fmt(e.mag, 1);
      const txt = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = e.flynn_region;
      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = `${dist(e.depth)} deep · ${dist(e.dist)} ${compassPoint(e.bearing)} · ${fmtAge(Date.now() / 1000 - e.t)}`;
      txt.append(name, meta);
      btn.append(badge, txt);
      btn.addEventListener('click', () => this.pickQuake(e.unid));
      li.append(btn);
      if (open) {
        li.className = 'open';
        li.append(this.quakeDetail(e, false));
      }
      list.append(li);
    }
    if (refocus) {
      const b = [...list.querySelectorAll('.q-item')].find((x) => x.dataset.unid === refocus);
      if (b) b.focus({ preventScroll: true });
    }
    if (scroll) {
      const li = list.querySelector('li.open');
      // scroll the list only, not the page
      if (li) list.scrollTop = li.offsetTop - list.offsetTop - 4;
    }
    if (this.quakeCount) {
      const n = inView;
      const all = Q.events.length;
      let t = !Q.fetchedAt ? '' : !all ? 'No earthquakes in range.'
        : !n ? `None in the map view (${all} in range): zoom out or pan.`
          : `${n} in the map view${n < all ? ` of ${all} in range` : ''}${n > QUAKE_LIST_MAX ? `, newest ${QUAKE_LIST_MAX} listed` : ''}.`;
      if (Q.truncated) t += ` EMSC returned its limit of ${QUAKE_LIMIT}, so the oldest may be missing.`;
      this.quakeCount.textContent = t;
    }
  }

  /** List entry clicked: open its details there and ring its dot, or close them. */
  pickQuake(unid, reopen) {
    const Q = this.quakes;
    const m = Q.markers.get(unid);
    if (Q.sel === unid && !reopen) {
      Q.sel = null;
      if (m) m.closePopup();
    } else {
      if (Q.sel && Q.sel !== unid && Q.markers.has(Q.sel)) Q.markers.get(Q.sel).closePopup();
      Q.sel = unid;
    }
    this.markQuake();
    this.renderQuakeList();
  }

  /** Ring the picked event's dot (the list's details sit beside the map). */
  markQuake() {
    const Q = this.quakes;
    if (Q.hl && Q.markers.get(Q.hl.unid) === Q.hl.m) Q.hl.m.setStyle(Q.hl.style);
    Q.hl = null;
    const m = Q.sel && Q.markers.get(Q.sel);
    if (!m) return;
    Q.hl = { unid: Q.sel, m, style: { color: m.options.color, weight: m.options.weight } };
    const ring = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000';
    m.setStyle({ color: ring, weight: 3 });
    m.bringToFront();
  }

  // --------------------------------------------------------- lightning
  async loadLightning() {
    const on = this.cfg.options && this.cfg.options.lightning && this.cfg.options.lightning.enabled;
    if (!on) { this.ltg.error = null; return; }
    try {
      const d = await loadJson('lightning');
      if (d.disabled) throw new Error('turned off in the skin settings');
      this.ltg.data = d;
      this.ltg.error = null;
    } catch (e) {
      this.ltg.error = `Lightning ${e.message || e}`;
    }
    if (this.tab === 'lightning') { this.overlay.clearLayers(); this.drawLightning(); this.renderSide(); }
    setTimeout(() => this.loadLightning(), LIGHTNING_REFRESH_MS);
  }

  /** Strikes from the last hour (WeeWX keeps them that long), nearest first. */
  ltgStrikes() {
    const d = this.ltg.data;
    const keep = (d && d.keep_s) || 3600;
    const now = Date.now() / 1000;
    return d && d.strikes ? d.strikes.filter((s) => now - s.t < keep) : [];
  }

  /** Fresh strikes bright yellow, fading to orange then brown over the hour. */
  ltgColour(ageS) {
    if (ageS < 600) return '#F2C230';
    if (ageS < 1800) return '#E08A1E';
    return '#A0643C';
  }

  drawLightning() {
    const now = Date.now() / 1000;
    // oldest first, so the newest are drawn on top
    for (const s of [...this.ltgStrikes()].sort((a, b) => a.t - b.t)) {
      const ground = s.type === 'cg';
      const c = this.ltgColour(now - s.t);
      const kind = ground ? 'Ground strike' : 'In-cloud flash';
      const amp = Number.isFinite(s.kA) ? ` ${fmt(s.kA / 1000, 0)} kA` : '';
      L.circleMarker([s.lat, s.lon], {
        radius: ground ? 6 : 3.5, color: '#5A3A00', weight: ground ? 1.5 : 1,
        fillColor: c, fillOpacity: ground ? 0.95 : 0.75,
      }).bindTooltip(`${kind}${amp} · ${dist(s.km)} ${compassPoint(s.brg)} · ${fmtAge(now - s.t)}`)
        .addTo(this.overlay);
    }
  }

  lightningFacts() {
    const d = this.ltg.data;
    const now = Date.now() / 1000;
    const rows = [];
    rows.push(['Watching', d.watching ? `every 10 min: ${d.reason}` : `every 30 min: ${d.reason}`]);
    const recent = d.checked && now - d.checked < (d.every_s || 1800) + 600;
    const sm = recent ? d.summary : null;
    if (sm) {
      rows.push(['Last 5 minutes', sm.count
        ? `${sm.count} strike${sm.count === 1 ? '' : 's'} (${sm.cg} ground, ${sm.ic} in-cloud)` : 'none']);
    } else {
      rows.push(['Last 5 minutes', 'not checked recently']);
    }
    const hour = this.ltgStrikes();
    if (hour.length) {
      const near = hour[0];
      rows.push(['Mapped, last hour', `${hour.length} (${hour.filter((s) => s.type === 'cg').length} ground)`]);
      rows.push(['Nearest, last hour', `${dist(near.km)} ${compassPoint(near.brg)} · ${fmtAge(now - near.t)}`]);
    }
    const last = d.last_strike;
    if (last && last.t) {
      const where = Number.isFinite(last.km) ? `, ${dist(last.km)} ${compassPoint(last.brg)}` : '';
      rows.push(['Last strike seen', `${fmtAge(now - last.t)}${where}`]);
    }
    const b = d.budget;
    if (b) rows.push(['API tokens today', `${b.day_used} of ${b.day_limit}`]);
    return rows;
  }

  // ------------------------------------------------------------- side
  renderSide() {
    const side = this.root.querySelector('.map-side');
    const age = (s) => (s.fetchedAt ? `updated ${fmtAge((Date.now() - s.fetchedAt) / 1000)}` : 'loading…');
    side.replaceChildren();
    const add = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      side.append(d);
      return d;
    };
    if (this.tab === 'radar') {
      add('side-h', 'Rain near the station');
      const facts = document.createElement('dl');
      facts.className = 'side-facts';
      for (const [k, v] of this.radarFacts()) {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        facts.append(row);
      }
      side.append(facts);
      add('side-note muted', 'Movement and arrival are estimates from echo motion over the last 30 minutes. '
        + 'Radar can show echoes that don’t reach the ground. Last hour in 10-minute frames; tiles stop at zoom 7.');
      add('side-age mono muted', this.radar.error || this.radar.statsError || `RainViewer · ${age(this.radar)}`);
    } else if (this.tab === 'mslp') {
      add('side-h', 'Mean sea-level pressure');
      const facts = document.createElement('dl');
      facts.className = 'side-facts';
      for (const [k, v] of this.mslpFacts()) {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        facts.append(row);
      }
      side.append(facts);
      // link to an official analysed chart if the install names one ([[mslp]] chart_*)
      const chart = (this.cfg.options && this.cfg.options.mslp) || {};
      const hasChart = chart.chart_url && /^https?:\/\//.test(chart.chart_url);
      const note = add('side-note muted', 'Model isobars (ECMWF via Open-Meteo), not an analysed chart: '
        + `fronts and troughs aren’t drawn.${hasChart ? ' For those see the ' : ''}`);
      if (hasChart) {
        const a = document.createElement('a');
        a.href = chart.chart_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = chart.chart_name || 'official chart';
        note.append(a, '.');
      }
      const fetched = this.mslp.data && this.mslp.data.fetched;
      add('side-age mono muted', this.mslp.error
        || (fetched ? `Open-Meteo · model data fetched ${fmtAge(Date.now() / 1000 - fetched)}` : 'loading…'));
    } else if (this.tab === 'quakes') {
      add('side-h', 'Earthquakes');
      const p = this.quakes.prefs;
      add('side-note muted', `Last ${p.days === 1 ? '24 hours' : `${p.days} days`}: M4+ within ${dist(p.far)}`
        + `${p.near ? `, M2+ within ${dist(p.near)}` : ''}. The list shows those in the map view; `
        + 'pick one, or a dot on the map, for details.');
      this.quakeCount = add('side-row muted small', '');
      this.quakeListEl = document.createElement('ol');
      this.quakeListEl.className = 'quake-list';
      side.append(this.quakeListEl);
      this.renderQuakeList();
      add('side-age mono muted', this.quakes.error || `EMSC-CSEM · ${age(this.quakes)}`);
    } else {
      add('side-h', 'Lightning near the station');
      // Blitzortung's live map may be linked to, not embedded (lightningmaps.org/about)
      const liveMap = () => {
        const a = document.createElement('a');
        a.className = 'btn-sec side-link';
        a.href = `https://www.lightningmaps.org/#m=oss;t=3;s=0;o=0;b=;ts=0;y=${this.lat};x=${this.lon};z=8;d=2;dl=2;dc=0;`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Live map on LightningMaps.org ↗';
        side.append(a);
      };
      const on = this.cfg.options && this.cfg.options.lightning && this.cfg.options.lightning.enabled;
      if (!on) {
        add('side-row', 'No lightning source is configured.');
        liveMap();
        add('side-note muted', 'Strikes can come from the Xweather Weather API: see [[lightning]] in skin.conf.');
        return;
      }
      const d = this.ltg.data;
      if (d) {
        const facts = document.createElement('dl');
        facts.className = 'side-facts';
        for (const [k, v] of this.lightningFacts()) {
          const row = document.createElement('div');
          const dt = document.createElement('dt');
          const dd = document.createElement('dd');
          dt.textContent = k;
          dd.textContent = v;
          row.append(dt, dd);
          facts.append(row);
        }
        side.append(facts);
        liveMap();
        add('side-note muted', `Strikes within ${dist(d.radius_km)} over the last hour, from the Xweather `
          + 'Lightning Network: large dots hit the ground, small ones stayed in the cloud; yellow under 10 minutes '
          + 'old, orange under 30, brown older. Each check sees the 5 minutes before it (every 10 minutes while '
          + 'storms are likely, otherwise every 30), so the map shows a sample, not every strike. '
          + 'If you can hear thunder, you are close enough to be struck.');
      }
      add('side-age mono muted', this.ltg.error || (d && d.error ? `latest check failed (${d.error})` : '')
        || (d && d.checked ? `Xweather · checked ${fmtAge(Date.now() / 1000 - d.checked)}` : 'loading…'));
    }
  }
}
