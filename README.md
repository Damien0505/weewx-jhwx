# jhwx — Jepps Hill weather UI for WeeWX 5

A WeeWX 5 skin plus a static, vanilla-JS dashboard:

- **Live** values from the station's MQTT loop feed (`weather/loop`, about every 10 s). The
  page measures the usual packet interval; if the feed, or one sensor (outdoor array, rain
  gauge, console), is silent for that interval plus 5 s, a banner names it and when it was
  last heard, and readings that stop updating are dimmed. With no feed at all the page
  falls back to the latest archive record and says so.
- **Trend** arrows and rates (1 h; pressure 3 h), 6-hour sparklines, pressure tendency.
- **Hero** card with a current-conditions icon, dew point and estimated cloud base (above the
  station), plus a **sun & moon** card: a protractor showing the sun's true elevation, and a
  photo of the moon (NASA SVS, public domain) shaded for its phase and turned the way it looks
  from the station at that moment.
- **History pop-up** for every reading: Day / Week / Month / Year charts (hover for values,
  dotted means, clear-sky maximum on solar), an almanac (today, month, year, station record);
  **NOAA** reports from the header button.
- **Evapotranspiration**: WeeWX's reference ET (FAO-56 Penman–Monteith) for today, yesterday and
  7 days, with the 7-day rain − ET water balance, history and a plain-language explanation.
- **Fire danger** (indicative, Australia, off by default): McArthur Forest FFDI from live
  temperature, humidity and 10-minute wind, with a drought factor (KBDI + Griffiths) computed
  from the station's own rain and temperature history, shown in AFDRS-style bands. Not an
  official rating.
- **7-day forecast** (Open-Meteo): click a day, or the hero's outlook line, for its **hourly
  forecast** (temperature and feels-like, chance and amount of rain, wind, gusts, UV); **rain radar** (RainViewer) with nearest echo, movement and a
  rough arrival estimate; a **pressure chart** (isobars, highs and lows, 3 days ahead);
  **earthquakes** (EMSC: pick the look-back and the M4+ and M2+ ranges; the list follows the map
  view, and a dot or list entry opens its details); **lightning** (optional, Xweather): strikes within 100 km over the last
  hour, coloured by age, with a link to the live LightningMaps.org (Blitzortung) map.
- **Voltages** (optional): supercap and backup-battery tiles and gauges for whichever archive
  fields hold them (e.g. an Ecowitt WS90 mapped to `supplyVoltage` / `batteryStatus1`).
- **Tiles or gauges**: every tile has a gauge, plus wind direction and rain rate; red and green
  markers show today's high and low, and the wind gauge has a blue gust needle.
  **Light / dark / auto** theme; works from 390 px phones to desktop.

## How it works

The skin writes static files each report cycle (every 5 minutes) into its `HTML_ROOT`:

| File | Contents |
|---|---|
| `index.html`, `css/`, `js/`, `fonts/`, `img/` | the app (copied as-is) |
| `data/config.json` | station facts, MQTT URL/topic, cutover and record cutoffs |
| `data/current.json` | latest record, today's highs/lows, rain totals (fallback for MQTT) |
| `data/day.json` | last 24 h of archive records (trend seeds, sparklines, Day charts) |
| `data/week.json` | last 7 days in 30-minute bins (Week charts) |
| `data/fire.json` | daily drought index and drought factor (fire-danger history) |
| `data/month.json`, `data/year.json` | one value per day from the daily summaries |
| `data/almanac.json` | almanac grid values |
| `data/astro.json` | sun and moon from the WeeWX almanac |
| `data/noaa-index.json`, `NOAA/*.txt` | NOAA monthly/yearly summaries |
| `data/mslp.json` | sea-level pressure grid for the pressure chart (refreshed every 6 h) |
| `data/lightning.json` | lightning strikes near the station, if `[[lightning]]` is enabled |

All generated JSON is **metric** (°C, hPa, km/h, mm). Each file carries a `"units"` tag
that the front end checks before it uses the numbers. MQTT loop packets are in US units
and are converted in one place, `js/units.js`.

The browser also fetches directly from Open-Meteo (forecast), RainViewer, EMSC and
OpenStreetMap tiles. The database is never exposed.

The pressure chart is the one thing WeeWX itself downloads: Open-Meteo counts every grid point
as an API call, so rather than each visitor's browser asking for ~400 points, the skin fetches
the grid at most every 6 hours (about 1,600 calls a day, inside the free limit) and keeps the
previous file if a fetch fails. Set `[[mslp]] enable = false` to turn this off.

Lightning (off by default) also comes through WeeWX, so the Xweather credentials never reach the
browser. Xweather's free Developer plan allows 15,000 access tokens a month; a strike count costs
1 and a list of strikes 10. WeeWX counts strikes every 30 minutes, every 10 minutes while the
Open-Meteo forecast shows thunderstorms or unstable air (or for an hour after a strike), fetches
the strike list only when there are strikes, and stops at the daily and monthly token caps.
Strikes are kept for an hour.

