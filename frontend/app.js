/**
 * app.js
 * - Preserves existing HTML/CSS structure (no SPA router assumptions).
 * - English-only.
 * - Uses api.js for backend calls, with fallback.
 *
 * Fixes included:
 * 1) updateAssetsOnMap(): removed out-of-scope `src` usage; `ASSETS_COUNT` updates correctly.
 * 2) applyActionsSoft(): added MAP_SET_VIEW support (flyTo) so map centers/zooms as intended.
 * 3) On approval: apply soft actions first (e.g., MAP_SET_VIEW), then execute to get artifacts (assets/sim_status).
 */

import { SECTORS, ASSET_STATUS } from "./constants.js";
import { apiChat, apiExecute, localFallbackReply } from "./api.js";

let MAP = null;
let SIM_RUNNING = false;
let ASSETS_COUNT = 0; // source of truth for "are there assets on the map?"
let PRESENT_SECTORS = new Set();
let CURRENT_CITY = localStorage.getItem("ginom.currentCity") || "Jerusalem";
// Local asset cache (all assets ever loaded)
let ALL_ASSETS = [];
// What sectors are currently visible on the map
let VISIBLE_SECTORS = new Set();
// === GINOM DEPENDENCIES (BEGIN) ===
// Draw dependency chain on the map when clicking an asset.

const BACKEND_BASE =
  (window.DEMO_BACKEND_BASE && String(window.DEMO_BACKEND_BASE)) ||
  "http://localhost:3000";

let __depsBgClickBound = false;
let __lastAssetLayerClickAt = 0;

function ensureDependencyLayers(map) {
  if (!map) return;

  if (!map.getSource("ginom-deps")) {
    map.addSource("ginom-deps", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getSource("ginom-chain-selected")) {
    map.addSource("ginom-chain-selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getSource("ginom-chain-related")) {
    map.addSource("ginom-chain-related", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }

  const beforeId = map.getLayer("ginom-assets-circle") ? "ginom-assets-circle" : undefined;

  if (!map.getLayer("ginom-deps-line-glow")) {
    map.addLayer(
      {
        id: "ginom-deps-line-glow",
        type: "line",
        source: "ginom-deps",
        paint: {
          // CHANGED: glow follows edge color (soft)
          "line-color": [
            "case",
            ["==", ["get", "same_sector"], 1],
            "rgba(30, 66, 172, 0.65)",  // blue-ish glow
            "rgba(239, 68, 68, 0.55)",  // red-ish glow
          ],
          "line-width": 6,
          "line-opacity": 0.35,
          "line-blur": 4,
        },
      },
      beforeId
    );
  }

  if (!map.getLayer("ginom-deps-line")) {
    map.addLayer(
      {
        id: "ginom-deps-line",
        type: "line",
        source: "ginom-deps",
        paint: {
          // CHANGED: blue if same sector, red if cross-sector
          "line-color": [
            "case",
            ["==", ["get", "same_sector"], 1],
            "#1E42AC", // blue
            "#EF4444", // red
          ],
          "line-width": 2,
          "line-opacity": 0.9,
        },
      },
      beforeId
    );
  }


  if (!map.getLayer("ginom-chain-related-circle")) {
    map.addLayer({
      id: "ginom-chain-related-circle",
      type: "circle",
      source: "ginom-chain-related",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 7, 15, 10],
        "circle-color": "rgba(30, 66, 172, 0.18)",
        "circle-stroke-color": "rgba(30, 66, 172, 0.85)",
        "circle-stroke-width": 2,
      },
    });
  }

  if (!map.getLayer("ginom-chain-selected-circle")) {
    map.addLayer({
      id: "ginom-chain-selected-circle",
      type: "circle",
      source: "ginom-chain-selected",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 12, 10, 15, 14],
        "circle-color": "rgba(30, 66, 172, 0.30)",
        "circle-stroke-color": "#1E42AC",
        "circle-stroke-width": 3,
      },
    });
  }
}

function clearDependencyChain() {
  if (!MAP) return;
  MAP.getSource("ginom-deps")?.setData({ type: "FeatureCollection", features: [] });
  MAP.getSource("ginom-chain-selected")?.setData({ type: "FeatureCollection", features: [] });
  MAP.getSource("ginom-chain-related")?.setData({ type: "FeatureCollection", features: [] });
}

