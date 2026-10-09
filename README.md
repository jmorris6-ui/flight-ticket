# flight-ticket

Pushes the nearest airborne aircraft (adsb.fi open data) to a TickrMeter hosted
custom display every 15 minutes via GitHub Actions.

Repository secrets (Settings > Secrets and variables > Actions):

- `TICKRMETER_API_ORIGIN` = `https://api.tickrmeter.io`
- `TICKRMETER_INSTALLATION_ID`
- `TICKRMETER_APP_TOKEN` (display-scoped token; never commit it)
- `HOME_LAT`, `HOME_LON` (kept as secrets so your location is not public)

Stop: disable the workflow in the Actions tab. Revoke or rotate the token in TickrMeter to cut off access.