## Install

```
weectl extension install /path/to/weewx_skin      # or a .zip of this repository
```

The installer copies `bin/user/jhwx*.py` (search list, history, fire danger, pressure grid),
plus `skins/jhwx/`.
It also adds this report:

```ini
[StdReport]
    [[jhwx]]
        skin = jhwx
        enable = true
        HTML_ROOT = wx            # relative to [StdReport] HTML_ROOT -> public_html/wx
        unit_system = METRIC
        [[[Units]]]
            [[[[Groups]]]]
                group_rain = mm
                group_rainrate = mm_per_hour
                group_pressure = hPa
                ...
```

The units are pinned in the report section on purpose. `[StdReport][[Defaults]]` often sets
`unit_system = metricwx`, which would otherwise override the skin's own `[Units]`.

Then restart weewx (`systemctl restart weewx`).

### Web server

The installer can't configure the web server. Two things are needed:

1. Serve `HTML_ROOT` at `/wx/`.
2. Proxy `/wx/mqtt` to Mosquitto's websocket listener. It must be anonymous and read-only,
   limited to `weather/#`.

Apache (needs `proxy` and `proxy_wstunnel`):

```apache
Alias /wx /home/weather/weewx-data/public_html/wx
ProxyPass /wx/mqtt ws://127.0.0.1:9001/mqtt
ProxyPassReverse /wx/mqtt ws://127.0.0.1:9001/mqtt
```

nginx:

```nginx
location /wx/ { alias /home/weather/weewx-data/public_html/wx/; }
location = /wx/mqtt {
    proxy_pass http://127.0.0.1:9001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

The page connects to `mqtt_url` relative to its own address (default `mqtt`, so `/wx/mqtt`).
It switches between `ws://` and `wss://` to match http/https, so it works on the LAN and behind
a TLS reverse proxy. If the broker is somewhere else, set `mqtt_url` (see below).

Every URL in the page is relative, so it can be served under any path, or at the site root by
a reverse proxy, without changing the skin.

Recommended: have browsers re-check the app and its data on each load (a cheap 304 when
nothing changed), so a skin update never leaves them running a mix of old and new scripts.
Apache (needs `headers`):

```apache
<Directory /home/weather/weewx-data/public_html/wx>
    <FilesMatch "\.(html|js|css|json|txt)$">
        Header set Cache-Control "no-cache"
    </FilesMatch>
</Directory>
```

### This station (Jepps Hill)

The UI is the site's home page, **https://weather.damienbeeby.com/**:

