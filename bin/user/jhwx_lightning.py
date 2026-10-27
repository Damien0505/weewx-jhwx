"""Lightning near the station for the jhwx skin's Lightning map.

Strikes come from the Xweather Weather API (the last five minutes within
100 km on standard access).  The free Developer plan allows 15,000 access
tokens a month; a lightning summary (counts only) costs 1 token and a list
of strikes costs 10, so WeeWX spends them like this:

- a summary every IDLE_S in quiet weather, so storms the forecast missed are
  still noticed;
- a summary every WATCH_S while a storm is likely: the Open-Meteo forecast
  (free, checked hourly) shows thunderstorm codes or unstable air (CAPE)
  near now, or a strike was seen in the last HOLD_S;
- the strike list only when that summary counted strikes;
- daily and monthly token caps stop it whatever the weather.

Strikes are kept for KEEP_S (an hour) and then dropped; there is no strike
archive.  Each check covers only the five minutes before it, so during a
storm the hour's map holds about half the strikes, in bursts.  The result is data/lightning.json, which also holds this
module's state (token counts, last checks), read back on the next run.  The
client id and secret never leave this module.
"""

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

API = 'https://data.api.xweather.com/lightning'
FORECAST = 'https://api.open-meteo.com/v1/forecast'
TIMEOUT_S = 20
IDLE_S = 1800              # between summaries in quiet weather
WATCH_S = 600              # between summaries while a storm is likely
TRIGGER_S = 3600           # between forecast checks
HOLD_S = 3600              # keep watching this long after the last strike seen
KEEP_S = 3600              # strikes are kept (and shown) this long
MAX_KEPT = 3000            # newest strikes kept, at most
WINDOW_S = 300             # standard access covers the last five minutes
COST = {'summary': 1, 'strikes': 10}   # tokens, if the response doesn't say
MAX_STRIKES = 1000         # per query on standard access
THUNDER_CODES = (95, 96, 99)


def _day(now):
    return time.strftime('%Y-%m-%d', time.localtime(now))


def _clean(text, secrets):
    """Error text with the credentials blanked, in case a URL got into it."""
    text = str(text)
    for s in secrets:
        if s:
            text = text.replace(s, '***')
    return text[:200]


def _get(url, user_agent):
    req = urllib.request.Request(url, headers={'User-Agent': user_agent})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read().decode('utf-8')), r.headers


def check_forecast(lat, lon, user_agent, cape_j, now):
    """Is a thunderstorm likely from an hour ago to three hours ahead?
    -> {"checked", "likely", "why"}"""
    q = urllib.parse.urlencode({
        'latitude': '%.3f' % lat, 'longitude': '%.3f' % lon,
        'hourly': 'weather_code,cape', 'past_hours': 1, 'forecast_hours': 4,
        'timeformat': 'unixtime', 'timezone': 'GMT',
    })
    d, _ = _get('%s?%s' % (FORECAST, q), user_agent)
    h = d['hourly']
    why = None
    for t, code, cape in zip(h['time'], h['weather_code'], h['cape']):
        if t < now - 3600 or t > now + 3 * 3600:
            continue
        if code in THUNDER_CODES:
            why = 'thunderstorms forecast'
            break
        if cape is not None and cape >= cape_j and why is None:
            why = 'unstable air forecast (CAPE %d J/kg)' % cape
    return {'checked': now, 'likely': bool(why), 'why': why or 'no storms forecast'}


class Xweather(object):
    """The two lightning queries, counting the tokens each one cost."""

    def __init__(self, lat, lon, radius_km, client_id, client_secret, user_agent):
        self.p = '%.4f,%.4f' % (lat, lon)
        self.radius = '%dkm' % radius_km
        self.auth = {'client_id': client_id, 'client_secret': client_secret}
        self.user_agent = user_agent
        self.tokens = 0

    def _query(self, path, kind, **params):
        q = urllib.parse.urlencode(dict(params, radius=self.radius, **self.auth))
        try:
            d, headers = _get('%s/%s?%s' % (API, path, q), self.user_agent)
        except urllib.error.HTTPError:
            raise                  # 4xx/5xx responses aren't charged
        cost = headers.get('X-Cost-Tokens', '')
        self.tokens += int(cost) if cost.isdigit() else COST[kind]
        if not d.get('success'):
            err = d.get('error') or {}
            raise ValueError('%s: %s' % (err.get('code', 'error'), err.get('description', '')))
        return d.get('response') or []

    def summary(self):
        """{"count", "cg", "ic", "first", "last"} for the last five minutes."""
        r = self._query('summary/%s' % self.p, 'summary')
        s = (r[0] if isinstance(r, list) else r).get('summary', {}) if r else {}
        pulse, rng = s.get('pulse', {}), s.get('range', {})
        return {'count': pulse.get('count', 0), 'cg': pulse.get('cg', 0), 'ic': pulse.get('ic', 0),
                'first': rng.get('minTimestamp') or None, 'last': rng.get('maxTimestamp') or None}

    def strikes(self):
        """Strikes in the last five minutes, nearest first."""
        out = []
        for s in self._query('closest', 'strikes', p=self.p, limit=MAX_STRIKES):
            ob, rel = s.get('ob', {}), s.get('relativeTo', {})
            pulse = ob.get('pulse', {})
            out.append({
                'lat': round(s['loc']['lat'], 4), 'lon': round(s['loc']['long'], 4),
                't': ob.get('timestamp'), 'type': pulse.get('type'), 'kA': pulse.get('peakamp'),
                'km': round(rel.get('distanceKM', 0), 1), 'brg': rel.get('bearing'),
            })
        return out