function toPointFeature(a, extraProps = {}) {
  if (!a) return null;
  const lng = Number(a.lng);
  const lat = Number(a.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  return {
    type: "Feature",
    properties: {
      id: a.id,
      name: a.name,
      sector: a.sector,
      subtype: a.subtype,
      criticality: a.criticality,
      ...extraProps,
    },
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

function depsEdgesToGeoJSON(edges = [], assetsById = new Map()) {
  return {
    type: "FeatureCollection",
    features: (edges || [])
      .map((e) => {
        const from = assetsById.get(e.from);
        const to = assetsById.get(e.to);
        if (!from || !to) return null;

        const aLng = Number(from.lng), aLat = Number(from.lat);
        const bLng = Number(to.lng), bLat = Number(to.lat);
        if (![aLng, aLat, bLng, bLat].every(Number.isFinite)) return null;

        const fromSector = String(from.sector || "");
        const toSector = String(to.sector || "");
        const sameSector = fromSector && toSector && fromSector === toSector;

        return {
          type: "Feature",
          properties: {
            from: e.from,
            to: e.to,
            dependency_type: e.dependency_type || "",
            priority: e.priority ?? null,
            level: e.level ?? null,

            // NEW: for styling
            from_sector: fromSector,
            to_sector: toSector,
            same_sector: sameSector ? 1 : 0, // use 0/1 for Mapbox expressions
          },
          geometry: { type: "LineString", coordinates: [[aLng, aLat], [bLng, bLat]] },
        };
      })
      .filter(Boolean),
  };
}

async function showDependencyChain(assetId, { direction = "upstream", maxDepth = 4, fitBounds = false } = {}) {
  if (!MAP || !assetId) return;

  ensureDependencyLayers(MAP);

  const url =
    `${BACKEND_BASE}/api/dependencies/chain?` +
    `asset_id=${encodeURIComponent(assetId)}` +
    `&direction=${encodeURIComponent(direction)}` +
    `&max_depth=${encodeURIComponent(String(maxDepth))}`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn("Failed to load dependency chain:", err);
    return;
  }

  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(assetId);

  const selectedFeature = root ? [toPointFeature(root, { kind: "selected" })].filter(Boolean) : [];
  const relatedFeatures = nodes
    .filter((n) => n && n.id && n.id !== assetId)
    .map((n) => toPointFeature(n, { kind: "related" }))
    .filter(Boolean);

  const depsGeo = depsEdgesToGeoJSON(edges, byId);

  MAP.getSource("ginom-deps")?.setData(depsGeo);
  MAP.getSource("ginom-chain-selected")?.setData({ type: "FeatureCollection", features: selectedFeature });
  MAP.getSource("ginom-chain-related")?.setData({ type: "FeatureCollection", features: relatedFeatures });

  if (fitBounds) {
    const coords = [...selectedFeature, ...relatedFeatures].map((f) => f.geometry.coordinates);
    if (coords.length) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const [lng, lat] of coords) {
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
      MAP.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 80, duration: 650 });
    }
  }
}

// === GINOM DEPENDENCIES (END) ===


function updateUiVisibility() {
  setVisibleClass("healthOverlay", hasAssetsOnMap());
  setVisibleClass("activeScenarioCard", SIM_RUNNING);
  setImpactTimelineVisible(SIM_RUNNING);
}

/* =========================
   Safe icon init (if Lucide exists)
   ========================= */
try {
  if (window.lucide?.createIcons) window.lucide.createIcons();
} catch (_) {}

/* =========================
   Helpers
   ========================= */

function tryHandleLocalSectorCommand(message) {
  const m = message.toLowerCase().trim();

  const addMatch = m.match(/^add\s+([a-z_]+)/);
  const removeMatch = m.match(/^remove\s+([a-z_]+)/);

  if (m === "clear all") {
    VISIBLE_SECTORS.clear();
    updateAssetsOnMap([], { fitBounds: false });
    appendBubble({ role: "bot", text: "All sectors removed from the map." });
    return true;
  }

  if (addMatch) {
    const sector = addMatch[1];
    VISIBLE_SECTORS.add(sector);

    const filtered = ALL_ASSETS.filter(r => VISIBLE_SECTORS.has(r.sector));
    updateAssetsOnMap(filtered, { fitBounds: true });

    appendBubble({ role: "bot", text: `Sector "${sector}" added to the map.` });
    return true;
  }

  if (removeMatch) {
    const sector = removeMatch[1];
    VISIBLE_SECTORS.delete(sector);

    const filtered = ALL_ASSETS.filter(r => VISIBLE_SECTORS.has(r.sector));
    updateAssetsOnMap(filtered, { fitBounds: false });

    appendBubble({ role: "bot", text: `Sector "${sector}" removed from the map.` });
    return true;
  }

  return false; // not a local command
}

