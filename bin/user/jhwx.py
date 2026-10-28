"""Search-list extension for the jhwx skin.

Adds a ``$jhwx`` object to the skin's templates with small helpers for writing
JSON from Cheetah, plus skin settings resolved to the values the front end
needs (epoch times, bindings).

    $jhwx.num($current.outTemp)      -> 12.3 or null
    $jhwx.num($day.outTemp.maxtime)  -> epoch seconds or null
    $jhwx.str("text")                -> "text" (JSON-quoted)
    $jhwx.now                        -> epoch of the newest live record

Also adds ``$live``: $day, $yesterday, $span... anchored at that record.
"""

import json
import logging
import os
import time

import weeutil.weeutil
import weewx.tags
import weewx.units
from weewx.cheetahgenerator import SearchList

from user.jhwx_history import History
from user import jhwx_mslp
from user import jhwx_lightning
from user import jhwx_fire

log = logging.getLogger(__name__)

VERSION = '0.1.0'

# What the front end assumes every generated JSON value is in.
EXPECTED_UNITS = {
    'outTemp': 'degree_C',
    'barometer': 'hPa',
    'windSpeed': 'km_per_hour',
    'windGust': 'km_per_hour',
    'rain': 'mm',
    'rainRate': 'mm_per_hour',
    'altitude': 'meter',
    'cloudbase': 'meter',
    'windrun': 'km',
}


def _float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _bounds(v):
    """'north, south, west, east' (configobj gives a list) or None."""
    if not v:
        return None
    if isinstance(v, str):
        v = v.split(',')
    v = [x for x in v if str(x).strip()]
    return v if len(v) == 4 else None


def _local_epoch(text):
    """'2026-10-24 19:45' (station local time) -> epoch seconds."""
    return int(time.mktime(time.strptime(text.strip(), '%Y-%m-%d %H:%M')))


