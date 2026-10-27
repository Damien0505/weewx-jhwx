// Live loop packets from Mosquitto over websockets (weewx-mqtt, US units).
//
// Keeps the latest metric value and the packet time each field was last seen,
// and measures the packet cadence so staleness works for any station
// (Wittboy ~10 s, HP1000 ~15 s).

import { packetToMetric, IGNORED_FIELDS } from './units.js';

const DEFAULT_CADENCE = 10;     // seconds, until measured
const FRESH_PACKETS = 3;        // <= 3 packets old: fresh
const STALE_PACKETS = 10;       // <= 10 packets old: stale, then offline

/** Resolve a broker URL from config: relative paths are taken against the page
 *  and switched to ws:// or wss:// to match http(s). */
export function resolveBrokerUrl(url) {
  if (/^wss?:\/\//.test(url)) return url;
  const u = new URL(url, window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export class LiveFeed extends EventTarget {
  constructor(url, topic) {
    super();
    this.url = resolveBrokerUrl(url);
    this.topic = topic;
    this.values = {};          // field -> metric value
    this.lastSeen = {};        // field -> epoch seconds (packet dateTime)
    this.lastPacket = null;    // epoch seconds of the newest packet
    this.lastPacketRx = null;  // local receive time (ms) of the newest packet
    this.intervals = [];       // recent packet spacing, seconds
    this.status = 'connecting';
  }

  start() {
    if (typeof mqtt === 'undefined') {
      this._setStatus('error', 'MQTT library missing');
      return;
    }
    const client = mqtt.connect(this.url, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
      clientId: 'jhwx-' + Math.random().toString(16).slice(2, 10),
    });
    this.client = client;
    client.on('connect', () => {
      this._setStatus('connected');
      client.subscribe(this.topic, { qos: 0 });
    });
    client.on('reconnect', () => this._setStatus('connecting'));
    client.on('offline', () => this._setStatus('offline'));
    client.on('close', () => { if (this.status === 'connected') this._setStatus('offline'); });
    client.on('error', (e) => this._setStatus('error', String(e && e.message || e)));
    client.on('message', (_t, payload) => this._onMessage(payload));
  }

  _setStatus(status, detail = '') {
    if (status === this.status && !detail) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  _onMessage(payload) {
    let packet;
    try {
      packet = JSON.parse(new TextDecoder().decode(payload));
    } catch (e) {
      return;
    }
    const m = packetToMetric(packet);
    const ts = m.dateTime;
    if (!Number.isFinite(ts)) return;
    if (this.lastPacket !== null && ts > this.lastPacket) {
      this.intervals.push(ts - this.lastPacket);
      if (this.intervals.length > 30) this.intervals.shift();
    }
    if (this.lastPacket === null || ts >= this.lastPacket) {
      this.lastPacket = ts;
      this.lastPacketRx = Date.now();
    }
    for (const [k, v] of Object.entries(m)) {
      if (k === 'dateTime' || IGNORED_FIELDS.has(k)) continue;
      this.values[k] = v;
      this.lastSeen[k] = ts;
    }
    this.dispatchEvent(new CustomEvent('packet', { detail: { ts, fields: m } }));
  }

  /** Typical seconds between packets (median of recent spacing). */
  cadence() {
    if (this.intervals.length < 3) return DEFAULT_CADENCE;
    const s = [...this.intervals].sort((a, b) => a - b);
    return Math.max(2, s[Math.floor(s.length / 2)]);
  }

  /** Clock offset: station time minus browser time (s), from the newest packet. */
  clockSkew() {
    if (this.lastPacket === null) return 0;
    return this.lastPacket - this.lastPacketRx / 1000;
  }

  /** Seconds since the field was last in a packet, on the station's clock. */
  age(field, nowMs = Date.now()) {
    const t = this.lastSeen[field];
    if (t === undefined) return null;
    return nowMs / 1000 + this.clockSkew() - t;
  }

  /** 'fresh' | 'stale' | 'offline' | 'missing' for a field. */
  state(field, nowMs = Date.now()) {
    const a = this.age(field, nowMs);
    if (a === null) return 'missing';
    const c = this.cadence();
    if (a <= FRESH_PACKETS * c + 2) return 'fresh';
    if (a <= STALE_PACKETS * c + 2) return 'stale';
    return 'offline';
  }
}
