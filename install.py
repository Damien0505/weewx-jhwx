"""Installer for the jhwx skin (Jepps Hill weather UI).

    weectl extension install /path/to/weewx_skin        (or a .zip of it)

Adds the report [StdReport][[jhwx]] writing to <HTML_ROOT>/wx (public_html/wx
on a default install).  The web server still has to serve that directory at
/wx/ and proxy /wx/mqtt to Mosquitto's websocket listener - see README.md.
"""

from weecfg.extension import ExtensionInstaller

VERSION = '0.1.0'


def loader():
    return JhwxInstaller()


# Every installed file, grouped by destination directory.  Static on purpose:
# weectl re-imports a saved copy of this file to uninstall, away from the skin
# tree.  Regenerate with tools/gen_filelist.py after adding or removing files.
FILES = [
    ('bin/user', [
        'bin/user/jhwx.py',
        'bin/user/jhwx_fire.py',
        'bin/user/jhwx_history.py',
        'bin/user/jhwx_lightning.py',
        'bin/user/jhwx_mslp.py',
    ]),
    ('skins/jhwx', [
        'skins/jhwx/index.html',
        'skins/jhwx/skin.conf',
    ]),
    ('skins/jhwx/NOAA', [
        'skins/jhwx/NOAA/NOAA-%Y-%m.txt.tmpl',
        'skins/jhwx/NOAA/NOAA-%Y.txt.tmpl',
    ]),
    ('skins/jhwx/css', [
        'skins/jhwx/css/app.css',
    ]),
    ('skins/jhwx/data', [
        'skins/jhwx/data/almanac.json.tmpl',
        'skins/jhwx/data/astro.json.tmpl',
        'skins/jhwx/data/config.json.tmpl',
        'skins/jhwx/data/current.json.tmpl',
        'skins/jhwx/data/day.json.tmpl',
        'skins/jhwx/data/fire.json.tmpl',
        'skins/jhwx/data/lightning.json.tmpl',
        'skins/jhwx/data/month.json.tmpl',
        'skins/jhwx/data/mslp.json.tmpl',
        'skins/jhwx/data/noaa-index.json.tmpl',
        'skins/jhwx/data/week.json.tmpl',
        'skins/jhwx/data/year.json.tmpl',
    ]),
    ('skins/jhwx/fonts', [
        'skins/jhwx/fonts/OFL-Barlow.txt',
        'skins/jhwx/fonts/OFL-IBMPlexMono.txt',
        'skins/jhwx/fonts/barlow-400.woff2',
        'skins/jhwx/fonts/barlow-500.woff2',
        'skins/jhwx/fonts/barlow-600.woff2',
        'skins/jhwx/fonts/barlow-700.woff2',
        'skins/jhwx/fonts/ibm-plex-mono-400.woff2',
        'skins/jhwx/fonts/ibm-plex-mono-500.woff2',
    ]),
    ('skins/jhwx/img', [
        'skins/jhwx/img/apple-touch-icon.png',
        'skins/jhwx/img/favicon-32.png',
        'skins/jhwx/img/favicon.ico',
        'skins/jhwx/img/icon-192.png',
        'skins/jhwx/img/logo.png',
        'skins/jhwx/img/moon.jpg',
    ]),
    ('skins/jhwx/js', [
        'skins/jhwx/js/conditions.js',
        'skins/jhwx/js/data.js',
        'skins/jhwx/js/fire.js',
        'skins/jhwx/js/forecast.js',
        'skins/jhwx/js/gauges.js',
        'skins/jhwx/js/hero.js',
        'skins/jhwx/js/history.js',
        'skins/jhwx/js/icons.js',
        'skins/jhwx/js/layout.js',
        'skins/jhwx/js/live.js',
        'skins/jhwx/js/main.js',
        'skins/jhwx/js/maps.js',
        'skins/jhwx/js/mslp.js',
        'skins/jhwx/js/radarstats.js',
        'skins/jhwx/js/sunmoon.js',
        'skins/jhwx/js/theme.js',
        'skins/jhwx/js/tiles.js',
        'skins/jhwx/js/trend.js',
        'skins/jhwx/js/units.js',
    ]),
    ('skins/jhwx/js/vendor', [
        'skins/jhwx/js/vendor/mqtt-5.10.1.min.js',
        'skins/jhwx/js/vendor/mqtt-LICENSE.md',
    ]),
    ('skins/jhwx/js/vendor/leaflet-1.9.4', [
        'skins/jhwx/js/vendor/leaflet-1.9.4/LICENSE.txt',
        'skins/jhwx/js/vendor/leaflet-1.9.4/leaflet.css',
        'skins/jhwx/js/vendor/leaflet-1.9.4/leaflet.js',
    ]),
]


class JhwxInstaller(ExtensionInstaller):
    def __init__(self):
        super(JhwxInstaller, self).__init__(
            version=VERSION,
            name='jhwx',
            description='Jepps Hill weather UI: live MQTT dashboard with history, almanac and NOAA reports',
            author='Damien Beeby',
            config={
                'StdReport': {
                    'jhwx': {
                        'skin': 'jhwx',
                        'enable': 'true',
                        # relative to [StdReport] HTML_ROOT, so public_html/wx
                        # on a default install
                        'HTML_ROOT': 'wx',
                        # [StdReport][[Defaults]] (often unit_system = metricwx)
                        # overrides a skin's own [Units], so the units the
                        # front end relies on are pinned here, in the report.
                        'unit_system': 'METRIC',
                        'Units': {
                            'Groups': {
                                'group_altitude': 'meter',
                                'group_distance': 'km',
                                'group_pressure': 'hPa',
                                'group_rain': 'mm',
                                'group_rainrate': 'mm_per_hour',
                                'group_speed': 'km_per_hour',
                                'group_speed2': 'km_per_hour2',
                                'group_temperature': 'degree_C',
                            }
                        },
                    }
                }
            },
            files=FILES,
        )
