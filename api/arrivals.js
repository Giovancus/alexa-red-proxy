// /api/arrivals.js
// Devuelve llegadas como objetos con rango cuando el upstream trae min/max,
// y como "minutes" cuando solo hay un valor. Ordena por el valor mínimo.

const norm = (s) => String(s || "").toUpperCase().replace(/\s|-/g, "");

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

    const out = [];
    const addRange = (min, max) => {
      const a = Number(min), b = Number(max);
      if (Number.isFinite(a) && Number.isFinite(b)) out.push({ min: a, max: b });
      else if (Number.isFinite(a)) out.push({ minutes: a });
      else if (Number.isFinite(b)) out.push({ minutes: b });
    };
    const addSingle = (m) => {
      const n = Number(m);
      if (Number.isFinite(n)) out.push({ minutes: n });
    };

    const services = Array.isArray(data?.services) ? data.services : [];

    // A) services[].buses[] con min/max  ← tu caso
    for (const s of services) {
      const sid = norm(s?.id || s?.name);
      if (!sid.includes(target)) continue;
      if (Array.isArray(s?.buses)) {
        for (const b of s.buses) addRange(b?.min_arrival_time, b?.max_arrival_time);
      }
      // B) services[].arrivals[] con minutes/min/eta
      if (Array.isArray(s?.arrivals)) {
        for (const a of s.arrivals) addSingle(a?.minutes ?? a?.min ?? a?.eta);
      }
    }

    // C) buses[] a nivel raíz si no salió nada arriba
    if (!out.length && Array.isArray(data?.buses)) {
      for (const b of data.buses) addRange(b?.min_arrival_time, b?.max_arrival_time);
    }

    // Orden por mínimo conocido
    out.sort((x, y) => (x.minutes ?? x.min ?? 9e9) - (y.minutes ?? y.min ?? 9e9));

    return res.status(200).json({ arrivals: out });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