function el(sel, root = document) {
  return root.querySelector(sel);
}
function els(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function hasAssetsOnMap() {
  return ASSETS_COUNT > 0;
}

function setVisibleClass(id, on) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-visible", !!on);
}

function updateHealthBarsVisibility() {
  const cards = document.querySelectorAll(".overlay--health .metric.card[data-sector]");
  if (!cards.length) return;

  cards.forEach((card) => {
    const key = card.getAttribute("data-sector");
    const show = PRESENT_SECTORS.has(key);
    card.style.display = show ? "" : "none";
  });
}

function setImpactTimelineVisible(visible) {
  const elTL = document.querySelector(".impact-timeline");
  if (!elTL) return;
  elTL.classList.toggle("is-hidden", !visible);
}

function scrollChatToBottom(force = false) {
  const body = el(".assistant__body");
  if (!body) return;

  // If user scrolled up manually, don't force unless requested
  const nearBottom =
    body.scrollHeight - body.scrollTop - body.clientHeight < 40;

  if (nearBottom || force) {
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hhmm(d = new Date()) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* =========================
   Chat UI (existing DOM structure)
   ========================= */
function appendBubble({ role, text, isProgress = false, extraHTML = "" }) {
  const body = el(".assistant__body");
  if (!body) return null;

  const bubble = document.createElement("div");
  bubble.className =
    `chat-bubble ${role === "user" ? "chat-bubble--user" : "chat-bubble--bot"}` +
    (isProgress ? " chat-bubble--progress" : "");

  bubble.innerHTML = `
    <div class="chat-bubble__text">${escapeHtml(text).replaceAll("\n", "<br/>")}${extraHTML}</div>
    <div class="chat-bubble__time">${hhmm()}</div>
  `;

  body.appendChild(bubble);
  scrollChatToBottom(true);

  return bubble;
}

/**
 * Soft / non-disruptive actions the client can execute immediately.
 * IMPORTANT: Back-end can still return artifacts after /execute (assets, sim_status, etc.).
 */
function applyActionsSoft(actions = []) {
  for (const a of actions) {
    if (!a?.type) continue;

    if (a.type === "NAVIGATE" && a.payload?.url) {
      console.log("MAP_SET_VIEW payload:", a.payload.city);
      window.location.href = a.payload.url;
      continue;
    }

    // NEW: Map centering/zooming from actions
    if (a.type === "MAP_SET_VIEW" && a.payload && MAP) {
      
      const lat = Number(a.payload.lat);
      const lng = Number(a.payload.lng);
      const zoom = a.payload.zoom != null ? Number(a.payload.zoom) : undefined;
      console.log("MAP_SET_VIEW payload:", a.payload);
      // NEW: persist current city so the sim modal uses the correct area
      if (a?.payload?.city) {
        CURRENT_CITY = a.payload.city;
        localStorage.setItem("ginom.currentCity", CURRENT_CITY);
      }


      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        try {
          MAP.flyTo({
            center: [lng, lat],
            zoom: Number.isFinite(zoom) ? zoom : MAP.getZoom(),
            speed: 1.2,
            curve: 1.4,
            essential: true,
          });
        } catch (e) {
          console.warn("MAP_SET_VIEW flyTo failed:", e);
        }
      }
      continue;
    }

    // Leave other action types (e.g., MAP_SHOW_ASSETS, SIM_RUN) to /execute.
  }
}

function renderApproval(actions = [], onApprove) {
  const body = el(".assistant__body");
  if (!body) return;

  const wrapper = document.createElement("div");
  wrapper.className = "quick-card";
  wrapper.innerHTML = `
    <button class="quick-btn" type="button" data-approve="1">
      <i data-lucide="check-circle"></i> Approve actions
    </button>
    <button class="quick-btn" type="button" data-reject="1">
      <i data-lucide="x-circle"></i> Reject
    </button>
    <div class="hint" style="margin-top:6px; font-size:11px; color: rgba(26,26,26,0.70); font-weight:800;">
      Demo safety: potentially disruptive actions require approval.
    </div>
  `;

  const last = body.lastElementChild;
  if (last && last.classList.contains("chat-bubble")) {
    const textEl = last.querySelector(".chat-bubble__text");
    if (textEl) textEl.appendChild(wrapper);
    else body.appendChild(wrapper);
  } else {
    body.appendChild(wrapper);
  }

  try {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  } catch (_) {}

  wrapper.querySelector('[data-approve="1"]')?.addEventListener("click", async () => {
    wrapper.remove();
    await onApprove?.();
  });

  wrapper.querySelector('[data-reject="1"]')?.addEventListener("click", () => {
    wrapper.remove();
    appendBubble({
      role: "bot",
      text: "Understood — actions rejected. Tell me what you want to change.",
    });
  });
}

/* =========================
   Map Assets (GeoJSON circles)
   ========================= */
function ensureAssetsLayer(map) {
  if (!map) return;
  if (map.getSource("ginom-assets")) return;

  map.addSource("ginom-assets", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "ginom-assets-circle",
    type: "circle",
    source: "ginom-assets",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 5, 15, 8],
      "circle-color": [
        "match",
        ["get", "sector"],
        "electricity",
        SECTORS.electricity.color,
        "water",
        SECTORS.water.color,
        "gas",
        SECTORS.gas.color,
        "communication",
        SECTORS.communication.color,
        "first_responders",
        SECTORS.first_responders.color,
        "#94A3B8",
      ],
      "circle-stroke-color": "rgba(255,255,255,0.9)",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  });

  // Hover cursor
  map.on("mouseenter", "ginom-assets-circle", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "ginom-assets-circle", () => (map.getCanvas().style.cursor = ""));

  // Popup on click
  map.on("click", "ginom-assets-circle", (e) => {
    const f = e.features?.[0];
    if (!f) return;

    const p = f.properties || {};
    const name = p.name || p.id || "Asset";
    const sectorKey = p.sector || "unknown";
    const sectorLabel = SECTORS[sectorKey]?.label || sectorKey;
    const subtype = p.subtype || "";
    const criticality = p.criticality ?? "";

    const html = `
      <div style="font-family: Geist, Arial; min-width: 220px;">
        <div style="font-weight:800; margin-bottom:6px;">${escapeHtml(name)}</div>
        <div style="font-size:12px; line-height:1.35;">
          <div><b>Sector:</b> ${escapeHtml(sectorLabel)}</div>
          <div><b>Type:</b> ${escapeHtml(subtype)}</div>
          <div><b>Criticality:</b> ${escapeHtml(criticality)}</div>
        </div>
      </div>
    `;

    new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
            // === GINOM DEPENDENCIES (BEGIN) ===
      __lastAssetLayerClickAt = Date.now();
      showDependencyChain(String(p.id || ""), { direction: "upstream", maxDepth: 4, fitBounds: false });
      // === GINOM DEPENDENCIES (END) ===

  });
    // === GINOM DEPENDENCIES (BEGIN): clear chain on empty map click ===
  if (!__depsBgClickBound) {
    __depsBgClickBound = true;
    map.on("click", (e) => {
      if (Date.now() - __lastAssetLayerClickAt < 250) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: ["ginom-assets-circle"] });
      if (!hits.length) clearDependencyChain();
    });
  }
  // === GINOM DEPENDENCIES (END) ===

}

