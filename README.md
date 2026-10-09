# flight-ticket

Pushes the nearest airborne aircraft (adsb.fi open data) to a TickrMeter hosted
custom display every 15 minutes via GitHub Actions.

Repository secrets (Settings > Secrets and variables > Actions):

- `TICKRMETER_API_ORIGIN` = `https://api.tickrmeter.io`
- `TICKRMETER_INSTALLATION_ID`
- `TICKRMETER_APP_TOKEN` (display-scoped token; never commit it)
- `HOME_LAT`, `HOME_LON` (kept as secrets so your location is not public)

Stop: disable the workflow in the Actions tab. Revoke or rotate the token in TickrMeter to cut off access.

## How it keeps running

GitHub's cron scheduler is best-effort and did not fire for this repo, so the main
path is a self-renewing loop (`loop` job): it pushes every 15 minutes for about
5.5 hours, then starts its own replacement. The cron `once` job is only a backup.

To stop it: disable the workflow in the Actions tab, then cancel any running
"Update TickrMeter flight display" run (cancelling does not restart it).
To start it again, use Run workflow.
