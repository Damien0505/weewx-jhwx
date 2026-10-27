"""History queries for the jhwx skin: daily aggregates (month/year charts) and
the almanac (today / month / year / station record per reading).

Daily values come from WeeWX's daily summary tables (archive_day_<obs>), which
are fast even over many years.  Readings with a record cutoff (e.g. faulty
HP1000 solar/UV, offset barometer) are read from the archive table from the
cutoff time instead, for every period that starts before it.

All values are converted to the report's units with its Converter; times are
epoch seconds.  Callers get plain dicts ready for json.dumps().
"""

import datetime
import math
import time

import weewx.units
import weeutil.weeutil

RAIN_DAY_MM = 0.2          # a "rain day": at least this much in the day
UV_EXTREME = 11            # "days UVI 11+"
UV_PROTECT = 3             # sun protection advised from UVI 3

# Daily chart fields: which aggregates each one needs.
DAILY_FIELDS = {
    'outTemp': ('min', 'max', 'avg'),
    'dewpoint': ('min', 'max', 'avg'),
    'outHumidity': ('min', 'max', 'avg'),
    'barometer': ('min', 'max', 'avg'),
    'inTemp': ('min', 'max', 'avg'),
    'inHumidity': ('min', 'max', 'avg'),
    'windSpeed': ('max', 'avg'),
    'windGust': ('max',),
    'rain': ('sum',),
    'ET': ('sum',),
    'rainRate': ('max',),
    'radiation': ('max', 'energy'),
    'UV': ('max',),
}
# Extra readings (the [[power]] voltage fields) get these aggregates.
EXTRA_AGGS = ('min', 'max', 'avg')


