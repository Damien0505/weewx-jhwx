"""Mean sea-level pressure grid for the jhwx skin's MSLP chart.

Fetches pressure_msl on a regular lat/lon grid from Open-Meteo (CC BY 4.0)
and keeps it as data/mslp.json; the browser draws the isobars.  Open-Meteo
counts every grid point as one API call, so the grid is fetched here, at most
every REFRESH_S, rather than by every visitor's browser.  If a fetch fails the
previous file is kept and the error noted in it.
"""

import json
import logging
import os
import time
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

API = 'https://api.open-meteo.com/v1/forecast'
REFRESH_S = 6 * 3600       # global models run every 6 hours
TIMEOUT_S = 20
HOURS = 72                 # forecast range, at 6-hour steps
STEP_H = 6

# 3° spacing: the default 42 x 78 degree area (15 x 27 = 405 points) keeps
# one fetch to ~400 API calls.
STEP_DEG = 3.0
SPAN_LAT, SPAN_LON = 42.0, 78.0


def bounds_for(lat, lon, bounds=None):
    """(north, south, west, east): `bounds` as configured, else the default
    area centred on the station, kept inside +-80 latitude / +-180 longitude."""
    if bounds:
        n, s, w, e = [float(x) for x in bounds]
        return max(n, s), min(n, s), min(w, e), max(w, e)
    n = min(80.0, lat + SPAN_LAT / 2)
    s = max(-80.0, n - SPAN_LAT)
    n = s + SPAN_LAT
    w = max(-180.0, lon - SPAN_LON / 2)
    e = min(180.0, w + SPAN_LON)
    w = e - SPAN_LON
    # whole-degree multiples of the spacing, so the grid stays the same size
    snap = lambda v: round(v / STEP_DEG) * STEP_DEG
    return snap(n), snap(s), snap(w), snap(e)


def _grid(bounds):
    lat_n, lat_s, lon_w, lon_e = bounds
    lats = []
    v = lat_n
    while v >= lat_s - 1e-9:
        lats.append(round(v, 3))
        v -= STEP_DEG
    lons = []
    v = lon_w
    while v <= lon_e + 1e-9:
        lons.append(round(v, 3))
        v += STEP_DEG
    return lats, lons


def fetch(user_agent, bounds):
    """Download the grid: {"lat": [...], "lon": [...], "times": [...],
    "p": [[row-major hPa, one list per time]]}."""
    lats, lons = _grid(bounds)
    pts_lat = [la for la in lats for _ in lons]
    pts_lon = [lo for _ in lats for lo in lons]
    q = urllib.parse.urlencode({
        'latitude': ','.join('%g' % x for x in pts_lat),
        'longitude': ','.join('%g' % x for x in pts_lon),
        'hourly': 'pressure_msl',
        'forecast_hours': HOURS + 1,
        'temporal_resolution': 'hourly_%d' % STEP_H,
        'timeformat': 'unixtime',
        'timezone': 'GMT',
    })
    req = urllib.request.Request('%s?%s' % (API, q), headers={'User-Agent': user_agent})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        points = json.loads(r.read().decode('utf-8'))
    if not isinstance(points, list) or len(points) != len(pts_lat):
        raise ValueError('unexpected response: %s' % str(points)[:200])
    times = points[0]['hourly']['time']
    p = []
    for k in range(len(times)):
        row = []
        for pt in points:
            v = pt['hourly']['pressure_msl'][k]
            row.append(None if v is None else round(v, 1))
        p.append(row)
    # drop trailing steps the model hasn't reached yet
    while p and sum(v is None for v in p[-1]) > len(p[-1]) // 10:
        p.pop()
        times = times[:len(p)]
    if not p:
        raise ValueError('no pressure values in the response')
    return {'lat': lats, 'lon': lons, 'times': times, 'p': p}


def mslp_json(path, enabled, user_agent, bounds, now=None):
    """JSON text for data/mslp.json.  `path` is that file in HTML_ROOT, read
    back as the cache (refetched at once if the area has changed)."""
    now = int(now or time.time())
    if not enabled:
        return json.dumps({'disabled': True})
    old = None
    try:
        with open(path, encoding='utf-8') as f:
            old = json.load(f)
    except (OSError, ValueError):
        pass
    lats, lons = _grid(bounds)
    if old and not old.get('disabled') and old.get('lat') == lats and old.get('lon') == lons:
        fresh = old.get('p') and now - old.get('fetched', 0) < REFRESH_S
        if fresh or now < old.get('retry_after', 0):
            return json.dumps(old, separators=(',', ':'))
    else:
        old = None
    try:
        t0 = time.time()
        grid = fetch(user_agent, bounds)
        log.info('jhwx: MSLP grid fetched from Open-Meteo in %.1f s', time.time() - t0)
        out = dict(grid, fetched=now, source='Open-Meteo.com', error=None)
    except Exception as e:     # network, HTTP 429, bad JSON: keep the old grid
        log.error('jhwx: MSLP fetch failed: %s', e)
        out = dict(old or {}, error=str(e)[:200], retry_after=now + 3600)
    return json.dumps(out, separators=(',', ':'))
