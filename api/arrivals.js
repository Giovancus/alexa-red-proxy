// /api/arrivals.js
// Soporta dos formatos del upstream:
//  A) services[].arrivals[] con {minutes|min|eta}
//  B) buses[] con {min_arrival_time|max_arrival_time} (el que estás viendo)

export default async function handler(req, res) {
  try {
    const stop = String(req.query.stop || "PH645").toUpperCase();
    const service = String(req.query.service || "H09").toUpperCase().replace(/\s|-/g, "");

    const r = await fetch(
      `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stop)}`,
      { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
    const data = await r.json();

    const arrivals = [];

    // --- Formato A: services[].arrivals[] ---
    const services = Array.isArray(data?.services) ? data.services : [];
    for (const s of services) {
      const sid = String(s?.id || s?.name || "").toUpperCase().replace(/\s|-/g, "");
      if (!sid.includes(service)) continue;
      const arr = Array.isArray(s?.arrivals) ? s.arrivals : [];
      for (const a of arr) {
        const m = [a?.minutes, a?.min, a?.eta]
          .map(Number).find(n => Number.isFinite(n));
        if (Number.isFinite(m)) arrivals.push({ minutes: m });
      }
    }

    // --- Formato B: top-level buses[] con min/max ---
    // Úsalo si encontramos el servicio pedido en data.services
    // (da igual si hay 1 o más; en tu paradero es H09).
    if (arrivals.length === 0) {
      const hasTarget = services.some(s =>
        String(s?.id || s?.name || "").toUpperCase().replace(/\s|-/g, "").includes(service)
      );
      if (hasTarget) {
        const buses = Array.isArray(data?.buses) ? data.buses : [];
        for (const b of buses) {
          const min = Number(b?.min_arrival_time);
          const max = Number(b?.max_arrival_time);
          if (Number.isFinite(min)) arrivals.push({ minutes: min });
          if (Number.isFinite(max) && max !== min) arrivals.push({ minutes: max });
        }
      }
    }

    arrivals.sort((a, b) => a.minutes - b.minutes);
    return res.status(200).json({ arrivals });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
