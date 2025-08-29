// /api/arrivals.js
// Mejora: race XOR vs Google, cache 15s, y campo "source" en la respuesta.
//
// Env vars en Vercel (Settings → Environment Variables):
// GMAPS_API_KEY, PH645_LAT, PH645_LNG, DEST_PLACE_ID_H09
//
// Prueba en navegador:
//  - Normal: https://<tu>.vercel.app/api/arrivals?stop=PH645&service=H09
//  - Forzar Google: ...&force_google=1

const norm = (s) => String(s || "").toUpperCase().replace(/\s|-/g, "");

const GMAPS_KEY = process.env.GMAPS_API_KEY || "";
const PH645_LAT = Number(process.env.PH645_LAT);
const PH645_LNG = Number(process.env.PH645_LNG);
const DEST_PLACE_ID_H09 = process.env.DEST_PLACE_ID_H09 || "";

const hasGoogleCfg = () =>
  Boolean(GMAPS_KEY && Number.isFinite(PH645_LAT) && Number.isFinite(PH645_LNG) && DEST_PLACE_ID_H09);

export default async function handler(req, res) {
  try {
    // cache CDN 15s + stale-while-revalidate
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.setHeader("CDN-Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.setHeader("Vercel-CDN-Cache-Control", "s-maxage=15, stale-while-revalidate=30");

    const stop = norm(req.query.stop || "PH645");
    const target = norm(req.query.service || "H09");
    const forceGoogle = String(req.query.force_google || req.query.fg || "") === "1";

    // preparar promesas
    const allowGoogle = stop === "PH1474" && target === "H09" && hasGoogleCfg();

    const pXor = forceGoogle
      ? Promise.resolve({ arrivals: [], source: "xor" })
      : getFromXor(stop, target);

    const pGoogle = allowGoogle
      ? getFromGoogle({ lat: PH645_LAT, lng: PH645_LNG }, DEST_PLACE_ID_H09, target, GMAPS_KEY)
      : Promise.resolve({ arrivals: [], source: "google" });

    // devolver la PRIMERA que traiga datos
    const winner = await firstWithData([pXor, pGoogle], 6500);
    return res.status(200).json(winner || { arrivals: [], source: "none" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
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
    // Empaquetar en rangos si parecen pares (min,max) del mismo bus
    const out = [];
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
    return { arrivals: best != null ? [{ minutes: best }] : [], source: "google" };
  } catch {
    return { arrivals: [], source: "google" };
  }
}

// Espera la primera promesa que devuelva arrivals NO vacíos (o entrega la mejor disponible tras timeout)
async function firstWithData(promises, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false, settled = 0, last = null;
    const tryResolve = (res) => {
      last = res;
      if (!resolved && res && Array.isArray(res.arrivals) && res.arrivals.length) {
        resolved = true; resolve(res);
      }
    };
    for (const p of promises) {
      p.then(tryResolve).catch(()=>{}).finally(() => {
        settled++;
        if (settled === promises.length && !resolved) resolve(last || { arrivals: [], source: "none" });
      });
    }
    setTimeout(() => { if (!resolved) resolve(last || { arrivals: [], source: "none" }); }, timeoutMs);
  });
}