function assetsToGeoJSON(rows = []) {
  return {
    type: "FeatureCollection",
    features: rows
      .filter((r) => Number.isFinite(Number(r.lng)) && Number.isFinite(Number(r.lat)))
      .map((r) => ({
        type: "Feature",
        properties: {
          id: r.id,
          name: r.name,
          sector: r.sector,
          subtype: r.subtype,
          criticality: r.criticality,
        },
        geometry: {
          type: "Point",
          coordinates: [Number(r.lng), Number(r.lat)],
        },
      })),
  };
}

/**
 * FIXED: updates map source exactly once, in the correct scope, and updates ASSETS_COUNT reliably.
 */
function updateAssetsOnMap(rows = [], { fitBounds = true } = {}) {
  if (!MAP) return;

  const doUpdate = () => {
    ensureAssetsLayer(MAP);

    const src = MAP.getSource("ginom-assets");
    if (!src) {
      console.warn("Map source 'ginom-assets' not found (ensureAssetsLayer may have failed).");
      return;
    }

    // Build GeoJSON and update map
    const geo = assetsToGeoJSON(rows);
    src.setData(geo);

    // Update sector visibility set based on CURRENT rows
    PRESENT_SECTORS = new Set(
      (rows || [])
        .map(r => String(r.sector || "").trim())
        .filter(Boolean)
    );

    // Show only relevant sector health cards
    updateHealthBarsVisibility();

    // Overlay container visibility (your existing logic)
    ASSETS_COUNT = geo.features.length;
    updateUiVisibility();

    // Fit bounds only when we have features
    if (fitBounds && geo.features.length) {
      let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;

      for (const f of geo.features) {
        const [lng, lat] = f.geometry.coordinates;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }

      MAP.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 60, duration: 800 }
      );
    }
  };

  // Ensure map is ready before updating sources/layers
  if (!MAP.loaded()) {
    MAP.once("load", () => {
      // Sometimes style isn't fully ready right at "load" - wait for idle
      MAP.once("idle", doUpdate);
    });
    return;
  }

  // Map is loaded, but style might be mid-refresh; idle is safest for layers/sources
  if (!MAP.isStyleLoaded?.() || !MAP.isStyleLoaded()) {
    MAP.once("idle", doUpdate);
    return;
  }

  doUpdate();
}

