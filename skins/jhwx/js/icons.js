// Inline stroke SVG weather icons (from the approved mockup, plus night
// variants).  icon(name, size) -> SVG markup string with role="img".

const SUN = 'style="fill:#F6B73C;stroke:#E08A1E"';
const CLOUD = 'style="fill:var(--surface);stroke:var(--text)"';
const MOON = 'style="fill:var(--moonLit);stroke:var(--muted)"';

const BODY = {
  sunny: `<circle cx="12" cy="12" r="4.2" ${SUN} stroke-width="1"/>
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" style="stroke:#E08A1E" stroke-width="1.2"/>`,
  partly: `<circle cx="9" cy="8.5" r="3.6" ${SUN} stroke-width="1"/>
    <path d="M9 2.2v1.2M3.9 4.3l.9.9M2.7 8.5h1.2M14.1 4.3l-.9.9" style="stroke:#E08A1E" stroke-width="1"/>
    <path d="M8.2 20h9.3a3.9 3.9 0 0 0 .3-7.8 5.3 5.3 0 0 0-10.2 1.6 3.1 3.1 0 0 0 .6 6.2z" ${CLOUD} stroke-width="1.1"/>`,
  cloudy: `<path d="M7 18.5h10.2a4.3 4.3 0 0 0 .4-8.6A6 6 0 0 0 6.2 11a3.8 3.8 0 0 0 .8 7.5z" ${CLOUD} stroke-width="1.2"/>`,
  showers: `<path d="M7 15h10.2a4 4 0 0 0 .4-8A5.6 5.6 0 0 0 6.3 8.2 3.4 3.4 0 0 0 7 15z" ${CLOUD} stroke-width="1.2"/>
    <path d="M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5" style="stroke:#2F7BD8" stroke-width="1.5"/>`,
  heavyrain: `<path d="M7 14h10.2a4 4 0 0 0 .4-8A5.6 5.6 0 0 0 6.3 7.2 3.4 3.4 0 0 0 7 14z" ${CLOUD} stroke-width="1.2"/>
    <path d="M7.5 16.5l-1.4 3.5M11 16.5l-1.4 3.5M14.5 16.5l-1.4 3.5M18 16.5l-1.4 3.5" style="stroke:#2F7BD8" stroke-width="1.6"/>`,
  thunder: `<path d="M7 14.5h10.2a4 4 0 0 0 .4-8A5.6 5.6 0 0 0 6.3 7.7 3.4 3.4 0 0 0 7 14.5z" ${CLOUD} stroke-width="1.2"/>
    <path d="M12.8 14.5l-2.3 4h3l-2.2 4" style="stroke:#E08A1E" stroke-width="1.5"/>`,
  clearnight: `<path d="M17.5 14.8A7 7 0 0 1 9.2 6.5a7 7 0 1 0 8.3 8.3z" ${MOON} stroke-width="1"/>
    <path d="M17 4.5v2M16 5.5h2M20 9v1.4M19.3 9.7h1.4" style="stroke:var(--muted)" stroke-width="1"/>`,
  partlynight: `<path d="M15.5 10.6A5.2 5.2 0 0 1 9.4 4.5a5.2 5.2 0 1 0 6.1 6.1z" ${MOON} stroke-width="1"/>
    <path d="M8.2 20h9.3a3.9 3.9 0 0 0 .3-7.8 5.3 5.3 0 0 0-10.2 1.6 3.1 3.1 0 0 0 .6 6.2z" ${CLOUD} stroke-width="1.1"/>`,
};

export const LABELS = {
  sunny: 'Sunny', partly: 'Partly cloudy', cloudy: 'Cloudy', showers: 'Showers', heavyrain: 'Heavy rain',
  thunder: 'Thunderstorms', clearnight: 'Clear', partlynight: 'Partly cloudy',
};

export function icon(name, size = 40, label = LABELS[name] || name) {
  const body = BODY[name] || BODY.cloudy;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}">${body}</svg>`;
}
