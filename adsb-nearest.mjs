#!/usr/bin/env node
// Pushes the nearest airborne aircraft (from adsb.fi open data) to a TickrMeter
// hosted display. Outbound requests only. Node 20+, no dependencies.
//
// Display fields: data1 airline + flight, data2 route, data5 airline code (LED rule), data6 details
//
// Env (set as secrets, never in this file):
//   TICKRMETER_API_ORIGIN, TICKRMETER_INSTALLATION_ID, TICKRMETER_APP_TOKEN
// Optional: HOME_LAT, HOME_LON (default Crowthorne),
//   MIN_ELEVATION_DEG (default 15): only aircraft at least this high above your horizon
//   MAX_SLANT_NM (default 15): straight-line range beyond which a plane is too small to see

const LAT = Number(process.env.HOME_LAT ?? 51.3667);
const LON = Number(process.env.HOME_LON ?? -0.8);
const MAX_SLANT_NM = Number(process.env.MAX_SLANT_NM ?? 15);
const MIN_ELEVATION_DEG = Number(process.env.MIN_ELEVATION_DEG ?? 15);

const origin = process.env.TICKRMETER_API_ORIGIN;
const installationId = process.env.TICKRMETER_INSTALLATION_ID;
const token = process.env.TICKRMETER_APP_TOKEN;

if (!origin?.startsWith('https://') || !/^[a-fA-F0-9]{24}$/.test(installationId ?? '') || !/^tma_[a-f0-9]{64}$/.test(token ?? '')) {
  console.error('Missing or invalid TickrMeter connection settings.');
  process.exit(1);
}
if (![LAT, LON, MAX_SLANT_NM, MIN_ELEVATION_DEG].every(Number.isFinite)) {
  console.error('Invalid HOME_LAT, HOME_LON, MAX_SLANT_NM or MIN_ELEVATION_DEG.');
  process.exit(1);
}

// 1. Read live traffic. On any failure, exit WITHOUT publishing (never fake data).
let aircraft;
try {
  const res = await fetch(`https://opendata.adsb.fi/api/v2/lat/${LAT}/lon/${LON}/dist/${MAX_SLANT_NM}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`adsb.fi HTTP ${res.status}`);
  aircraft = (await res.json()).aircraft ?? [];
} catch (e) {
  console.error('Could not read ADS-B data:', e.message);
  process.exit(1);
}

// 2. Nearest aircraft you could actually see: airborne, fresh position, at least
// MIN_ELEVATION_DEG above your horizon (clears rooftops and trees) and within
// MAX_SLANT_NM straight-line (any further is just a speck). Elevation = atan(height / ground
// distance), so a 35,000 ft jet qualifies from ~21 degrees (about 13 nm away on the ground)
// while a plane at 3,000 ft only counts within ~1.8 nm.
const FT_PER_NM = 6076.12;
const elevationDeg = a => Math.atan2(a.alt_baro / FT_PER_NM, a.dst) * 180 / Math.PI;
const slant = a => Math.hypot(a.dst, a.alt_baro / FT_PER_NM);
const candidates = aircraft.filter(a => typeof a.alt_baro === 'number' && a.alt_baro > 0
  && typeof a.dst === 'number' && (a.seen_pos ?? 0) < 60
  && !String(a.type ?? '').endsWith('_nt'));
// Nearest in 3D (straight-line) distance, preferring aircraft you could actually see.
const byNearest = (x, y) => slant(x) - slant(y);
const visible = candidates
  .filter(a => elevationDeg(a) >= MIN_ELEVATION_DEG && slant(a) <= MAX_SLANT_NM)
  .sort(byNearest);
// The display only refreshes every 15 minutes, so never leave it blank: if nothing
// is visible, fall back to the nearest airborne aircraft in range (the details line
// shows its altitude and distance, so a low/distant one is obvious).
const airborne = visible.length ? visible : candidates.sort(byNearest);

const n = airborne[0];

const clean = v => String(v ?? '').replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, '').trim();

// adsbdb's free callsign lookup gives the IATA-style flight code (BA614), airline
// name and route. Any failure falls back to the raw callsign / aircraft type, so a
// lookup problem never blocks the update.
async function lookup(a) {
  const raw = a.flight?.trim() || a.r || a.hex;
  const out = { callsign: raw, airlineName: null, airlineCode: null, from: null, to: null, fromIata: null, toIata: null };
  if (!a.flight?.trim()) return out;
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(raw)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const fr = (await r.json())?.response?.flightroute;
      const iata = fr?.callsign_iata;
      if (typeof iata === 'string' && /^[A-Z0-9]{3,8}$/.test(iata)) out.callsign = iata;
      out.airlineName = clean(fr?.airline?.name) || null;
      const code = fr?.airline?.iata;
      if (/^[A-Z0-9]{2}$/.test(code ?? '')) out.airlineCode = code;
      out.from = clean(fr?.origin?.municipality) || null;
      out.to = clean(fr?.destination?.municipality) || null;
      out.fromIata = clean(fr?.origin?.iata_code) || null;
      out.toIata = clean(fr?.destination?.iata_code) || null;
    }
  } catch { /* fall through */ }
  return out;
}

function buildValues(a, info) {
  // Top line: "Jet2 \u00b7 LS51E" (airline name + flight code), or just the callsign.
  let top = info.airlineName ? `${info.airlineName} \u00b7 ${info.callsign}` : info.callsign;
  if (top.length > 32) top = info.callsign;
  // Middle: city names, or airport codes if too long, or aircraft description if no route.
  let route = info.from && info.to ? `${info.from} to ${info.to}` : null;
  if (route && route.length > 32 && info.fromIata && info.toIata) route = `${info.fromIata} to ${info.toIata}`;
  if (!route || route.length > 32) route = clean(a.desc || a.t) || 'Unknown route';
  // Bottom: type, altitude with thousands separator, distance in statute miles.
  const miles = Math.round(a.dst * 1.15078 * 10) / 10;
  const details = [clean(a.t), `${Math.round(a.alt_baro).toLocaleString('en-GB')} ft`, `${miles} mi`]
    .filter(Boolean).join(' \u00b7 ');
  return {
    data1: top.slice(0, 32),
    data2: route.slice(0, 32),
    data5: info.airlineCode,
    data6: details.slice(0, 32),
  };
}

const values = n
  ? buildValues(n, await lookup(n))
  // Genuine observation: nothing airborne in range.
  : { data1: 'NO AIRCRAFT NEARBY', data2: null, data5: null, data6: null };

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