def lightning_json(path, cfg, lat, lon, user_agent, now=None):
    """JSON text for data/lightning.json.  `cfg` = {enabled, client_id,
    client_secret, radius_km, daily_tokens, monthly_tokens, cape}.  `path` is
    that file in HTML_ROOT, read back as the state."""
    now = int(now or time.time())
    if not cfg['enabled'] or not cfg['client_id'] or not cfg['client_secret']:
        return json.dumps({'disabled': True})
    secrets = (cfg['client_id'], cfg['client_secret'])
    try:
        with open(path, encoding='utf-8') as f:
            st = json.load(f)
        if st.get('disabled'):
            st = {}
    except (OSError, ValueError):
        st = {}

    # tokens spent, per local day and per calendar month
    b = st.get('budget') or {}
    day = _day(now)
    if b.get('day') != day:
        b.update(day=day, day_used=0)
    if b.get('month') != day[:7]:
        b.update(month=day[:7], month_used=0)
    b.update(day_limit=cfg['daily_tokens'], month_limit=cfg['monthly_tokens'])

    trig = st.get('trigger') or {}
    if now - trig.get('checked', 0) >= TRIGGER_S and now >= trig.get('retry_after', 0):
        try:
            trig = check_forecast(lat, lon, user_agent, cfg['cape'], now)
        except Exception as e:     # keep the last answer, try again in 15 min
            log.error('jhwx: lightning forecast check failed: %s', e)
            trig = dict(trig, retry_after=now + 900, error=str(e)[:200])

    last = st.get('last_strike')
    holding = bool(last and now - last['seen'] < HOLD_S)
    watching = holding or trig.get('likely', False)
    reason = 'strikes seen in the last hour' if holding else trig.get('why', 'waiting for the forecast check')

    summary, strikes = st.get('summary'), st.get('strikes') or []
    checked, fetched = st.get('checked'), st.get('fetched')
    error, retry_after = st.get('error'), st.get('retry_after', 0)
    every = WATCH_S if watching else IDLE_S
    due = now - (checked or 0) >= every - 30 and now >= retry_after
    left = min(b['day_limit'] - b['day_used'], b['month_limit'] - b['month_used'])
    if due and left < COST['summary']:
        reason = 'daily or monthly token limit reached'
    elif due:
        xw = Xweather(lat, lon, cfg['radius_km'], cfg['client_id'], cfg['client_secret'], user_agent)
        try:
            summary = xw.summary()
            checked, error = now, None
            new = []
            if summary['count'] and left - xw.tokens >= COST['strikes']:
                new, fetched = xw.strikes(), now
            if new:
                s = new[0]
                last = {'seen': now, 't': max(x['t'] or 0 for x in new), 'km': s['km'],
                        'brg': s['brg'], 'type': s['type']}
                seen = {(x['t'], x['lat'], x['lon']) for x in new}
                strikes = new + [x for x in strikes if (x['t'], x['lat'], x['lon']) not in seen]
            elif summary['count']:
                last = dict(last or {}, seen=now, t=summary['last'])
            log.info('jhwx: lightning: %d strike(s) within %d km in 5 min (%s; %d token(s))',
                     summary['count'], cfg['radius_km'], reason, xw.tokens)
        except Exception as e:     # network, 401, quota: carry on without strikes
            error = _clean(e, secrets)
            log.error('jhwx: lightning query failed: %s', error)
            retry_after = now + 1800
        b['day_used'] += xw.tokens
        b['month_used'] += xw.tokens
    strikes = sorted((x for x in strikes if now - (x['t'] or 0) < KEEP_S), key=lambda x: -(x['t'] or 0))
    strikes = sorted(strikes[:MAX_KEPT], key=lambda x: x['km'])

    return json.dumps({
        'source': 'Xweather', 'radius_km': cfg['radius_km'], 'window_s': WINDOW_S, 'keep_s': KEEP_S,
        'checked': checked, 'summary': summary, 'fetched': fetched, 'strikes': strikes,
        'last_strike': last, 'watching': watching, 'reason': reason, 'every_s': every,
        'trigger': trig, 'budget': b, 'error': error, 'retry_after': retry_after,
    }, separators=(',', ':'))
