#!/usr/bin/env node
// Pushes the nearest airborne aircraft (from adsb.fi open data) to a TickrMeter
// hosted display. Outbound requests only. Node 20+, no dependencies.
//
// Display fields: data1 callsign, data2 aircraft type, data3 altitude (ft), data4 distance (nm)
//
// Env (set as secrets, never in this file):
//   TICKRMETER_API_ORIGIN, TICKRMETER_INSTALLATION_ID, TICKRMETER_APP_TOKEN
// Optional: HOME_LAT, HOME_LON (default Crowthorne), RADIUS_NM (default 15)

const LAT = Number(process.env.HOME_LAT ?? 51.3667);
const LON = Number(process.env.HOME_LON ?? -0.8);
const RADIUS_NM = Number(process.env.RADIUS_NM ?? 15);

const origin = process.env.TICKRMETER_API_ORIGIN;
const installationId = process.env.TICKRMETER_INSTALLATION_ID;
const token = process.env.TICKRMETER_APP_TOKEN;

if (!origin?.startsWith('https://') || !/^[a-fA-F0-9]{24}$/.test(installationId ?? '') || !/^tma_[a-f0-9]{64}$/.test(token ?? '')) {
  console.error('Missing or invalid TickrMeter connection settings.');
  process.exit(1);
}
if (![LAT, LON, RADIUS_NM].every(Number.isFinite)) {
  console.error('Invalid HOME_LAT, HOME_LON or RADIUS_NM.');
  process.exit(1);
}

// 1. Read live traffic. On any failure, exit WITHOUT publishing (never fake data).
let aircraft;
try {
  const res = await fetch(`https://opendata.adsb.fi/api/v2/lat/${LAT}/lon/${LON}/dist/${RADIUS_NM}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`adsb.fi HTTP ${res.status}`);
  aircraft = (await res.json()).aircraft ?? [];
} catch (e) {
  console.error('Could not read ADS-B data:', e.message);
  process.exit(1);
}

// 2. Nearest airborne aircraft with a fresh position (ignores ground traffic at Heathrow etc.)
const airborne = aircraft
  .filter(a => typeof a.alt_baro === 'number' && a.alt_baro > 0
    && typeof a.dst === 'number' && (a.seen_pos ?? 0) < 60
    && !String(a.type ?? '').endsWith('_nt'))
  .sort((a, b) => a.dst - b.dst);

const n = airborne[0];

// Airlines broadcast ICAO-style callsigns (BAW614). adsbdb's free lookup gives the
// IATA-style form (BA614) and, where known, the route. Any failure falls back to the
// raw callsign and the aircraft type, so a lookup problem never blocks the update.
async function lookup(a) {
  const raw = a.flight?.trim() || a.r || a.hex;
  const out = { callsign: raw, route: null, airline: null };
  if (!a.flight?.trim()) return out;
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(raw)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const fr = (await r.json())?.response?.flightroute;
      const iata = fr?.callsign_iata;
      if (typeof iata === 'string' && /^[A-Z0-9]{3,8}$/.test(iata)) out.callsign = iata;
      const code = fr?.airline?.iata;
      if (/^[A-Z0-9]{2}$/.test(code ?? '')) out.airline = code;
      const from = fr?.origin?.iata_code, to = fr?.destination?.iata_code;
      if (/^[A-Z0-9]{3}$/.test(from ?? '') && /^[A-Z0-9]{3}$/.test(to ?? '')) out.route = `${from}-${to}`;
    }
  } catch { /* fall through */ }
  return out;
}

const info = n ? await lookup(n) : null;
const values = n
  ? {
      data1: info.callsign.slice(0, 32),
      data2: (info.route ?? n.t ?? '').slice(0, 32) || null,
      data3: Math.round(n.alt_baro),
      data4: Math.round(n.dst * 10) / 10,
      data5: info.airline,
    }
  // Genuine observation: nothing airborne in range.
  : { data1: 'NONE NEARBY', data2: null, data3: null, data4: null, data5: null };

// 3. Publish one complete snapshot.
const res = await fetch(`${origin}/api/apps/installations/${installationId.toLowerCase()}/snapshot`, {
  method: 'POST',
  redirect: 'error',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ values, observedAt: new Date().toISOString() }),
  signal: AbortSignal.timeout(10000),
});
if (!res.ok) {
  console.error(`TickrMeter rejected the snapshot (HTTP ${res.status}).`);
  process.exit(1);
}
console.log('Snapshot accepted:', JSON.stringify(values));
