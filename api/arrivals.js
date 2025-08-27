// /api/arrivals.js
// USO: /api/arrivals?stop=PH645&service=H09
// Soporta dos formatos del upstream:
//  A) services[].arrivals[] con {minutes|min|eta}
//  B) buses[] con {min_arrival_time|max_arrival_time}
//    (si solo hay 1 servicio en data.services y coincide con ?service)

export default async function handler(req, res) {
  try {
    const stop = String(req.query.stop || "PH645").toUpperCase();
    const service = String(req.query.service || "H09").toUpperCase().replace(/\s|-/g, "");

    const upstream = await fetch(
      `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stop)}`,
      { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream ${upstream.status}` });
    }
    const data = await upstream.json();

    const arrivals = [];

    // --- Intento 1: formato clásico services[].arrivals[] ---
    const services = Array.isArray(data?.services) ? data.services : [];
    for (const s of services) {
      const id = String(s?.id || s?.name || "").toUpperCase().replace(/\s|-/g, "");
      if (!id.includes(service)) continue;
      const arr = Array.isArray(s?.arrivals) ? s.arrivals : [];
      for (const a of arr) {
        const m =
          [a?.minutes, a?.min, a?.eta, a?.min_arrival_time, a?.max_arrival_time]
            .map(v => Number(v)).find(n => Number.isFinite(n));
        if (Number.isFinite(m)) arrivals.push({ minutes: m });
      }
    }

    // --- Intento 2: formato nuevo top-level buses[] ---
    // Solo lo usamos si NO encontramos nada arriba,
    // y si hay exactamente 1 servicio y coincide con ?service.
    if (arrivals.length === 0) {
      const buses = Array.isArray(data?.buses) ? data.buses : [];
      const onlyService = services.length === 1
        ? String(services[0]?.id || "").toUpperCase().replace(/\s|-/g, "")
        : null;
      if (onlyService && onlyService.includes(service)) {
        for (const b of buses) {
          const m =
            [b?.min_arrival_time, b?.minutes, b?.eta, b?.min]
              .map(v => Number(v)).find(n => Number.isFinite(n));
          if (Number.isFinite(m)) arrivals.push({ minutes: m });
        }
      }
    }

    arrivals.sort((a, b) => a.minutes - b.minutes);
    return res.status(200).json({ arrivals });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