function applyExecuteArtifacts(execResult) {
  const artifacts = execResult?.artifacts || [];

  for (const a of artifacts) {
    if (a?.type === "assets" && Array.isArray(a.data)) {
      // Cache once (or refresh cache)
      ALL_ASSETS = a.data;

      // If nothing selected yet → show everything received
      if (VISIBLE_SECTORS.size === 0) {
        VISIBLE_SECTORS = new Set(a.data.map(r => r.sector));
      }

      // Render only visible sectors
      const filtered = a.data.filter(r => VISIBLE_SECTORS.has(r.sector));
      updateAssetsOnMap(filtered, { fitBounds: true });
    }

    if (a?.type === "sim_status") {
      const state = String(a?.data?.state || "").toLowerCase();
      SIM_RUNNING = state === "running" || state === "started" || state === "in_progress";
      updateUiVisibility();
    }
  }

  // Safety: even if no artifacts, re-align UI
  updateUiVisibility();
}

/* =========================
   Read Simulation Config (only if simconf.html fields exist)
   ========================= */
function readSimConfigFromForm() {
  const scenario = el("#scenario");
  if (!scenario) return null; // not on simconf.html

  const duration = el("#duration");
  const timestep = el("#timestep");
  const repair = el("#repair");
  const paramMode = el("#paramMode");
  const infraMode = el("#infraMode");
  const assetsPerSector = el("#assetsPerSector");
  const maxPaths = el("#maxPaths");
  const maxDepth = el("#maxDepth");

  return {
    scenario: scenario.value,
    duration_hours: Number(duration?.value || 0),
    timestep_hours: Number(timestep?.value || 0),
    repair_crews: Number(repair?.value || 0),
    parameter_mode: paramMode?.value || "",
    infrastructure_mode: infraMode?.value || "",
    assets_per_sector: Number(assetsPerSector?.value || 0),
    max_paths: Number(maxPaths?.value || 0),
    max_depth: Number(maxDepth?.value || 0),
  };
}

/* =========================
   Mapbox init (only if #map exists on page)
   ========================= */
