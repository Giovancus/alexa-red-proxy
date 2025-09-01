// /api/arrivals.js
// - PREFIERE XOR (tiempo real) con una "ventana de gracia" sobre Google.
// - Cache CDN reducido a 5s (evita repetir valores).
// - Respuesta: { arrivals:[{minutes}|{min,max}], source:'xor'|'google' }.
// - Paradero por defecto: PH1474, Servicio: H09.
//
// Env vars en Vercel (Settings → Environment Variables):
//   GMAPS_API_KEY, PH645_LAT, PH645_LNG, DEST_PLACE_ID_H09
//   *Reutilizamos PH645_LAT/LNG con las coordenadas de PH1474, como acordamos.*

const norm = (s) => String(s || "").toUpperCase().replace(/\s|-/g, "");

const GMAPS_KEY = process.env.GMAPS_API_KEY || "";
const PH645_LAT = Number(process.env.PH645_LAT); // ahora contiene LAT de PH1474
const PH645_LNG = Number(process.env.PH645_LNG); // ahora contiene LNG de PH1474
const DEST_PLACE_ID_H09 = process.env.DEST_PLACE_ID_H09 || "";

// Permite Google si es el paradero/servicio configurado y hay creds
const ALLOW_GOOGLE_FOR = (stop, target) =>
  stop === "PH1474" && target === "H09" &&
  Boolean(GMAPS_KEY && Number.isFinite(PH645_LAT) && Number.isFinite(PH645_LNG) && DEST_PLACE_ID_H09);

export default async function handler(req, res) {
  try {
    // caché corta (5s) + stale
    setCache(res, 5, 10);

    const stop = norm(req.query.stop || "PH1474"); // default actualizado
    const target = norm(req.query.service || "H09");
    const forceGoogle = String(req.query.force_google || req.query.fg || "") === "1";
    const allowGoogle = ALLOW_GOOGLE_FOR(stop, target);

    const pXor = forceGoogle ? Promise.resolve({ arrivals: [], source: "xor" }) : getFromXor(stop, target);
    const pGoogle = allowGoogle
      ? getFromGoogle({ lat: PH645_LAT, lng: PH645_LNG }, DEST_PLACE_ID_H09, target, GMAPS_KEY)
      : Promise.resolve({ arrivals: [], source: "google" });

    // Prefiere XOR: si Google llega primero, espera "graceMs" por XOR antes de decidir.
    const winner = await preferXor(pXor, pGoogle, { graceMs: 1200, timeoutMs: 6500 });

    // Si ganó Google, aún más prudente con el caché
    if (winner?.source === "google") setCache(res, 3, 6);

    res.setHeader("X-Data-Source", winner?.source || "none");
    return res.status(200).json(winner || { arrivals: [], source: "none" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

function setCache(res, smax, swr) {
  const v = `s-maxage=${smax}, stale-while-revalidate=${swr}`;
  res.setHeader("Cache-Control", v);
  res.setHeader("CDN-Cache-Control", v);
  res.setHeader("Vercel-CDN-Cache-Control", v);
}

function addIfNum(arr, v) { const n = Number(v); if (Number.isFinite(n)) arr.push(n); }

async function getFromXor(stop, target) {
  try {
    const u = `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stop)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return { arrivals: [], source: "xor" };
    const data = await r.json();

    const minutes = [];
    const services = Array.isArray(data?.services) ? data.services : [];
    for (const s of services) {
      const sid = norm(s?.id || s?.name);
      if (!sid.includes(target)) continue;

      // A) services[].buses[] con min/max
      if (Array.isArray(s?.buses)) {
        for (const b of s.buses) {
          addIfNum(minutes, b?.min_arrival_time);
          addIfNum(minutes, b?.max_arrival_time);
        }
      }
      // B) services[].arrivals[] clásico
      if (Array.isArray(s?.arrivals)) {
        for (const a of s.arrivals) {
          addIfNum(minutes, a?.minutes);
          addIfNum(minutes, a?.min);
          addIfNum(minutes, a?.eta);
        }
      }
    }

    const uniq = [...new Set(minutes)].sort((a, b) => a - b);
    const out = [];
    // Empaquetar en rangos si parecen pares (min,max) del mismo bus
    for (let i = 0; i < uniq.length; i += 2) {
      const a = uniq[i], b = uniq[i + 1];
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 6) out.push({ min: a, max: b });
      else if (Number.isFinite(a)) {
        out.push({ minutes: a });
        if (Number.isFinite(b)) out.push({ minutes: b });
      }
    }
    return { arrivals: out, source: "xor" };
  } catch {
    return { arrivals: [], source: "xor" };
  }
}

async function getFromGoogle(originLatLng, destPlaceId, target, apiKey) {
  try {
    const origin = `${originLatLng.lat},${originLatLng.lng}`;
    const dest = `place_id:${destPlaceId}`;
    const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", dest);
    url.searchParams.set("mode", "transit");
    url.searchParams.set("transit_mode", "bus");
    url.searchParams.set("departure_time", "now");
    url.searchParams.set("alternatives", "true");
    url.searchParams.set("language", "es");
    url.searchParams.set("region", "cl");
    url.searchParams.set("key", apiKey);

    const r = await fetch(url, { signal: AbortSignal.timeout(6500), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return { arrivals: [], source: "google" };
    const dj = await r.json();

    const now = Math.floor(Date.now() / 1000);
    let best = null;

    for (const route of dj.routes || []) {
      for (const leg of route.legs || []) {
        for (const step of leg.steps || []) {
          if (step.travel_mode !== "TRANSIT") continue;
          const td = step.transit_details || {};
          const line = td.line || {};
          const shortName = (line.short_name || line.name_short || line.name || "")
            .toString().toUpperCase().replace(/\s|-/g, "");
          if (shortName !== target) continue;

          const dep = td.departure_time;
          const depSec = typeof dep?.value === "number" ? dep.value : Number(dep);
          if (!Number.isFinite(depSec)) continue;

          const m = Math.max(0, Math.round((depSec - now) / 60));
          if (best === null || m < best) best = m;
        }
      }
    }
    return { arrivals: best != null ? [{ minutes: best }] : [], source: "google" };
  } catch {
    return { arrivals: [], source: "google" };
  }
}

// Prefiere XOR: si Google llega primero, espera 'graceMs' para ver si aparece XOR con datos.
async function preferXor(pXor, pGoogle, { graceMs = 1200, timeoutMs = 6500 } = {}) {
  return new Promise((resolve) => {
    let resolved = false, xorRes, googleRes;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };

    pXor.then(r => { xorRes = r; if (r.arrivals?.length) done(r); })
        .catch(()=>{});

    pGoogle.then(r => {
      googleRes = r;
      if (xorRes?.arrivals?.length) return done(xorRes);
      // Google llegó primero: esperamos una ventana corta por XOR
      setTimeout(() => {
        if (xorRes?.arrivals?.length) done(xorRes);
        else if (r.arrivals?.length) done(r);
      }, graceMs);
    }).catch(()=>{});

    setTimeout(() => {
      if (!resolved) {
        if (xorRes?.arrivals?.length) done(xorRes);
        else if (googleRes?.arrivals?.length) done(googleRes);
        else done(xorRes || googleRes || { arrivals: [], source: "none" });
      }
    }, timeoutMs);
  });
}