class JhwxHelper(object):

    def __init__(self, generator):
        extras = generator.skin_dict.get('Extras', {})
        self.version = VERSION
        self.now = None          # newest live record, set each report run
        self.live_binding = extras.get('live_binding', 'wx_binding')
        self.history_binding = generator.skin_dict.get('data_binding', 'wx_binding')
        self.mqtt_url = extras.get('mqtt_url', 'mqtt')
        self.mqtt_topic = extras.get('mqtt_topic', 'weather/loop')
        self.cutover = _local_epoch(extras['cutover']) if extras.get('cutover') else None
        self.record_cutoff = {k: _local_epoch(v)
                              for k, v in extras.get('record_cutoff', {}).items()}
        self._db_binder = generator.db_binder
        self._converter = weewx.units.Converter.fromSkinDict(generator.skin_dict)
        self._db_lookup = generator.db_binder.bind_default(self.history_binding)
        power = extras.get('power', {})
        self.power = {}
        for key, label, rng in (('supercap', 'Supercap', ('supercap_min', 'supercap_max')),
                                ('battery', 'Backup battery', ('battery_min', 'battery_max'))):
            field = (power.get(key) or '').strip()
            if field:
                self.power[key] = {
                    'field': field,
                    'label': power.get(key + '_label', label),
                    'min': _float(power.get(rng[0]), 0.0 if key == 'supercap' else 2.0),
                    'max': _float(power.get(rng[1]), 6.0 if key == 'supercap' else 3.6),
                }
        if 'supercap' in self.power:
            self.power['supercap']['low'] = _float(power.get('supercap_low'), 2.5)
        if 'battery' in self.power:
            self.power['battery']['low'] = _float(power.get('battery_low'), None)
            self.power['battery']['fair'] = _float(power.get('battery_fair'), None)
        self.power_fields = [v['field'] for v in self.power.values()]
        self._history = History(self._db_binder, self._converter, self.record_cutoff, self.power_fields)
        fire = extras.get('fire_danger', {})
        self.fire_enabled = weeutil.weeutil.to_bool(fire.get('enable', False))
        self.fire_info = {k: fire.get(k, '') for k in ('info_name', 'info_url', 'info_extra')}
        # [[mslp]] subsection; a plain "mslp = false" (older skin.conf) still works
        mslp = extras.get('mslp', {})
        if not isinstance(mslp, dict):
            mslp = {'enable': mslp}
        self.mslp_enabled = weeutil.weeutil.to_bool(mslp.get('enable', True))
        self.mslp_chart = {'name': mslp.get('chart_name', ''), 'url': mslp.get('chart_url', '')}
        stn = generator.stn_info
        self.mslp_bounds = jhwx_mslp.bounds_for(stn.latitude_f, stn.longitude_f, _bounds(mslp.get('bounds')))
        self._fire = (None, None)   # (now, result) - one computation per run
        self._mslp_path = os.path.join(generator.config_dict['WEEWX_ROOT'],
                                       generator.skin_dict['HTML_ROOT'], 'data', 'mslp.json')
        # [[lightning]]: Xweather strikes; the credentials belong in weewx.conf
        ltg = extras.get('lightning', {})
        self._lightning = {
            'enabled': weeutil.weeutil.to_bool(ltg.get('enable', False)),
            'client_id': (ltg.get('client_id') or '').strip(),
            'client_secret': (ltg.get('client_secret') or '').strip(),
            'radius_km': int(_float(ltg.get('radius_km'), 100)),
            'daily_tokens': int(_float(ltg.get('daily_tokens'), 480)),
            'monthly_tokens': int(_float(ltg.get('monthly_tokens'), 14000)),
            'cape': _float(ltg.get('cape'), 500.0),
        }
        self._station = (stn.latitude_f, stn.longitude_f)
        self._lightning_path = os.path.join(os.path.dirname(self._mslp_path), 'lightning.json')

    @staticmethod
    def num(value, places=None):
        """A tag value (ValueHelper, aggregate binder), ValueTuple or plain
        number as a JSON number or null."""
        if isinstance(value, weewx.units.ValueTuple):
            value = value[0]
        elif not isinstance(value, (int, float, str)) and value is not None:
            # $current.x is a ValueHelper; $day.x.max an AggTypeBinder - both
            # give the value in the skin's target unit via .raw
            value = getattr(value, 'raw', value)
        if value is None:
            return 'null'
        if isinstance(value, bool):
            return 'true' if value else 'false'
        if isinstance(value, int):
            return str(value)
        try:
            value = float(value)
        except (TypeError, ValueError):
            return 'null'
        if value != value or value in (float('inf'), float('-inf')):
            return 'null'
        if places is not None:
            value = round(value, places)
            if places == 0:
                return str(int(value))
        return repr(value)

    def units(self, unit):
        """JSON "units" tag from the units the report actually uses: "metric"
        when they match what the front end expects, else a description of the
        mismatch so the UI can refuse to show wrong numbers."""
        wrong = ['%s=%s' % (obs, getattr(unit.unit_type, obs))
                 for obs, want in EXPECTED_UNITS.items()
                 if getattr(unit.unit_type, obs) != want]
        if wrong:
            log.error("jhwx: report units are not the expected metric set: %s", ', '.join(wrong))
            return json.dumps('mismatch: ' + ', '.join(wrong))
        return '"metric"'

    @staticmethod
    def str(value):
        return json.dumps(None if value is None else '%s' % value)

    def mslp(self):
        """data/mslp.json: the MSLP grid, refreshed from Open-Meteo every few
        hours (Extras mslp = false turns this off)."""
        return jhwx_mslp.mslp_json(self._mslp_path, self.mslp_enabled, 'jhwx-weewx-skin/%s' % VERSION,
                                   self.mslp_bounds)

    def lightning(self):
        """data/lightning.json: Xweather strikes, queried only while a storm
        is likely (see bin/user/jhwx_lightning.py)."""
        return jhwx_lightning.lightning_json(self._lightning_path, self._lightning, *self._station,
                                             user_agent='jhwx-weewx-skin/%s' % VERSION)

    def client_options(self):
        """Install options the page needs (config.json): voltage readings,
        fire danger, pressure-chart link."""
        return json.dumps({
            'power': self.power,
            'fire': dict(self.fire_info, enabled=self.fire_enabled),
            'mslp': {'enabled': self.mslp_enabled, 'chart_name': self.mslp_chart['name'],
                     'chart_url': self.mslp_chart['url']},
            'lightning': {'enabled': bool(self._lightning['enabled'] and self._lightning['client_secret'])},
        }, separators=(',', ':'))

    def history_start(self):
        """Epoch of the first record in the history binding."""
        return self._db_lookup().firstGoodStamp()

    def series(self, binding, fields, start, stop, places=2):
        """Raw archive rows between two epochs as compact JSON:
        {"t": [epoch...], "interval": [min...], "<field>": [value|null ...]}.
        Values are converted to the report's units.  Gaps stay as nulls (one
        entry per stored record), so charts can break lines at them."""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        mgr = self._db_binder.get_manager(binding)
        fields = [f for f in fields if f in mgr.sqlkeys]
        cols = ', '.join('`%s`' % f for f in fields)
        out = {'t': [], 'interval': []}
        out.update((f, []) for f in fields)
        cutoff = self.record_cutoff
        for row in mgr.genSql('SELECT dateTime, usUnits, `interval`, %s FROM %s '
                              'WHERE dateTime > ? AND dateTime <= ? ORDER BY dateTime'
                              % (cols, mgr.table_name), (start, stop)):
            ts, us_units, interval = row[0], row[1], row[2]
            out['t'].append(ts)
            out['interval'].append(interval)
            for f, v in zip(fields, row[3:]):
                if f in cutoff and ts <= cutoff[f]:
                    v = None       # before this reading's cutoff (faulty old sensor)
                if v is not None:
                    vt = weewx.units.as_value_tuple({f: v, 'usUnits': us_units}, f)
                    v = self._converter.convert(vt)[0]
                    if v is not None:
                        v = round(v, places)
                out[f].append(v)
        return json.dumps(out, separators=(',', ':'))

    def binned(self, binding, fields, start, stop, bin_s, places=2):
        """Archive values averaged into fixed bins (week charts) as compact
        JSON: {"t": [bin start...], "bin": s, "<field>": [...]}.  Rain is
        summed per bin and gusts take the bin maximum; empty bins are null,
        as are readings before their record cutoff."""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        mgr = self._db_binder.get_manager(binding)
        fields = [f for f in fields if f in mgr.sqlkeys]
        n = int((stop - start) // bin_s)
        t0 = stop - n * bin_s
        acc = {f: [[] for _ in range(n)] for f in fields}
        cols = ', '.join('`%s`' % f for f in fields)
        for row in mgr.genSql('SELECT dateTime, usUnits, %s FROM %s WHERE dateTime > ? AND dateTime <= ?'
                              % (cols, mgr.table_name), (t0, stop)):
            k = int((row[0] - 1 - t0) // bin_s)
            if not 0 <= k < n:
                continue
            for f, v in zip(fields, row[2:]):
                if f in self.record_cutoff and row[0] <= self.record_cutoff[f]:
                    continue
                if v is not None:
                    vt = weewx.units.as_value_tuple({f: v, 'usUnits': row[1]}, f)
                    v = self._converter.convert(vt)[0]
                    if v is not None:
                        acc[f][k].append(v)
        out = {'t': [t0 + k * bin_s for k in range(n)], 'bin': bin_s}
        for f in fields:
            agg = sum if f in ('rain', 'ET') else max if f == 'windGust' else (lambda a: sum(a) / len(a))
            out[f] = [round(agg(a), places) if a else None for a in acc[f]]
        return json.dumps(out, separators=(',', ':'))

    def total(self, binding, obs, start, stop):
        """Sum of obs over (start, stop] as a JSON number, honouring the
        record cutoff (e.g. ET from a faulty solar sensor)."""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        return self.num(self._history._sum(self._db_binder.get_manager(binding), obs, start, stop))

    def fire(self, key=None):
        """Fire-danger inputs (KBDI, drought factor) from the history
        binding, up to the newest live record.  `key` picks one value
        ('df', 'kbdi', ...) for a JSON number; without it, the whole dict."""
        if not self.fire_enabled:
            return 'null'
        if self._fire[0] != self.now:
            try:
                res = jhwx_fire.fire_inputs(self._history, self.history_binding, self.now)
            except Exception as e:      # never break the report over this
                log.error("jhwx: fire danger inputs failed: %s", e)
                res = None
            self._fire = (self.now, res)
        res = self._fire[1]
        if key:
            return self.num(res.get(key) if res else None)
        return json.dumps(res, separators=(',', ':'))

    def daily(self, binding, start, stop):
        """Per-day aggregates (month/year charts) as compact JSON."""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        return json.dumps(self._history.daily(binding, start, stop), separators=(',', ':'))

    def almanac(self, now):
        """Almanac values: today from the live binding, the rest from history."""
        now = getattr(now, 'raw', now)
        return json.dumps(self._history.almanac(self.live_binding, self.history_binding, now),
                          separators=(',', ':'))

    def uv_window(self, binding, start, stop):
        """{"from": epoch, "to": epoch} when UV was >= 3 (sun protection
        advised) between two epochs, as JSON."""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        first, last = self._history._uv_window(self._db_binder.get_manager(binding), start, stop)
        return json.dumps({'from': first, 'to': last})

    def last_nonzero(self, binding, field, stop):
        """Epoch of the newest record at or before `stop` where field > 0
        (e.g. time of last rain), or None."""
        stop = getattr(stop, 'raw', stop)
        mgr = self._db_binder.get_manager(binding)
        if field not in mgr.sqlkeys:
            return None
        row = mgr.getSql('SELECT MAX(dateTime) FROM %s WHERE `%s` > 0 AND dateTime <= ?'
                         % (mgr.table_name, field), (stop,))
        return row[0] if row else None

    def solar_energy(self, binding, start, stop):
        """Solar energy in Wh/m² between two epochs: sum of radiation (W/m²)
        x record interval (min) / 60.  Works for mixed 1- and 5-minute
        records.  (WeeWX 5.5 has no energy_integral aggregate.)"""
        start = getattr(start, 'raw', start)
        stop = getattr(stop, 'raw', stop)
        if start is None or stop is None:
            return None
        mgr = self._db_binder.get_manager(binding)
        row = mgr.getSql('SELECT SUM(radiation * `interval`) / 60.0, COUNT(radiation) FROM %s '
                         'WHERE dateTime > ? AND dateTime <= ?' % mgr.table_name, (start, stop))
        return row[0] if row and row[1] else None


class JhwxSearch(SearchList):

    def __init__(self, generator):
        SearchList.__init__(self, generator)
        self.helper = JhwxHelper(generator)

    def get_extension_list(self, timespan, db_lookup):
        # WeeWX anchors $current, $day, $span... at the last record of the
        # report's data_binding.  When history comes from another database
        # (a snapshot while testing) that time is wrong for live values, so
        # $live is the same set of tags anchored at the live binding's newest
        # record.  With one database for both, $live.day is just $day.
        gen = self.generator
        live_ts = gen.db_binder.get_manager(self.helper.live_binding).lastGoodStamp() \
            or timespan.stop
        self.helper.now = live_ts
        try:
            trend_dict = gen.skin_dict['Units']['Trend']
        except KeyError:
            trend_dict = {'time_delta': 10800, 'time_grace': 300}
        live = weewx.tags.TimeBinder(
            gen.db_binder.bind_default(self.helper.live_binding),
            live_ts,
            formatter=gen.formatter,
            converter=gen.converter,
            week_start=gen.stn_info.week_start,
            rain_year_start=gen.stn_info.rain_year_start,
            lat=gen.stn_info.latitude_f,
            lon=gen.stn_info.longitude_f,
            trend=trend_dict,
            skin_dict=gen.skin_dict)
        return [{'jhwx': self.helper, 'live': live}]
