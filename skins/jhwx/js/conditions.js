// Current-conditions icon and text (DESIGN-SPEC "Current-conditions icon
// logic").  Inputs are smoothed over 10 minutes so passing clouds don't make
// the icon flicker.

const SMOOTH_S = 600;

/**
 * @param R      Readings (live + current.json)
 * @param trends TrendBuffer (recent history)
 * @param sunAlt current sun elevation, degrees
 * @param cloud  cloud cover % if known (Open-Meteo), else null
 * @returns { icon, text }
 */
export function currentConditions(R, trends, sunAlt, cloud = null) {
  const now = trends.newest('outTemp') || Date.now() / 1000;
  const mean = (f) => trends._mean(f, now - SMOOTH_S, now + 1);

  // rain: live rate, or any rain in the last 10 minutes
  const rate = R.get('rainRate').v;
  const recentRain = trends._mean('rain', now - SMOOTH_S, now + 1);
  const raining = (Number.isFinite(rate) && rate > 0) || (recentRain !== null && recentRain > 0);
  if (raining) {
    const r = Number.isFinite(rate) ? rate : 0;
    if (r >= 10) return { icon: 'heavyrain', text: 'Heavy rain' };
    if (r >= 2.5) return { icon: 'showers', text: 'Moderate rain' };
    return { icon: 'showers', text: 'Light rain' };
  }

  const sol = mean('radiation');
  const max = mean('maxSolarRad');
  if (sunAlt > 5 && Number.isFinite(sol) && Number.isFinite(max) && max > 50) {
    const ratio = sol / max;
    if (ratio >= 0.75) return { icon: 'sunny', text: 'Sunny' };
    if (ratio >= 0.4) return { icon: 'partly', text: 'Partly cloudy' };
    return { icon: 'cloudy', text: 'Cloudy' };
  }

  // night / low sun: cloud cover from Open-Meteo if we have it
  const day = sunAlt > -6;
  if (Number.isFinite(cloud)) {
    if (cloud < 30) return day ? { icon: 'sunny', text: 'Clear' } : { icon: 'clearnight', text: 'Clear' };
    if (cloud < 70) return day ? { icon: 'partly', text: 'Partly cloudy' } : { icon: 'partlynight', text: 'Partly cloudy' };
    return { icon: 'cloudy', text: 'Cloudy' };
  }
  return day ? { icon: 'partly', text: 'Low sun' } : { icon: 'clearnight', text: 'Night' };
}