function initMapIfPresent() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return null;

  if (!window.mapboxgl) {
    console.warn("Mapbox GL is not loaded. Check <script src=...mapbox-gl.js> in HTML.");
    return null;
  }

  // IMPORTANT: ensure container has height
  const computed = window.getComputedStyle(mapEl);
  if (computed.height === "0px") {
    console.warn("Map container height is 0. Ensure parent and #map have height: 100%.");
  }

  const token =
    window.MAPBOX_TOKEN ||
    window.mapboxToken ||
    "pk.eyJ1IjoiZ2lub20yMDI1IiwiYSI6ImNtNWY1OXZsejR3ZGUycXIwMDMzMHg3NWUifQ.IV4RcRpODnafJoqMZQzltQ";

  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [35.2137, 31.7683], // Jerusalem (default)
    zoom: 10.5,
    pitch: 0,
    bearing: 0,
    antialias: true,
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-left");

  map.on("load", () => {
    // Demo links/nodes example (safe)
    const nodes = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { name: "Node A" }, geometry: { type: "Point", coordinates: [34.78, 32.08] } },
        { type: "Feature", properties: { name: "Node B" }, geometry: { type: "Point", coordinates: [34.83, 32.10] } },
        { type: "Feature", properties: { name: "Node C" }, geometry: { type: "Point", coordinates: [34.74, 32.05] } },
      ],
    };

    const links = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[34.78, 32.08], [34.83, 32.10]] } },
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[34.78, 32.08], [34.74, 32.05]] } },
      ],
    };

    if (!map.getSource("links")) map.addSource("links", { type: "geojson", data: links });
    if (!map.getSource("nodes")) map.addSource("nodes", { type: "geojson", data: nodes });

    if (!map.getLayer("links-glow")) {
      map.addLayer({
        id: "links-glow",
        type: "line",
        source: "links",
        paint: { "line-color": "#C3CFEF", "line-width": 4, "line-opacity": 0.35, "line-blur": 6 },
      });
    }

    if (!map.getLayer("links-core")) {
      map.addLayer({
        id: "links-core",
        type: "line",
        source: "links",
        paint: { "line-color": "#1E42AC", "line-width": 1.6, "line-opacity": 0.85 },
      });
    }

    if (!map.getLayer("nodes-glow")) {
      map.addLayer({
        id: "nodes-glow",
        type: "circle",
        source: "nodes",
        paint: { "circle-radius": 12, "circle-color": "#E5C3F0", "circle-opacity": 0.18, "circle-blur": 0.6 },
      });
    }

    if (!map.getLayer("nodes-core")) {
      map.addLayer({
        id: "nodes-core",
        type: "circle",
        source: "nodes",
        paint: { "circle-radius": 4.5, "circle-color": "#F2F2F2", "circle-stroke-color": "#1E42AC", "circle-stroke-width": 2 },
      });
    }

    map.on("mouseenter", "nodes-core", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "nodes-core", () => (map.getCanvas().style.cursor = ""));

    map.on("click", "nodes-core", (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const name = feature.properties?.name || "Node";
      new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
        .setLngLat(feature.geometry.coordinates)
        .setHTML(`<div style="font-family: Geist, Arial; font-weight:700;">${escapeHtml(name)}</div>`)
        .addTo(map);
    });
  });

  window.__ginomMap = map;
  return map;
}

/* =========================
   Optional: Charts init (only if Chart.js and elements exist)
   ========================= */