- On the weewx VM, Apache serves the report at `/jhwx/` (`HTML_ROOT = public_html/jhwx`,
  `Alias /jhwx`, `ProxyPass /jhwx/mqtt` to Mosquitto's websocket, the `no-cache` header above).
- The public reverse proxy (Nginx Proxy Manager) maps the site root onto it:
  `location / { proxy_pass http://<weewx-vm>/jhwx/; }` with the websocket upgrade headers, so
  the page is at `/` and its live feed at `/mqtt`. Earlier addresses `/wx/…` and `/jhwx/…`
  redirect to `/…`.
- The other skins on the same server: DivumWX at `/divumwx/` (`/divum/` and its old root
  URLs redirect there) and fuzzy-archer at `/fuzzy/`.

## Options

`skins/jhwx/skin.conf` ships generic defaults.  Put this station's settings in `weewx.conf`
under `[StdReport] [[jhwx]] [[[Extras]]]` (subsections one level deeper, e.g.
`[[[[power]]]]`), so that updating the skin never loses them.  WeeWX merges them over the
skin's `[Extras]`; a restart picks them up.

| Option | Default | Meaning |
|---|---|---|
| `live_binding` | `wx_binding` | binding for "current" values (latest record, today's stats) |
| `mqtt_url` | `mqtt` | broker websocket; relative to the page, or a full `ws(s)://` URL |
| `mqtt_topic` | `weather/loop` | loop topic (weewx-mqtt, `unit_system = US`, `binding = loop`) |
| `station_short` | WeeWX hardware name | short station name (footer, chart markers) |
| `subtitle` | blank | line under the station name |
| `cutover` | blank | `YYYY-MM-DD HH:MM` when the current hardware started (chart marker) |
| `[[sensors]] outdoor / console / rain` | Outdoor / Console / Rain gauge | names used when one stops reporting, and in pop-up headers |
| `[[record_cutoff]] <obs> = YYYY-MM-DD HH:MM` | none | records, charts and totals for that reading only count from then (faulty earlier sensor) |
| `[[power]] supercap`, `battery` | blank (hidden) | archive fields holding the voltages |
| `[[power]] supercap_label`, `supercap_max` | Supercap, 6 | tile/gauge name, gauge top (V) |
| `[[power]] battery_label`, `battery_min`, `battery_max` | Backup battery, 2.0, 3.6 | tile/gauge name, gauge range (V) |
| `[[power]] battery_low`, `battery_fair` | 2.4, 2.8 | below these the battery reads Low / Fair |
| `[[fire_danger]] enable` | `false` | indicative fire danger tile, Now-card badge and history (Australian method) |
| `[[fire_danger]] info_name`, `info_url`, `info_extra` | blank | where to check official ratings, e.g. `CFA`, its URL, `or the VicEmergency app` |
| `[[mslp]] enable` | `true` | pressure chart (WeeWX fetches the grid, see above) |
| `[[mslp]] bounds` | 42 x 78 degrees centred on the station | `north, south, west, east` |
| `[[mslp]] chart_name`, `chart_url` | blank | link to an official analysed chart |
| `[[lightning]] enable` | `false` | Lightning tab strikes from the Xweather Weather API |
| `[[lightning]] client_id`, `client_secret` | blank | Xweather app credentials: put them in `weewx.conf`, never in `skin.conf` |
| `[[lightning]] radius_km` | 100 | search radius (100 km is the most standard access allows) |
| `[[lightning]] daily_tokens`, `monthly_tokens` | 480, 14000 | token caps; queries stop when either is reached |
| `[[lightning]] cape` | 500 | CAPE (J/kg) in the forecast that counts as storms likely |

This station's settings, for example:

```ini
[StdReport]
    [[jhwx]]
        ...
        [[[Extras]]]
            station_short = Wittboy
            cutover = 2026-10-24 19:45
            [[[[sensors]]]]
                outdoor = WS90
                console = HP2560
                rain = WS90 piezo
            [[[[record_cutoff]]]]
                radiation = 2026-10-24 19:45
            [[[[power]]]]
                supercap = supplyVoltage
                battery = batteryStatus1
            [[[[fire_danger]]]]
                enable = true
                info_name = CFA
                info_url = https://www.cfa.vic.gov.au/warnings-restrictions/fire-danger-ratings
            [[[[mslp]]]]
                bounds = -6, -48, 102, 180
                chart_name = BoM synoptic chart
                chart_url = https://www.bom.gov.au/australia/charts/synoptic_col.shtml
            [[[[lightning]]]]
                enable = true
                client_id = <your Xweather client id>
                client_secret = <your Xweather client secret>
```

History (charts, almanac, NOAA) uses the report's `data_binding`. Normally that's the same as
`live_binding`. For development it can point at a separate database (see below); live values
(latest record, today, last 24 h, sun times) are still anchored at the live binding's newest
record, via the skin's `$live` tags.

A useful debugging aid: `?mqtt=wss://host/path` on the page URL overrides the broker for that
visit.

## Development

```
tools/dev_run.sh root@test-host [outdir]
```

This copies `bin/` and `skins/` to a test weewx host (as root over SSH). It builds a
temporary config from the live `weewx.conf` plus the report section `install.py` would add.
Then it runs `weectl report run jhwx` into `/tmp/jhwx-out` and checks every JSON file
parses and is tagged metric. **It doesn't change the live `weewx.conf` or restart
anything.** Test-only overrides (MQTT path, labels, history binding) are in `tools/mkconf.py`.

Every tile has a matching gauge (Wind has two: speed and direction). A new tile needs a gauge in
`js/gauges.js` with the same `ref`; `node tools/check_gauges.mjs` (also run by `dev_run.sh`) fails if one
is missing.

`tools/snapshot_prod.py` makes a read-only SQLite snapshot of the production archive. It
uses only SELECTs and builds the daily summaries with WeeWX's own backfill. That way the
test host, which only has a little live history of its own, can generate realistic
Month/Year/record data.

## Data caveats (this station)

- Before **24 Oct 2026 19:45** the data is from the old HP1000. Its solar/UV readings were
  faulty and its barometer read ~2.8 hPa high. Records for those readings start at the cutover.
- Rain before the cutover came from a 0.3 mm tipping bucket; after it, from the WS90 piezo.
  Values are shown as recorded.
- `dayRain` in the archive is a 5-minute average of a running total. The skin never sums it.

## Credits and licences

Station data: WeeWX. Forecast and pressure grid: Open-Meteo (CC BY 4.0), ECMWF model. Radar: RainViewer.
Earthquakes: EMSC-CSEM. Lightning: Xweather; live map link to LightningMaps.org (Blitzortung.org).
Moon photo: NASA Scientific Visualization Studio (public domain).
Maps: Leaflet (BSD-2-Clause), © OpenStreetMap contributors. Live feed: MQTT.js (MIT). Fonts: Barlow,
IBM Plex Mono (SIL OFL 1.1). The NOAA templates come from WeeWX's Seasons skin.

This skin is licensed under the **GNU General Public License v3.0** (see [`LICENSE`](LICENSE)),
the same as WeeWX. The bundled third-party files keep their own licences (files alongside them).
