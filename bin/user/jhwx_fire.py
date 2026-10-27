"""Fire-danger inputs for the jhwx skin: Keetch-Byram drought index (KBDI) and
the McArthur drought factor, from the station's own daily rain and maximum
temperature.  The front end combines the drought factor with live temperature,
humidity and wind into the Forest Fire Danger Index (FFDI, Mark 5).

Indicative only: the official Australian Fire Danger Rating System uses fuel
models and gridded data a single station cannot reproduce.

  KBDI (metric, Crane 1982 as used by the Bureau of Meteorology), Q in mm 0-203.2:
    dQ = (203.2 - Q)(0.968 exp(0.0875 T + 1.5552) - 8.30) / (1 + 10.88 exp(-0.001736 R)) x 1e-3
    T = daily max (C), R = mean annual rainfall (mm).  Rain reduces Q after
    the first 5 mm of each spell of consecutive rain days.
  Drought factor (Griffiths 1999), 0-10:
    DF = 10.5 (1 - exp(-(I + 30) / 40)) (41 x^2 + x) / (40 x^2 + x + 1)
    x from the most significant rain event (days > 2 mm) in the last 20 days.
"""

import math
import time

import weeutil.weeutil

SPINUP_DAYS = 730          # KBDI starts at 0 this far back
EVENT_DAYS = 20            # rain events considered for the drought factor
EVENT_MM = 2.0             # a day counts toward a rain event above this
SPELL_LOSS_MM = 5.0        # first rain of a spell that never reaches the soil
KBDI_MAX = 203.2


def _kbdi_step(q, tmax, annual):
    if tmax is None:
        return q
    d = (KBDI_MAX - q) * (0.968 * math.exp(0.0875 * tmax + 1.5552) - 8.30) \
        / (1.0 + 10.88 * math.exp(-0.001736 * annual)) * 1e-3
    return min(KBDI_MAX, q + max(0.0, d))


def drought_factor(kbdi, rains):
    """rains: daily rain (mm), oldest first, ending today (index -1)."""
    x = 1.0
    n = len(rains)
    i = 0
    while i < n:
        if (rains[i] or 0) <= EVENT_MM:
            i += 1
            continue
        j = i
        while j < n and (rains[j] or 0) > EVENT_MM:
            j += 1
        event = rains[i:j]
        p = sum(event)
        peak = i + event.index(max(event))
        age = n - 1 - peak            # days since the wettest day of the event
        a = (0.8 if age == 0 else age) ** 1.3
        x = min(x, a / (a + p - 2.0))
        i = j
    xlim = 1.0 / (1.0 + 0.1135 * kbdi) if kbdi < 20 else 75.0 / (270.525 - 1.267 * kbdi)
    x = min(x, xlim)
    df = 10.5 * (1.0 - math.exp(-(kbdi + 30.0) / 40.0)) * (41 * x * x + x) / (40 * x * x + x + 1)
    return max(0.0, min(10.0, df))


def fire_inputs(history, binding, now, days_out=400):
    """{"kbdi", "df", "annual_rain", "daily": {"days", "kbdi", "df"}} up to
    `now`.  `history` is a jhwx_history.History (unit conversion, daily
    tables).  Today counts its rain so far but not its heat (the day's
    maximum isn't known yet)."""
    mgr = history._mgr(binding)
    if 'rain' not in mgr.daykeys or 'outTemp' not in mgr.daykeys:
        return None
    today = weeutil.weeutil.startOfDay(now)
    start = weeutil.weeutil.startOfDay(today - SPINUP_DAYS * 86400 + 43200)

    rain = {}
    tmax = {}
    for row in mgr.genSql('SELECT dateTime, sum, count FROM %s_day_rain WHERE dateTime >= ? AND dateTime <= ?'
                          % mgr.table_name, (start, today)):
        if row[2]:
            rain[weeutil.weeutil.startOfDay(row[0] + 43200)] = history._conv(mgr, 'rain', row[1]) or 0.0
    for row in mgr.genSql('SELECT dateTime, max, count FROM %s_day_outTemp WHERE dateTime >= ? AND dateTime <= ?'
                          % mgr.table_name, (start, today)):
        if row[2]:
            tmax[weeutil.weeutil.startOfDay(row[0] + 43200)] = history._conv(mgr, 'outTemp', row[1])

    # mean annual rainfall over every complete day on record
    row = mgr.getSql('SELECT SUM(sum), COUNT(*) FROM %s_day_rain WHERE count > 0 AND dateTime < ?'
                     % mgr.table_name, (today,))
    annual = None
    if row and row[1] and row[1] >= 365:
        annual = history._conv(mgr, 'rain', row[0]) / row[1] * 365.25
    if not annual:
        annual = 700.0   # southern Victoria-ish fallback until a year is on record

    days = [s.start for s in weeutil.weeutil.genDaySpans(start, today + 43200)]
    q = 0.0
    spell = 0.0
    out_days, out_kbdi, out_df, rains = [], [], [], []
    for d in days:
        p = rain.get(d, 0.0)
        if p > 0:
            prev = spell
            spell += p
            q = max(0.0, q - (max(0.0, spell - SPELL_LOSS_MM) - max(0.0, prev - SPELL_LOSS_MM)))
        else:
            spell = 0.0
        if d < today:
            q = _kbdi_step(q, tmax.get(d), annual)
        rains.append(p)
        df = drought_factor(q, rains[-EVENT_DAYS:])
        out_days.append(d)
        out_kbdi.append(round(q, 1))
        out_df.append(round(df, 1))

    keep = slice(-days_out, None)
    return {
        'kbdi': out_kbdi[-1],
        'df': out_df[-1],
        'annual_rain': round(annual, 0),
        'daily': {'days': out_days[keep], 'kbdi': out_kbdi[keep], 'df': out_df[keep]},
    }
