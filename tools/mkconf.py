"""Build a temporary weewx.conf for dry-running the jhwx skin (see dev_run.sh).

    python mkconf.py LIVE_CONF OUT_CONF HTML_ROOT

OUT_CONF.epoch gets the time to run the report at (empty: latest).

The live config is only read.  The output gets the [StdReport][[jhwx]] section
exactly as install.py defines it, then the test overrides below.
"""

import os
import sys

import configobj

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import install  # noqa: E402  (the extension's own installer)

# Test CT only: the HP1000 broker websocket is at /mqtt (one level above /wx/),
# and history comes from the prod snapshot when that binding exists.
OVERRIDES = {
    'Extras': {
        'mqtt_url': '../mqtt',
        'station_short': 'HP1000',
        'subtitle': 'TEST · live: HP1000 · history: prod snapshot',
        'sensors': {'outdoor': 'HP1000', 'console': 'HP1000', 'rain': 'HP1000 bucket'},
        # as on prod (weewx.conf there), minus the WS90-only voltages
        'record_cutoff': {k: '2026-10-24 19:45' for k in ('radiation', 'UV', 'ET', 'barometer')},
        'fire_danger': {'enable': 'true', 'info_name': 'CFA',
                        'info_url': 'https://www.cfa.vic.gov.au/warnings-restrictions/fire-danger-ratings',
                        'info_extra': 'or the VicEmergency app'},
        'mslp': {'enable': 'true', 'bounds': ['-6', '-48', '102', '180'], 'chart_name': 'BoM synoptic chart',
                 'chart_url': 'https://www.bom.gov.au/australia/charts/synoptic_col.shtml'},
    },
}
SNAPSHOT_BINDING = 'jhwx_snapshot'
SNAPSHOT_FILE = 'jhwx-snapshot.sdb'          # in the archive directory

live, out, html_root = sys.argv[1:4]
c = configobj.ConfigObj(live, encoding='utf-8', interpolation=False, file_error=True)
c['WEEWX_ROOT'] = c.get('WEEWX_ROOT') or os.path.dirname(os.path.abspath(live))
c['StdReport']['SKIN_ROOT'] = os.path.join(REPO, 'skins')

report = install.JhwxInstaller()['config']['StdReport']['jhwx']
report['HTML_ROOT'] = html_root
report.update(OVERRIDES)

# History from the prod snapshot if it has been copied over.  The binding is
# added to this temporary config only, unless the live one already has it.
archive_dir = os.path.join(c['WEEWX_ROOT'], c['DatabaseTypes']['SQLite'].get('SQLITE_ROOT', 'archive'))
if SNAPSHOT_BINDING not in c.get('DataBindings', {}) and os.path.exists(os.path.join(archive_dir, SNAPSHOT_FILE)):
    c['Databases']['jhwx_snapshot_sqlite'] = {'database_name': SNAPSHOT_FILE, 'database_type': 'SQLite'}
    c['DataBindings'][SNAPSHOT_BINDING] = {
        'database': 'jhwx_snapshot_sqlite', 'table_name': 'archive',
        'manager': 'weewx.manager.DaySummaryManager', 'schema': 'weewx.schemas.wview_extended.schema',
    }
epoch = ''
if SNAPSHOT_BINDING in c.get('DataBindings', {}):
    report['data_binding'] = SNAPSHOT_BINDING
    # weectl report run would ask for the live database's latest time, which
    # the snapshot doesn't have (every template is skipped), so run the
    # report at the snapshot's own last record, as weewxd does.
    import sqlite3
    db = sqlite3.connect('file:%s?mode=ro' % os.path.join(archive_dir, SNAPSHOT_FILE), uri=True)
    epoch = str(db.execute('SELECT MAX(dateTime) FROM archive').fetchone()[0])
    db.close()
c['StdReport']['jhwx'] = report

c.filename = out
c.write()
os.chmod(out, 0o600)
with open(out + '.epoch', 'w') as f:
    f.write(epoch)
print('wrote %s (history binding: %s)' % (out, report.get('data_binding', 'default')))
