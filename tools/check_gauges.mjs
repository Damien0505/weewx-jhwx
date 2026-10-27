#!/usr/bin/env node
// Every tile needs a gauge: checks that each tile id in js/tiles.js has a
// gauge with the same `ref` in js/gauges.js, with every optional tile
// switched on.
//
//   node tools/check_gauges.mjs

import { tileDefs } from '../skins/jhwx/js/tiles.js';
import { gaugeDefs } from '../skins/jhwx/js/gauges.js';

const cfg = {
  station: { hardware: 'test' },
  sensors: { outdoor: 'Outdoor', console: 'Console', rain: 'Rain gauge' },
  options: {
    fire: { enabled: true },
    power: {
      supercap: { field: 'supplyVoltage', label: 'Supercap', min: 0, max: 6 },
      battery: { field: 'batteryStatus1', label: 'Battery', min: 2, max: 3.6, low: 2.4, fair: 2.8 },
    },
  },
};

const tiles = tileDefs(cfg).map((t) => t.id);
const refs = new Set(gaugeDefs(cfg).map((g) => g.ref));
const missing = tiles.filter((id) => !refs.has(id));
if (missing.length) {
  console.error(`tiles without a gauge: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${tiles.length} tiles, each with a gauge`);