function initDecisionSupportChartsIfPresent() {
  const donutEl = document.getElementById("dsDonut");
  const barsEl = document.getElementById("dsBars");
  if (!window.Chart) return;
  if (!donutEl && !barsEl) return;

  if (donutEl) {
    new Chart(donutEl, {
      type: "doughnut",
      data: {
        labels: ["Recovery"],
        datasets: [{ data: [100], borderWidth: 0, backgroundColor: ["#1E42AC"] }],
      },
      options: {
        responsive: true,
        cutout: "76%",
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
  }

  if (barsEl) {
    new Chart(barsEl, {
      type: "bar",
      data: {
        labels: ["Communication", "Electricity", "First Responders", "Gas", "Water"],
        datasets: [
          { label: "Assets", data: [100, 100, 100, 100, 100], borderWidth: 0, backgroundColor: "rgba(30, 66, 172, 0.55)" },
          { label: "Failures", data: [2, 10, 0, 0, 7], borderWidth: 0, backgroundColor: "rgba(239, 68, 68, 0.55)" },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: "rgba(242,242,242,0.78)", font: { weight: "700" } } },
          tooltip: { enabled: true },
        },
        scales: {
          x: { ticks: { color: "rgba(242,242,242,0.70)", font: { weight: "700" } }, grid: { color: "rgba(242,242,242,0.08)" } },
          y: { ticks: { color: "rgba(242,242,242,0.70)", font: { weight: "700" } }, grid: { color: "rgba(242,242,242,0.08)" } },
        },
      },
    });
  }
}

/* =========================
   Chat wiring
   ========================= */
function initChat() {
  const input = el(".composer__input");
  const send = el(".composer__send");
  let inFlight = false;
  let thinkingBubbleEl = null;

  function setThinking(on) {
    inFlight = on;

    // Disable composer controls
    document.body.classList.toggle("is-thinking", on);

    if (input) input.disabled = on;
    if (send) send.disabled = on;

    if (on) {
      thinkingBubbleEl = appendBubble({
        role: "bot",
        text: "GINOM AI is thinking…",
        isProgress: true,
        extraHTML: `
          <div class="thinking-row" style="margin-top:8px;">
            <div class="spinner" aria-hidden="true"></div>
            <div style="font-size:12px; opacity:0.9; font-weight:700;">Working on it</div>
          </div>
        `,
      });
      scrollChatToBottom(true);
    } else {
      if (thinkingBubbleEl && thinkingBubbleEl.parentNode) {
        thinkingBubbleEl.parentNode.removeChild(thinkingBubbleEl);
      }
      scrollChatToBottom(true);
      thinkingBubbleEl = null;
      setTimeout(() => input?.focus(), 0);
    }
  }

  if (!input || !send) return; // Not all pages include chat

  async function handleSend() {
    if (inFlight) return;
    const message = (input.value || "").trim();
    if (!message) return;
    if (/^(run simulation|simulate|start simulation)$/i.test(message)) {
      // clear input to keep UX consistent
      input.value = "";
      appendBubble({ role: "user", text: message });

      // open overlay (must exist in index.html + styles.css + app.js helpers)
      openSimConfigModal?.();
      return;
    }

    input.value = "";
    appendBubble({ role: "user", text: message });
    if (tryHandleLocalSectorCommand(message)) {
      return;
    }
    setThinking(true);

    let resp;
    try {
      resp = await apiChat("demo-1", message, {
        page: window.location.pathname.split("/").pop(),
        simcfg: readSimConfigFromForm(),
      });
    } catch (e) {
      resp = localFallbackReply(message);
    } finally {
      setThinking(false);
    }

    appendBubble({ role: "bot", text: resp?.assistant_message || "No response received." });

    const actions = resp?.actions || [];

    if (resp?.requires_confirmation && actions.length) {
      renderApproval(actions, async () => {
        if (inFlight) return;

        // NEW: apply safe map actions immediately on approval (e.g., MAP_SET_VIEW)
        applyActionsSoft(actions);

        setThinking(true);

        try {
          const exec = await apiExecute("demo-1", actions, {
            page: window.location.pathname.split("/").pop(),
            simcfg: readSimConfigFromForm(),
          });

          applyExecuteArtifacts(exec);

          appendBubble({ role: "bot", text: "Approved actions executed." });
          console.log("execute result:", exec);
        } catch (e) {
          appendBubble({ role: "bot", text: "Execution completed (demo mode)." });
        } finally {
          setThinking(false);
        }
      });
    } else {
      applyActionsSoft(actions);
    }
  }

  send.addEventListener("click", () => {
    if (!inFlight) handleSend();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!inFlight) handleSend();
    }
  });

  // Wire existing quick action buttons if present
  els(".ghost-action").forEach((btn) => {
    const t = (btn.textContent || "").toLowerCase();
    if (t.includes("run simulation")) btn.addEventListener("click", () => openSimConfigModal?.());
    if (t.includes("upload")) btn.addEventListener("click", () => appendBubble({ role: "bot", text: "Upload flow is not implemented in this demo yet." }));
    if (t.includes("dependencies")) btn.addEventListener("click", () => appendBubble({ role: "bot", text: "Dependencies view is not implemented in this demo yet." }));
  });

  // Wire quick buttons inside assistant bubbles if present
  els(".quick-btn").forEach((btn) => {
    const t = (btn.textContent || "").toLowerCase();
    if (t.includes("run earthquake")) {
      btn.addEventListener("click", () => {
        input.value = "Run earthquake simulation for Jerusalem, magnitude 6.4";
        send.click();
      });
    }
    if (t.includes("upload")) {
      btn.addEventListener("click", () => {
        input.value = "Upload infrastructure data";
        send.click();
      });
    }
    if (t.includes("dependencies")) {
      btn.addEventListener("click", () => {
        input.value = "Show dependencies";
        send.click();
      });
    }
  });

  try {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  } catch (_) {}
}

