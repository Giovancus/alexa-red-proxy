// /api/arrivals.js
// USO: /api/arrivals?stop=PH645&service=H09
// Fuente de ejemplo NO OFICIAL: https://api.xor.cl/red/bus-stop/{STOP}

export default async function handler(req, res) {
  try {
    const { stop = "PH645", service = "H09" } = req.query;
    const stopId = String(stop).toUpperCase();
    const serviceId = String(service).toUpperCase();

    const upstream = await fetch(
      `https://api.xor.cl/red/bus-stop/${encodeURIComponent(stopId)}`,
      { signal: AbortSignal.timeout(6000) }
    );

    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream ${upstream.status}` });
    }
    const data = await upstream.json();

    const list = [];
    const services = Array.isArray(data?.services) ? data.services : [];
    const target = serviceId.replace(/\s|-/g, "");
    for (const s of services) {
      const name = String(s?.id || s?.name || "").toUpperCase().replace(/\s|-/g, "");
      if (!name.includes(target)) continue;
      const arrivals = Array.isArray(s?.arrivals) ? s.arrivals : [];
      for (const a of arrivals) {
        const m = Number(a?.minutes ?? a?.min ?? a?.eta ?? NaN);
        if (Number.isFinite(m)) list.push({ minutes: m });
      }
    }

    list.sort((a, b) => a.minutes - b.minutes);
    return res.status(200).json({ arrivals: list });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
