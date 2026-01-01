export function createMap(mapboxToken, containerId = "map") {
  if (!mapboxToken) throw new Error("Missing Mapbox token");
  mapboxgl.accessToken = mapboxToken;

  const map = new mapboxgl.Map({
    container: containerId,
    style: "mapbox://styles/mapbox/light-v11",
    center: [34.7818, 32.0853],
    zoom: 10.6
  });

  const markers = new Map(); // assetId -> { marker, el }

  function setView({ lat, lng, zoom }) {
    map.flyTo({ center: [lng, lat], zoom, essential: true });
  }

  function clearAssets() {
    for (const m of markers.values()) m.marker.remove();
    markers.clear();
  }

  function showAssets(assets) {
    clearAssets();
    for (const a of assets) {
      const el = document.createElement("div");
      el.style.width = "10px";
      el.style.height = "10px";
      el.style.borderRadius = "50%";
      el.style.background = "#2563eb";
      el.style.border = "2px solid #fff";

      const marker = new mapboxgl.Marker(el)
        .setLngLat([a.lng, a.lat])
        .setPopup(new mapboxgl.Popup({ offset: 18 }).setHTML(
          `<div style="font-family:Arial; font-size:12px; line-height:1.25;">
            <b>${escapeHtml(a.name)}</b><br/>
            Sector: ${escapeHtml(a.sector)}<br/>
            Subtype: ${escapeHtml(a.subtype || "")}<br/>
            Criticality: ${Number(a.criticality || 0)}
          </div>`
        ))
        .addTo(map);

      markers.set(a.id, { marker, el });
    }
  }

  return { map, setView, showAssets, clearAssets };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}
