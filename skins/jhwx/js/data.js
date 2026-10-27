// Files the skin generates each report cycle (data/*.json, already metric).

const TIMEOUT_MS = 10000;

/** Fetch data/<name>.json.  Rejects files whose "units" tag says they are not
 *  the metric set the UI expects, rather than showing wrong numbers. */
export async function loadJson(name) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`data/${name}.json`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(`data/${name}.json: HTTP ${r.status}`);
    const d = await r.json();
    if ('units' in d && d.units !== 'metric') {
      throw new Error(`data/${name}.json units are "${d.units}", expected metric`);
    }
    return d;
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds until shortly after the next report cycle should have written new
 *  files: the archive record time + interval + ~75 s for generation. */
export function secondsToNextCycle(recordTs, intervalS, nowS = Date.now() / 1000) {
  if (!Number.isFinite(recordTs) || !Number.isFinite(intervalS)) return 60;
  let next = recordTs + intervalS + 75;
  while (next <= nowS) next += intervalS;
  return Math.min(Math.max(next - nowS, 15), intervalS + 75);
}