function syncSectorBarsToConstants() {
  const cards = document.querySelectorAll(".overlay--health .metric.card[data-sector]");
  if (!cards.length) {
    console.warn("No sector cards found. Check HTML data-sector attributes.");
    return;
  }

  cards.forEach((card) => {
    const key = card.getAttribute("data-sector");
    const cfg = SECTORS?.[key];
    if (!cfg) {
      console.warn("Unknown sector key in bar:", key);
      return;
    }

    const fill = card.querySelector(".bar__fill");
    const value = card.querySelector(".metric__value");

    // Paint the bar and the percentage using constants.js
    if (fill) fill.style.backgroundColor = cfg.color;
    if (value) value.style.color = cfg.color;

    // Optional: ensure label matches constants
    const label = card.querySelector(".metric__label");
    if (label) label.textContent = cfg.label;
  });

  console.log("Sector bars colored from constants.js");
}

function openSimConfigModal() {
  const overlay = document.getElementById("simOverlay");
  const canvas = document.querySelector(".canvas");
  if (!overlay || !canvas) return;

  // Fill values
  const cityEl = document.getElementById("simCity");
  const assetsEl = document.getElementById("simAssetsCount");
  const sectorsEl = document.getElementById("simSectorsCount");
  if (cityEl) cityEl.value = CURRENT_CITY;
  if (assetsEl) assetsEl.textContent = String(ASSETS_COUNT || 0);
  if (sectorsEl) sectorsEl.textContent = String(PRESENT_SECTORS?.size || 0);

  // Sync labels for sliders
  const dur = document.getElementById("simDuration");
  const durVal = document.getElementById("simDurationVal");
  const tick = document.getElementById("simTick");
  const tickVal = document.getElementById("simTickVal");

  if (dur && durVal) durVal.textContent = String(dur.value);
  if (tick && tickVal) tickVal.textContent = String(tick.value);

  overlay.classList.remove("is-hidden");
  canvas.classList.add("map-disabled");
}

function closeSimConfigModal() {
  const overlay = document.getElementById("simOverlay");
  const canvas = document.querySelector(".canvas");
  if (overlay) overlay.classList.add("is-hidden");
  if (canvas) canvas.classList.remove("map-disabled");
}

function wireSimConfigModal() {
  const overlay = document.getElementById("simOverlay");
  if (!overlay) return;

  const dur = document.getElementById("simDuration");
  const durVal = document.getElementById("simDurationVal");
  const tick = document.getElementById("simTick");
  const tickVal = document.getElementById("simTickVal");

  if (dur && durVal) dur.addEventListener("input", () => (durVal.textContent = String(dur.value)));
  if (tick && tickVal) tick.addEventListener("input", () => (tickVal.textContent = String(tick.value)));

  const cancel = document.getElementById("simCancel");
  if (cancel) cancel.addEventListener("click", closeSimConfigModal);

  const confirm = document.getElementById("simConfirm");
  if (confirm) {
    confirm.addEventListener("click", async () => {
      const scenario = document.getElementById("simScenario")?.value || "earthquake";
      const durationHours = Number(document.getElementById("simDuration")?.value || 72);
      const tickMinutes = Number(document.getElementById("simTick")?.value || 10);
      const crews = Number(document.getElementById("simCrews")?.value || 10);

      // Save config locally (optional but useful)
      const simcfg = {
        city: CURRENT_CITY,
        scenario,
        duration_hours: durationHours,
        tick_minutes: tickMinutes,
        repair_crews: crews,
      };
      localStorage.setItem("ginom.simcfg", JSON.stringify(simcfg));

      closeSimConfigModal();

      // Trigger run through backend execute (keeps your architecture)
      try {
        const res = await apiExecute([{ type: "SIM_RUN", payload: simcfg }], { simcfg });
        if (res?.artifacts) applyArtifacts(res.artifacts);
      } catch (e) {
        console.error("SIM_RUN failed:", e);
      }
    });
  }
}


/* =========================
   Boot
   ========================= */
document.addEventListener("DOMContentLoaded", () => {
  SIM_RUNNING = false;

  MAP = initMapIfPresent();
  initDecisionSupportChartsIfPresent();
  initChat();
  wireSimConfigModal();

  syncSectorBarsToConstants();

  // Initial state: no simulation and no assets => overlays hidden
  updateUiVisibility();

  // After map/tiles settle, re-align UI once more
  if (MAP) {
    MAP.on("idle", () => updateUiVisibility());
  }
});
