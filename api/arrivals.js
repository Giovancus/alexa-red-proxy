// /api/arrivals.js
// 1) Intenta XOR (no oficial). Si no hay datos, cae a Google (TRANSIT) y
//    devuelve el próximo horario de la línea H09 desde PH645 hacia un destino fijo.
// 2) Devuelve SIEMPRE: { arrivals: [ {min, max} | {minutes} ... ] }, ordenado por tiempo.
// 3) Para probar Google forzado en navegador: agrega &force_google=1 a la URL.
//
// Env vars en Vercel:
// GMAPS_API_KEY, PH645_LAT, PH645_LNG, DEST_PLACE_ID_H09

const norm = (s) => String(s || "").toUpperCase().replace(/\s|-/g, "");

const GMAPS_KEY = process.env.GMAPS_API_KEY || "";
const PH645_LAT = Number(process.env.PH645_LAT);
const PH645_LNG = Number(process.env.PH645_LNG);
const DEST_PLACE_ID_H09 = process.env.DEST_PLACE_ID_H09 || "";

const hasGoogleCfg = () =>
  Boolean(GMAPS_KEY && Number.isFinite(PH645_LAT) && Number.isFinite(PH645_LNG) && DEST_PLACE_ID_H09);

export default async function handler(req, res) {
  try {
    const stop = norm(req.query.stop || "PH645");
    const target = norm(req.query.service || "H09");
    const forceGoogle = String(req.query.force_google || req.query.fg || "").trim() === "1";

    // ---------- 1) ORIGEN PRIMARIO: XOR (si no forzamos Google) ----------
    if (!forceGoogle) {
      try {
        const u = `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stop)}`;
        const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } });
        if (r.ok) {
          const data = await r.json();
          const out = pickFromXor(data, target);
          if (out.length) return res.status(200).json({ arrivals: out });
        }
      } catch (_) { /* sigue a Google */ }
    }

    // ---------- 2) FALLBACK: Google (solo PH645/H09 con config válida) ----------
    if (stop === "PH645" && target === "H09" && hasGoogleCfg()) {
      const out = await fromGoogleTransit({ lat: PH645_LAT, lng: PH645_LNG }, DEST_PLACE_ID_H09, target, GMAPS_KEY);
      return res.status(200).json({ arrivals: out });
    }

    // sin datos
    return res.status(200).json({ arrivals: [] });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

// ---- Lectura de formatos de XOR ----
function pickFromXor(data, target) {
  const minutes = [];

  const services = Array.isArray(data?.services) ? data.services : [];
  for (const s of services) {
    const sid = norm(s?.id || s?.name);
    if (!sid.includes(target)) continue;

    // A) services[].buses[] con min/max (caso real reciente)
    if (Array.isArray(s?.buses)) {
      for (const b of s.buses) {
        addIfNum(minutes, b?.min_arrival_time);
        addIfNum(minutes, b?.max_arrival_time);
      }
    }
    // B) services[].arrivals[] con minutes/min/eta (formato clásico)
    if (Array.isArray(s?.arrivals)) {
      for (const a of s.arrivals) {
        addIfNum(minutes, a?.minutes);
        addIfNum(minutes, a?.min);
        addIfNum(minutes, a?.eta);
      }
    }
  }

  const uniqSorted = [...new Set(minutes)].sort((a, b) => a - b);

  // Si parecen venir en pares (min,max) del mismo bus, empaqueta como rango.
  // (Heurística: diferencia <= 6 minutos y ordenado).
  const output = [];
  for (let i = 0; i < uniqSorted.length; i += 2) {
    const a = uniqSorted[i], b = uniqSorted[i + 1];
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 6) {
      output.push({ min: a, max: b });
    } else if (Number.isFinite(a)) {
      output.push({ minutes: a });
      if (Number.isFinite(b)) output.push({ minutes: b });
    }
  }
  return output;
}
function addIfNum(arr, v) { const n = Number(v); if (Number.isFinite(n)) arr.push(n); }

// ---- Fallback Google Directions (TRANSIT) ----
// Devuelve [{minutes:N}] con el próximo departure_time para la línea target.
async function fromGoogleTransit(originLatLng, destPlaceId, target, apiKey) {
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
    if (!r.ok) return [];

    const dj = await r.json();
    const now = Math.floor(Date.now() / 1000);
    let best = null;

    for (const route of dj.routes || []) {
      for (const leg of route.legs || []) {
        for (const step of leg.steps || []) {
          if (step.travel_mode !== "TRANSIT") continue;
          const td = step.transit_details || {};
          const line = td.line || {};
          const shortName =
            (line.short_name || line.name_short || line.name || "").toString().toUpperCase().replace(/\s|-/g, "");
          if (shortName !== target) continue;

          const dep = td.departure_time;
          const depSec = typeof dep?.value === "number" ? dep.value : Number(dep);
          if (!Number.isFinite(depSec)) continue;

          const minutes = Math.max(0, Math.round((depSec - now) / 60));
          if (best === null || minutes < best) best = minutes;
        }
      }
    }

    return best != null ? [{ minutes: best }] : [];
  } catch {
    return [];
  }
}
