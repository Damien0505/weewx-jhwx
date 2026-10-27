#!/usr/bin/env python3
"""Make a read-only SQLite snapshot of the production weewx archive.

Used for developing the jhwx skin on the test CT, which receives live data but
has almost no history of its own.  Run on the prod VM as the weewx user:

    /home/weather/weewx-venv/bin/python snapshot_prod.py OUTPUT.sdb

Only SELECTs are issued against MariaDB.  The output gets the same archive
columns as prod and its daily summaries are built with weewx's own backfill,
so it behaves like any other weewx database.  Copy it to the test CT and point
a separate data binding at it.
"""

import argparse
import os
import sys
import time

import weecfg
import weedb
import weewx.manager

CHUNK = 20000


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('output', help='new SQLite file to create')
    ap.add_argument('--config', default='/home/weather/weewx-data/weewx.conf')
    ap.add_argument('--binding', default='wx_binding')
    ap.add_argument('--force', action='store_true', help='overwrite OUTPUT')
    ap.add_argument('--backfill-only', action='store_true',
                    help='only (re)build the daily summaries of an existing OUTPUT')
    args = ap.parse_args()

    out = os.path.abspath(args.output)
    db_dict = {'database_name': out, 'driver': 'weedb.sqlite', 'timeout': 30}
    if args.backfill_only:
        backfill(db_dict)
        return
    if os.path.exists(out):
        if not args.force:
            sys.exit('%s exists (use --force)' % out)
        os.remove(out)

    _, cfg = weecfg.read_config(args.config)
    t0 = time.time()
    with weewx.manager.open_manager_with_config(cfg, args.binding) as src:
        cols = list(src.sqlkeys)
        day_types = [k for k in src.daykeys]
        n_src = src.getSql('SELECT COUNT(*) FROM %s' % src.table_name)[0]
        print('source: %d rows, %d columns, %d daily summaries' % (n_src, len(cols), len(day_types)))

        fixed = {'dateTime': 'INTEGER NOT NULL UNIQUE PRIMARY KEY',
                 'usUnits': 'INTEGER NOT NULL', 'interval': 'INTEGER NOT NULL'}
        schema = {
            'table': [(c, fixed.get(c, 'REAL')) for c in cols],
            'day_summaries': [(k, 'VECTOR' if k == 'wind' else 'SCALAR') for k in day_types],
        }
        dst = weewx.manager.DaySummaryManager.open_with_create(db_dict, schema=schema)
        try:
            col_sql = ', '.join('`%s`' % c for c in cols)
            ins_sql = 'INSERT INTO archive (%s) VALUES (%s)' % (
                ', '.join('"%s"' % c for c in cols), ', '.join('?' * len(cols)))
            last, copied = -1, 0
            while True:
                rows = list(src.genSql('SELECT %s FROM %s WHERE dateTime > %%s ORDER BY dateTime LIMIT %d'
                                       % (col_sql, src.table_name, CHUNK), (last,)))
                if not rows:
                    break
                with weedb.Transaction(dst.connection) as cur:
                    cur.executemany(ins_sql, rows)
                last = rows[-1][0]
                copied += len(rows)
                print('\r  copied %d / %d' % (copied, n_src), end='', flush=True)
            print('\narchive copied in %.0f s' % (time.time() - t0))
        finally:
            dst.close()
    backfill(db_dict)
    print('done in %.0f s -> %s (%.0f MB)' % (time.time() - t0, out, os.path.getsize(out) / 1e6))


def backfill(db_dict):
    # Reopen: a manager caches first/last timestamps at open time, so the one
    # that created the empty file would think there is nothing to backfill.
    t0 = time.time()
    print('building daily summaries...')
    with weewx.manager.DaySummaryManager.open(db_dict) as mgr:
        nrecs, ndays = mgr.backfill_day_summary(progress_fn=lambda *a: None, trans_days=20)
    print('daily summaries: %d records, %d days in %.0f s' % (nrecs, ndays, time.time() - t0))


if __name__ == '__main__':
    main()
