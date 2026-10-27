// Apparent fire danger: McArthur Forest Fire Danger Index (Mark 5) from the
// current temperature, humidity and 10-minute mean wind, with the drought
// factor the skin computes from the station's rain history (data/current.json
// "fire").  Indicative only - official ratings come from the fire agencies.

/** FFDI (Noble et al. 1980): T °C, RH %, V km/h (10 min mean), DF 0-10. */
export function ffdi(T, RH, V, DF) {
  if (![T, RH, V, DF].every(Number.isFinite) || DF <= 0) return null;
  return 2 * Math.exp(-0.45 + 0.987 * Math.log(DF) - 0.0345 * RH + 0.0338 * T + 0.0234 * V);
}

// FFDI ranges commonly used to match the Australian Fire Danger Rating
// System levels, with each level's official key message.
export const FIRE_LEVELS = [
  { min: 100, name: 'Catastrophic', color: '#7A0A0A', ink: '#FFFFFF', range: '100+',
    advice: 'For your survival, leave bush fire risk areas.' },
  { min: 50, name: 'Extreme', color: '#E2591B', ink: '#FFFFFF', range: '50–99',
    advice: 'Take action now to protect your life and property.' },
  { min: 24, name: 'High', color: '#F2C200', ink: '#1A1A1A', range: '24–49',
    advice: 'Be ready to act.' },
  { min: 12, name: 'Moderate', color: '#5AAE3A', ink: '#FFFFFF', range: '12–23',
    advice: 'Plan and prepare.' },
  { min: -Infinity, name: 'No rating', color: 'var(--surface2)', ink: 'var(--text)', range: '0–11',
    advice: 'Below the lowest rating: fires are unlikely to spread far.' },
];
const BANDS = FIRE_LEVELS;

/** { name, color, ink } for an FFDI value, or null. */
export function fireBand(v) {
  if (!Number.isFinite(v)) return null;
  return BANDS.find((b) => v >= b.min);
}

/** Local-midnight epoch (s) of a time, for looking up a day's drought factor. */
export function dayKey(ts) {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** FFDI series for chart data: series {t, outTemp, outHumidity, windSpeed},
 *  daily {days, df}.  Each point uses its own day's drought factor. */
export function ffdiSeries(series, daily) {
  const df = new Map();
  if (daily) daily.days.forEach((d, i) => df.set(d, daily.df[i]));
  return series.t.map((t, i) => ffdi(series.outTemp[i], series.outHumidity[i], series.windSpeed[i],
    df.get(dayKey(t))));
}
