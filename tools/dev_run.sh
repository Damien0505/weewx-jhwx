#!/usr/bin/env bash
# Dry-run the jhwx skin on a test weewx host without touching its live weewx.conf.
#
#   tools/dev_run.sh root@host [output_dir]
#
# Copies the repo's bin/ + skins/ to ~weather/jhwx-dev on the host, builds a
# temporary config (/tmp/jhwx-test.conf) from the live weewx.conf plus the
# report section install.py would add, runs `weectl report run` for jhwx only,
# then checks every generated JSON file parses and is tagged metric.
#
# Test-only overrides (output dir, MQTT path, history binding) are in
# OVERRIDES below.
set -euo pipefail

HOST=${1:?usage: tools/dev_run.sh root@host [output_dir]}
OUT=${2:-/tmp/jhwx-out}
REPO=$(cd "$(dirname "$0")/.." && pwd)

# install.py must list every file (weectl uninstalls from that list)
python "$REPO/tools/gen_filelist.py" --check

tar --owner=0 --group=0 -C "$REPO" -czf - install.py bin skins tools/mkconf.py |
  ssh "$HOST" 'set -e; D=/home/weather/jhwx-dev; rm -rf $D; mkdir -p $D;
    tar --no-same-owner -xzf - -C $D; chown -R weather:weather $D;
    install -o weather -g weather -m 644 $D/bin/user/jhwx*.py /home/weather/weewx-data/bin/user/'

ssh "$HOST" "set -e
  runuser -u weather -- /home/weather/weewx-venv/bin/python /home/weather/jhwx-dev/tools/mkconf.py \
      /home/weather/weewx-data/weewx.conf /tmp/jhwx-test.conf $OUT
  rm -rf $OUT
  cd /home/weather/weewx-data
  since=\$(date '+%F %T')
  epoch=\$(cat /tmp/jhwx-test.conf.epoch)
  runuser -u weather -- /home/weather/weewx-venv/bin/weectl report run --config /tmp/jhwx-test.conf \${epoch:+--epoch=\$epoch} jhwx >/dev/null 2>&1 || true
  journalctl --since \"\$since\" --no-pager | grep weectl | grep -iE 'jhwx|cheetah|copygen|error|traceback|fail' || true
  echo '--- files'; find $OUT -type f | sort
  echo '--- json'
  for f in $OUT/data/*.json; do
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); u=d.get(\"units\"); print(\"ok  \" if u in (None, \"metric\") else \"BAD \", sys.argv[1], \"units=%s\" % u)' \$f || echo \"INVALID JSON \$f\"
  done"