class History(object):

    def __init__(self, db_binder, converter, record_cutoff, extra_fields=()):
        self.db_binder = db_binder
        self.converter = converter
        self.cutoff = dict(record_cutoff)
        self.extra = [f for f in extra_fields if f and f not in DAILY_FIELDS]
        self.daily_fields = dict(DAILY_FIELDS, **{f: EXTRA_AGGS for f in self.extra})

    # ------------------------------------------------------------ helpers
    def _mgr(self, binding):
        return self.db_binder.get_manager(binding)

    def _conv(self, mgr, obs, value, places=2):
        if value is None:
            return None
        vt = weewx.units.as_value_tuple({obs: value, 'usUnits': mgr.std_unit_system}, obs)
        v = self.converter.convert(vt)[0]
        return None if v is None else round(v, places)

    @staticmethod
    def _has_day_table(mgr, obs):
        return obs in mgr.daykeys

    @staticmethod
    def _day_start(ts):
        return weeutil.weeutil.startOfDay(ts)

    def _effective_start(self, obs, start):
        """Start of a period for this reading, moved forward to its cutoff."""
        c = self.cutoff.get(obs)
        return max(start, c) if c else start

    # -------------------------------------------------------- daily series
    def daily(self, binding, start, stop):
        """Per-day aggregates for [start, stop): {"days": [epoch...],
        "<obs>": {"min": [...], "max": [...], "avg": [...], ...}, "windDir": [...]}.
        Days before a reading's cutoff are null for that reading."""
        mgr = self._mgr(binding)
        days = [span.start for span in weeutil.weeutil.genDaySpans(start, stop)]
        index = {d: i for i, d in enumerate(days)}
        out = {'days': days}
        for obs, aggs in self.daily_fields.items():
            if not self._has_day_table(mgr, obs):
                continue
            cols = {k: [None] * len(days) for k in aggs}
            cutoff_day = self._day_start(self.cutoff[obs]) if obs in self.cutoff else None
            for row in mgr.genSql('SELECT dateTime, min, max, sum, count, wsum, sumtime '
                                  'FROM %s_day_%s WHERE dateTime >= ? AND dateTime < ?'
                                  % (mgr.table_name, obs), (days[0] if days else start, stop)):
                i = index.get(row[0])
                if i is None or not row[4]:
                    continue
                if cutoff_day is not None and row[0] <= cutoff_day:
                    continue   # the cutover day itself is mixed: leave it out
                d_min, d_max, d_sum, d_count, d_wsum, d_sumtime = row[1:]
                for k in aggs:
                    if k == 'min':
                        cols[k][i] = self._conv(mgr, obs, d_min)
                    elif k == 'max':
                        cols[k][i] = self._conv(mgr, obs, d_max)
                    elif k == 'avg':
                        avg = d_wsum / d_sumtime if d_sumtime else d_sum / d_count
                        cols[k][i] = self._conv(mgr, obs, avg)
                    elif k == 'sum':
                        cols[k][i] = self._conv(mgr, obs, d_sum)
                    elif k == 'energy':
                        # wsum = sum(value x interval seconds) -> Wh/m²
                        cols[k][i] = round(d_wsum / 3600.0, 1) if d_wsum is not None else None
            out[obs] = cols
        if self._has_day_table(mgr, 'wind'):
            dirs = [None] * len(days)
            for row in mgr.genSql('SELECT dateTime, xsum, ysum FROM %s_day_wind '
                                  'WHERE dateTime >= ? AND dateTime < ?' % mgr.table_name,
                                  (days[0] if days else start, stop)):
                i = index.get(row[0])
                if i is not None and row[1] is not None and (row[1] or row[2]):
                    dirs[i] = round(math.degrees(math.atan2(row[1], row[2])) % 360, 0)
            out['windDir'] = dirs
        return out

    # ------------------------------------------------------------ almanac
    def _extreme(self, mgr, obs, start, stop, which):
        """(value, time) of the highest ('max') or lowest ('min') value of obs
        in [start, stop), honouring the cutoff."""
        start = self._effective_start(obs, start)
        if start >= stop or obs not in mgr.sqlkeys:
            return None, None
        order = 'DESC' if which == 'max' else 'ASC'
        if obs in self.cutoff or not self._has_day_table(mgr, obs) \
                or start != self._day_start(start):
            row = mgr.getSql('SELECT `%s`, dateTime FROM %s WHERE dateTime > ? AND dateTime <= ? '
                             'AND `%s` IS NOT NULL ORDER BY `%s` %s, dateTime LIMIT 1'
                             % (obs, mgr.table_name, obs, obs, order), (start, stop))
        else:
            row = mgr.getSql('SELECT %s, %stime FROM %s_day_%s WHERE dateTime >= ? AND dateTime < ? '
                             'AND %s IS NOT NULL ORDER BY %s %s, dateTime LIMIT 1'
                             % (which, which, mgr.table_name, obs, which, which, order), (start, stop))
        if not row or row[0] is None:
            return None, None
        return self._conv(mgr, obs, row[0]), row[1]

    def _mean(self, mgr, obs, start, stop):
        start = self._effective_start(obs, start)
        if start >= stop or not self._has_day_table(mgr, obs):
            return None
        if obs in self.cutoff or start != self._day_start(start):
            row = mgr.getSql('SELECT SUM(`%s` * `interval`), SUM(`interval`) FROM %s '
                             'WHERE dateTime > ? AND dateTime <= ? AND `%s` IS NOT NULL'
                             % (obs, mgr.table_name, obs), (start, stop))
        else:
            row = mgr.getSql('SELECT SUM(wsum), SUM(sumtime) FROM %s_day_%s '
                             'WHERE dateTime >= ? AND dateTime < ?' % (mgr.table_name, obs),
                             (start, stop))
        if not row or not row[1]:
            return None
        return self._conv(mgr, obs, row[0] / row[1])

    def _sum(self, mgr, obs, start, stop):
        start = self._effective_start(obs, start)
        if start >= stop or obs not in mgr.sqlkeys:
            return None
        if obs not in self.cutoff and self._has_day_table(mgr, obs) and start == self._day_start(start):
            row = mgr.getSql('SELECT SUM(sum), SUM(count) FROM %s_day_%s WHERE dateTime >= ? AND dateTime < ?'
                             % (mgr.table_name, obs), (start, stop))
            return self._conv(mgr, obs, row[0]) if row and row[1] else None
        row = mgr.getSql('SELECT SUM(`%s`), COUNT(`%s`) FROM %s WHERE dateTime > ? AND dateTime <= ?'
                         % (obs, obs, mgr.table_name), (start, stop))
        if not row or not row[1]:
            return None
        return self._conv(mgr, obs, row[0])

    def _energy_kwh(self, mgr, start, stop):
        start = self._effective_start('radiation', start)
        if start >= stop or 'radiation' not in mgr.sqlkeys:
            return None
        row = mgr.getSql('SELECT SUM(radiation * `interval`) / 60.0, COUNT(radiation) FROM %s '
                         'WHERE dateTime > ? AND dateTime <= ?' % mgr.table_name, (start, stop))
        return round(row[0] / 1000.0, 2) if row and row[1] else None

    def _daily_sums(self, mgr, obs, start, stop):
        """[(day, sum)] from the daily summaries, converted."""
        if not self._has_day_table(mgr, obs):
            return []
        start = self._effective_start(obs, start)
        if obs in self.cutoff:
            start = self._day_start(start) + 86400
        return [(r[0], self._conv(mgr, obs, r[1]))
                for r in mgr.genSql('SELECT dateTime, sum FROM %s_day_%s WHERE dateTime >= ? '
                                    'AND dateTime < ? AND count > 0' % (mgr.table_name, obs),
                                    (self._day_start(start), stop))]

    def _daily_max(self, mgr, obs, start, stop):
        if not self._has_day_table(mgr, obs):
            return []
        start = self._effective_start(obs, start)
        if obs in self.cutoff:
            start = self._day_start(start) + 86400
        return [(r[0], self._conv(mgr, obs, r[1]))
                for r in mgr.genSql('SELECT dateTime, max FROM %s_day_%s WHERE dateTime >= ? '
                                    'AND dateTime < ? AND count > 0' % (mgr.table_name, obs),
                                    (self._day_start(start), stop))]

    def _dominant_dir(self, mgr, start, stop):
        if not self._has_day_table(mgr, 'wind'):
            return None
        row = mgr.getSql('SELECT SUM(xsum), SUM(ysum) FROM %s_day_wind WHERE dateTime >= ? AND dateTime < ?'
                         % mgr.table_name, (self._day_start(start), stop))
        if not row or row[0] is None or (not row[0] and not row[1]):
            return None
        return round(math.degrees(math.atan2(row[0], row[1])) % 360, 0)

    def _gust(self, mgr, start, stop):
        """(value, time, direction) of the highest gust."""
        if self._has_day_table(mgr, 'wind') and start == self._day_start(start):
            row = mgr.getSql('SELECT max, maxtime, max_dir FROM %s_day_wind WHERE dateTime >= ? AND dateTime < ? '
                             'AND max IS NOT NULL ORDER BY max DESC LIMIT 1' % mgr.table_name, (start, stop))
            if row and row[0] is not None:
                return self._conv(mgr, 'windGust', row[0]), row[1], row[2]
        v, t = self._extreme(mgr, 'windGust', start, stop, 'max')
        return v, t, None

    def _uv_window(self, mgr, start, stop):
        """First and last time UV >= UV_PROTECT in [start, stop)."""
        start = self._effective_start('UV', start)
        if start >= stop or 'UV' not in mgr.sqlkeys:
            return None, None
        row = mgr.getSql('SELECT MIN(dateTime), MAX(dateTime) FROM %s WHERE dateTime > ? AND dateTime <= ? '
                         'AND UV >= ?' % mgr.table_name, (start, stop, UV_PROTECT))
        return (row[0], row[1]) if row else (None, None)

    def _period(self, mgr, start, stop, today=False, record=False):
        """Every almanac value for one period.  The all-time record period
        skips totals and means (shown as "—")."""
        p = {}
        for obs in ['outTemp', 'dewpoint', 'outHumidity', 'barometer', 'inTemp', 'inHumidity',
                    'windSpeed', 'rainRate', 'radiation', 'UV'] + self.extra:
            hi, hi_t = self._extreme(mgr, obs, start, stop, 'max')
            entry = {'max': hi, 'maxtime': hi_t}
            if obs not in ('windSpeed', 'rainRate', 'radiation', 'UV'):
                lo, lo_t = self._extreme(mgr, obs, start, stop, 'min')
                entry.update(min=lo, mintime=lo_t,
                             avg=None if record else self._mean(mgr, obs, start, stop))
            p[obs] = entry
        g, g_t, g_dir = self._gust(mgr, start, stop)
        p['windGust'] = {'max': g, 'maxtime': g_t, 'dir': g_dir}
        p['rain'] = {}
        if not record:
            p['windrun'] = {'sum': self._sum(mgr, 'windrun', start, stop)}
            p['windDir'] = {'dominant': self._dominant_dir(mgr, start, stop)}
            p['rain']['sum'] = self._sum(mgr, 'rain', start, stop)
            p['radiation']['energy_kwh'] = self._energy_kwh(mgr, start, stop)
            et = self._sum(mgr, 'ET', start, stop)
            p['ET'] = {'sum': et}
            if et is not None and p['rain']['sum'] is not None:
                # water balance over the same (cut-off) span as the ET total
                rain = self._sum(mgr, 'rain', self._effective_start('ET', start), stop)
                p['ET']['balance'] = None if rain is None else round(rain - et, 2)
        if not today:
            et_days = [d for d in self._daily_sums(mgr, 'ET', start, stop) if d[1] is not None]
            p.setdefault('ET', {})
            if et_days:
                day, amount = max(et_days, key=lambda d: d[1])
                p['ET']['highest'] = {'value': amount, 'time': day}
        if 'sunshine_time' in mgr.sqlkeys and not record:
            mins = mgr.getSql('SELECT SUM(sunshine_time) FROM %s WHERE dateTime > ? AND dateTime <= ?'
                              % mgr.table_name, (self._effective_start('radiation', start), stop))
            p['radiation']['sunshine_h'] = round(mins[0] / 60.0, 1) if mins and mins[0] is not None else None
        if today:
            first, last = self._uv_window(mgr, start, stop)
            p['UV']['protect_from'], p['UV']['protect_to'] = first, last
        else:
            rain_days = self._daily_sums(mgr, 'rain', start, stop)
            rain_min = self._conv_rain_threshold(mgr)
            wet = [d for d in rain_days if d[1] is not None and d[1] >= rain_min]
            p['rain']['days'] = len(wet)
            if wet:
                day, amount = max(wet, key=lambda d: d[1])
                p['rain']['wettest'] = {'value': amount, 'time': day}
            uv_days = self._daily_max(mgr, 'UV', start, stop)
            p['UV']['days_extreme'] = sum(1 for d in uv_days if d[1] is not None and d[1] >= UV_EXTREME)
        return p

    def _conv_rain_threshold(self, mgr):
        """RAIN_DAY_MM expressed in the report's rain unit (normally mm)."""
        vt = weewx.units.ValueTuple(RAIN_DAY_MM, 'mm', 'group_rain')
        return self.converter.convert(vt)[0]

    def almanac(self, live_binding, history_binding, now):
        """{"periods": {...}, "today": {...}, "month": {...}, "year": {...},
        "record": {...}} for the almanac grid."""
        hist = self._mgr(history_binding)
        live = self._mgr(live_binding)
        day0 = self._day_start(now)
        d = datetime.date.fromtimestamp(now)
        month0 = int(time.mktime(d.replace(day=1).timetuple()))
        year0 = int(time.mktime(d.replace(month=1, day=1).timetuple()))
        first = hist.firstGoodStamp() or year0
        tomorrow = day0 + 86400
        return {
            'periods': {
                'today': {'start': day0, 'stop': now},
                'month': {'start': month0, 'stop': now},
                'year': {'start': year0, 'stop': now},
                'record': {'start': first, 'stop': now},
            },
            'cutoff': self.cutoff,
            'today': self._period(live, day0, tomorrow, today=True),
            'month': self._period(hist, month0, tomorrow),
            'year': self._period(hist, year0, tomorrow),
            'record': self._period(hist, self._day_start(first), tomorrow, record=True),
        }
