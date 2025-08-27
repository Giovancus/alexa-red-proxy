// /api/arrivals.js
// Soporta 3 variantes del upstream:
//  A) services[].buses[] -> { min_arrival_time, max_arrival_time, ... }  ← TU CASO
//  B) services[].arrivals[] -> { minutes|min|eta }
//  C) buses[] a nivel raíz  -> { min_arrival_time|max_arrival_time }

const norm = (s) => String(s || "").toUpperCase().replace(/\s|-/g, "");
const addIfNum = (arr, v) => {
  const n = Number(v);
  if (Number.isFinite(n)) arr.push(n);
};

export default async function handler(req, res) {
  try {
    const stop = norm(req.query.stop || "PH645");
    const target = norm(req.query.service || "H09");

    const r = await fetch(
      `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stop)}`,
      { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
    const data = await r.json();

    const minutes = [];

    // ---- A) services[].buses[]  (TU JSON)
    const services = Array.isArray(data?.services) ? data.services : [];
    for (const s of services) {
      const sid = norm(s?.id || s?.name);
      if (!sid.includes(target)) continue;

      // A1: buses[]
      if (Array.isArray(s?.buses)) {
        for (const b of s.buses) {
          addIfNum(minutes, b?.min_arrival_time);
          addIfNum(minutes, b?.max_arrival_time);
          addIfNum(minutes, b?.minutes);
          addIfNum(minutes, b?.eta);
          addIfNum(minutes, b?.min);
        }
      }

      // B) arrivals[]
      if (Array.isArray(s?.arrivals)) {
        for (const a of s.arrivals) {
          addIfNum(minutes, a?.minutes);
          addIfNum(minutes, a?.min);
          addIfNum(minutes, a?.eta);
          addIfNum(minutes, a?.min_arrival_time);
          addIfNum(minutes, a?.max_arrival_time);
        }
      }
    }

    // C) buses[] a nivel raíz (solo si aún no obtuvimos nada)
    if (!minutes.length && Array.isArray(data?.buses)) {
      for (const b of data.buses) {
        addIfNum(minutes, b?.min_arrival_time);
        addIfNum(minutes, b?.max_arrival_time);
        addIfNum(minutes, b?.minutes);
        addIfNum(minutes, b?.eta);
        addIfNum(minutes, b?.min);
      }
    }

    // Normaliza, deduplica y ordena
    const uniqSorted = [...new Set(minutes)].sort((a, b) => a - b);
    return res.status(200).json({ arrivals: uniqSorted.map(m => ({ minutes: m })) });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
