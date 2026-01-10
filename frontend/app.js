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
import { apiChat, apiExecute, apiPrepareScenario, localFallbackReply } from "./api.js";


let MAP = null;
let SIM_RUNNING = false;
let ASSETS_COUNT = 0; // source of truth for "are there assets on the map?"
let PRESENT_SECTORS = new Set();
let CURRENT_CITY = localStorage.getItem("ginom.currentCity") || "Jerusalem";
let depsFocusDepth = 1; // 1..5
window.MAP_VISIBLE_ASSETS = [];
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


function syncImpactTimelineFromSimcfg(simcfg) {
  const wrap = document.querySelector(".impact-timeline");
  if (!wrap) return;

  const range = wrap.querySelector(".timeline__range");
  const labels = wrap.querySelectorAll(".timeline__t");
  const startLabel = labels?.[0];
  const endLabel = labels?.[1];

  if (!range || !startLabel || !endLabel) return;

  const durationHours = Math.max(0, Number(simcfg?.duration_hours ?? 0));
  const tickMinutes = Math.max(1, Number(simcfg?.tick_minutes ?? 10));

  // slider represents "ticks" (discrete steps)
  const totalTicks = Math.max(1, Math.round((durationHours * 60) / tickMinutes));

  range.min = "0";
  range.max = String(totalTicks);
  range.step = "1";

  // IMPORTANT: start at the beginning
  range.value = "0";

  startLabel.textContent = "T+0:00";
  endLabel.textContent = `T+${durationHours}:00`;
}


function loadSimcfgFromStorage() {
  try {
    const raw = localStorage.getItem("ginom.simcfg");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function prettyScenarioName(s) {
  const key = String(s || "").toLowerCase();
  const map = {
    earthquake: "Earthquake",
    cyber_attack: "Cyber Attack",
    flood: "Flood",
    wildfire: "Wildfire",
    storm: "Extreme Weather",
  };
  return map[key] || (key ? key.replace(/_/g, " ") : "—");
}

function updateActiveScenarioCard(simcfg) {
  const cityEl = document.getElementById("activeScenarioCity");
  const timeEl = document.getElementById("activeScenarioTime");
  const typeEl = document.getElementById("activeScenarioType");

  if (!cityEl || !timeEl || !typeEl) return;

  const city = simcfg?.city ? String(simcfg.city) : "—";
  const scenario = prettyScenarioName(simcfg?.scenario);

  cityEl.textContent = city;
  timeEl.textContent = `${new Date().toLocaleTimeString()} Local Time`;
  typeEl.textContent = scenario;
}


function formatSimConfigSummary(simcfg) {
  const city = simcfg.city || "—";
  const scenario = simcfg.scenario || "—";
  const duration = Number(simcfg.duration_hours || 0);
  const tick = Number(simcfg.tick_minutes || 0);
  const crews = Number(simcfg.repair_crews ?? 0);

  return [
    `**Simulation settings**`,
    `- **Area (city):** ${city}`,
    `- **Scenario:** ${scenario}`,
    `- **Duration:** ${duration} hours`,
    `- **Tick:** ${tick} minutes`,
    `- **Repair crews:** ${crews}`,
  ].join("\n");
}
function renderSimRunConfirmation(simcfg, onConfirm, onCancel) {
  // Show summary
  appendBubble({ role: "bot", text: formatSimConfigSummary(simcfg) });

  // Ask for confirmation with buttons
  const elWrap = appendBubble({
    role: "bot",
    text: "Please confirm: prepare this scenario now (no execution yet).",
    extraHTML: `
      <div class="quick-actions" style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="quick-btn" data-sim-confirm="1">Prepare scenario</button>
        <button class="quick-btn" data-sim-cancel="1">Cancel</button>
      </div>
    `,
  });

  // Wire buttons (scoped to this bubble)
  const confirmBtn = elWrap?.querySelector?.('[data-sim-confirm="1"]');
  const cancelBtn = elWrap?.querySelector?.('[data-sim-cancel="1"]');

  confirmBtn?.addEventListener("click", () => onConfirm?.());
  cancelBtn?.addEventListener("click", () => onCancel?.());
}
// =========================
// Scenario -> Anchor selection + Prepare (single flow)
// =========================

function requiredAnchorForScenario(scenarioKey) {
  const s = String(scenarioKey || "").toLowerCase();
  if (s === "earthquake") return "EPICENTER";
  if (s === "tsunami") return "IMPACT_CENTER";
  if (s === "wildfire") return "FIRE_ORIGIN";
  if (s === "storm" || s === "severe_storm") return "FLOOD_POCKET";
  if (s === "flood") return "FLOOD_POCKET";
  return null; // cyber_attack, pandemic, etc.
}

let __scenarioAnchorMarker = null;

function showScenarioAnchorOnMap(anchorType, lat, lng) {
  if (!MAP || !window.mapboxgl) return;

  try {
    // Remove previous marker only when selecting a new anchor
    if (__scenarioAnchorMarker) {
      __scenarioAnchorMarker.remove();
      __scenarioAnchorMarker = null;
    }

    __scenarioAnchorMarker = new mapboxgl.Marker({ color: "#EF4444" })
      .setLngLat([lng, lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 16 }).setHTML(
          `<div style="font-family: Geist, Arial; font-size:12px;">
             <b>${escapeHtml(anchorType)}</b><br/>
             ${lat.toFixed(5)}, ${lng.toFixed(5)}
           </div>`
        )
      )
      .addTo(MAP);

    __scenarioAnchorMarker.getPopup().addTo(MAP);

    // Ensure it stays visible
    try {
      MAP.flyTo({ center: [lng, lat], zoom: Math.max(MAP.getZoom(), 11.5), speed: 0.9 });
    } catch (_) {}

  } catch (e) {
    console.warn("showScenarioAnchorOnMap failed:", e);
  }
}

async function beginAnchorPickAndPrepare(simcfg) {
  const anchorType = requiredAnchorForScenario(simcfg?.scenario);

  // No anchor required -> prepare immediately
  if (!anchorType) {
    await prepareScenarioNow(simcfg, []);
    return;
  }

  if (!MAP) {
    appendBubble({ role: "bot", text: "Map is not ready. Cannot pick an anchor point." });
    return;
  }

  appendBubble({
    role: "bot",
    text: `Please click on the map to set the anchor: ${anchorType}.`,
  });

  MAP.getCanvas().style.cursor = "crosshair";

  MAP.once("click", async (e) => {
    MAP.getCanvas().style.cursor = "";

    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;

    // Show marker and KEEP it (no cleanup)
    showScenarioAnchorOnMap(anchorType, lat, lng);

    appendBubble({
      role: "bot",
      text: `Anchor set: ${anchorType} at (${lat.toFixed(5)}, ${lng.toFixed(5)}). Preparing scenario...`,
    });

    await prepareScenarioNow(simcfg, [{ type: anchorType, lat, lng }]);
  });
}

async function prepareScenarioNow(simcfg, anchors) {
  try {
    const payload = {
      city: simcfg.city,
      scenario: simcfg.scenario,
      duration_hours: simcfg.duration_hours,
      tick_minutes: simcfg.tick_minutes,
      repair_crews: simcfg.repair_crews,
      anchors,
    };

    const resp = await apiPrepareScenario(payload);

    localStorage.setItem("ginom.preparedScenario", JSON.stringify(resp));
    localStorage.setItem("ginom.preparedScenarioId", String(resp.scenario_instance_id || ""));

    const bubble = appendBubble({
      role: "bot",
      text:
        `Scenario is prepared and ready to run.\n` +
        `- Template: ${resp.template_id}\n` +
        `- Events created: ${resp.events_created}\n` +
        `- Assets used: ${resp.assets_used}\n` +
        `- Total ticks: ${resp.total_ticks}\n` +
        `Instance ID: ${resp.scenario_instance_id}`,
      extraHTML: `
        <div class="quick-actions" style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="quick-btn" data-run-prepared="1">RUN</button>
          <button class="quick-btn" data-show-prepared="1">Show details</button>
        </div>
      `,
    });

    const runBtn = bubble?.querySelector?.('[data-run-prepared="1"]');
    const showBtn = bubble?.querySelector?.('[data-show-prepared="1"]');

    runBtn?.addEventListener("click", async () => {
      try {
        const exec = await apiExecute(
          "demo-1",
          [{ type: "SIM_RUN", payload: { ...simcfg, scenario_instance_id: resp.scenario_instance_id } }],
          { page: window.location.pathname.split("/").pop(), simcfg, prepared: resp }
        );

        applyExecuteArtifacts(exec);
        appendBubble({ role: "bot", text: "RUN command sent." });
      } catch (e) {
        console.error("RUN failed:", e);
        appendBubble({ role: "bot", text: "Failed to start simulation." });
      }
    });

    showBtn?.addEventListener("click", async () => {
      const id = resp.scenario_instance_id;
      if (!id) return;

      if (typeof window.__ginomSendChat === "function") {
        await window.__ginomSendChat(`show prepared ${id}`);
      } else {
        appendBubble({ role: "bot", text: `Type: show prepared ${id}` });
      }
    });

  } catch (e) {
    console.error("prepareScenarioNow failed:", e);
    appendBubble({ role: "bot", text: "Failed to prepare scenario. Check server logs." });
  }
}

// =========================
// Scenario -> Anchor selection (Option 2 flow)
// =========================
/*
function requiredAnchorForScenario(scenarioKey) {
  const s = String(scenarioKey || "").toLowerCase();
  if (s === "earthquake") return "EPICENTER";
  if (s === "tsunami") return "IMPACT_CENTER";
  if (s === "wildfire") return "FIRE_ORIGIN";
  if (s === "severe_storm") return "FLOOD_POCKET";
  return null; // cyber_attack, pandemic (and others)
}
*/
let __anchorMarker = null;


let __pendingPrepareSimcfg = null;
let __pendingAnchorType = null;
let __pendingAnchorMarker = null;

function clearPendingAnchor() {
  __pendingPrepareSimcfg = null;
  __pendingAnchorType = null;
  if (__pendingAnchorMarker) {
    try { __pendingAnchorMarker.remove(); } catch (_) {}
  }
  __pendingAnchorMarker = null;
}


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
// --- Asset tooltip on hover (instead of click) ---
let __assetHoverPopup = null;

function ensureAssetHoverPopup() {
  if (__assetHoverPopup) return __assetHoverPopup;
  __assetHoverPopup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });
  return __assetHoverPopup;
}

map.on("mousemove", "ginom-assets-circle", (e) => {
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

  const popup = ensureAssetHoverPopup();
  popup.setLngLat(e.lngLat).setHTML(html).addTo(map);

  // cursor feedback
  map.getCanvas().style.cursor = "pointer";
});

map.on("mouseleave", "ginom-assets-circle", () => {
  if (__assetHoverPopup) __assetHoverPopup.remove();
  map.getCanvas().style.cursor = "";
});

// Keep click for dependencies only (no popup)
map.on("click", "ginom-assets-circle", (e) => {
  const f = e.features?.[0];
  if (!f) return;

  const p = f.properties || {};
  __lastAssetLayerClickAt = Date.now();
  showDependencyChain(String(p.id || ""), { direction: "upstream", maxDepth: 4, fitBounds: false });
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
    // === SOURCE OF TRUTH: assets currently visible on the map ===
    window.MAP_VISIBLE_ASSETS = Array.isArray(rows) ? rows : [];

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
      if (SIM_RUNNING) {
        const simcfg = loadSimcfgFromStorage();
        updateActiveScenarioCard(simcfg);
        syncImpactTimelineFromSimcfg(simcfg);
      }

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
    style: "mapbox://styles/mapbox/light-v11",
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
    // =========================
// Local command: dependencies
// =========================
    if (/^dependencies$/i.test(message)) {
      input.value = "";
      appendBubble({ role: "user", text: message });

      appendBubble({
        role: "bot",
        text: "Opening infrastructure dependencies view.",
      });

      openDependenciesOverlay();
      return;
    }

    if (!message) return;
    if (/^(prep simulation|simulate|prepare simulation|prep sim)$/i.test(message)) {
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
          updateActiveScenarioCard(simcfg);
          syncImpactTimelineFromSimcfg(simcfg);
          

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
    // Allow other UI elements (buttons) to send a chat message through the same pipeline
  window.__ginomSendChat = async function (text) {
    const message = String(text || "").trim();
    if (!message) return;

    // mirror handleSend UX
    appendBubble({ role: "user", text: message });
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

    // Apply soft actions if any
    const actions = resp?.actions || [];
    if (resp?.requires_confirmation && actions.length) {
      renderApproval(actions, async () => {
        if (inFlight) return;

        applyActionsSoft(actions);
        setThinking(true);

        try {
          const exec = await apiExecute("demo-1", actions, {
            page: window.location.pathname.split("/").pop(),
            simcfg: readSimConfigFromForm(),
          });

          applyExecuteArtifacts(exec);
          appendBubble({ role: "bot", text: "Approved actions executed." });
        } catch (e) {
          appendBubble({ role: "bot", text: "Execution completed (demo mode)." });
        } finally {
          setThinking(false);
        }
      });
    } else {
      applyActionsSoft(actions);
    }
  };

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
    //if (t.includes("dependencies")) btn.addEventListener("click", () => appendBubble({ role: "bot", text: "Dependencies view is not implemented in this demo yet." }));
    if (t.includes("dependencies")) {
      btn.addEventListener("click", () => {
        appendBubble({ role: "user", text: "dependencies" });
        appendBubble({
          role: "bot",
          text: "Opening infrastructure dependencies view.",
        });
        openDependenciesOverlay();
      });
    }

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
        appendBubble({ role: "user", text: "dependencies" });
        appendBubble({
          role: "bot",
          text: "Opening infrastructure dependencies view.",
        });
        openDependenciesOverlay();
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
// =========================
// Dependencies Overlay
// =========================
function openDependenciesOverlay() {
  const overlay = document.getElementById("dependenciesOverlay");
  const canvas = document.querySelector(".canvas");
  if (!overlay || !canvas) return;

  overlay.classList.remove("is-hidden");
  canvas.classList.add("map-disabled");

  // render graph on open
  renderDependenciesGraph().catch(err => {
    console.error("[Dependencies Graph]", err);
  });
}

function closeDependenciesOverlay() {
  const overlay = document.getElementById("dependenciesOverlay");
  const canvas = document.querySelector(".canvas");
  if (overlay) overlay.classList.add("is-hidden");
  if (canvas) canvas.classList.remove("map-disabled");
  console.log (overlay);
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

    const simcfg = {
      city: localStorage.getItem("ginom.currentCity") || CURRENT_CITY || "",
      scenario,
      duration_hours: durationHours,
      tick_minutes: tickMinutes,
      repair_crews: crews,
    };

    // Persist for later use
    localStorage.setItem("ginom.simcfg", JSON.stringify(simcfg));

    // Close modal + disable map stays off? Your call.
    closeSimConfigModal();

    // NEW: Ask for confirmation in chat (do NOT run yet)
    renderSimRunConfirmation(
      simcfg,
      async () => {
        try {
          updateActiveScenarioCard(simcfg);
          syncImpactTimelineFromSimcfg(simcfg);

          appendBubble({ role: "bot", text: "Preparing scenario (no execution yet)..." });
          await beginAnchorPickAndPrepare(simcfg);

        } catch (e) {
          console.error("Prepare flow failed:", e);
          appendBubble({ role: "bot", text: "Failed to prepare scenario." });
        }
      },



      () => {
        appendBubble({ role: "bot", text: "Cancelled. Simulation was not prepared." });
      }
    );
  });

  }
}

// =========================
// 3D Dependencies Graph
// =========================
let depsGraph = null;
let depsFullData = null;
let depsFocusedNodeId = null;

// double-click detection
let depsLastClickAt = 0;
let depsLastClickNodeId = null;
const DEPS_DBLCLICK_MS = 350;

async function renderDependenciesGraph() {
  const mountEl = document.getElementById("depsGraphMount");
  if (!mountEl) return;

  mountEl.innerHTML = "";
  mountEl.style.position = "relative";
  mountEl.style.overflow = "hidden";

  const FG = window.ForceGraph3D;
  if (typeof FG !== "function") {
    console.error("[Dependencies Graph] ForceGraph3D not available.", {
      THREE: typeof window.THREE,
      ForceGraph3D: typeof window.ForceGraph3D,
    });
    mountEl.textContent = "3D graph library failed to load.";
    return;
  }

  // Normalize link end (id or node object)
  const linkEndId = (x) => (x && typeof x === "object" ? x.id : x);

  try {
    const { fetchDependenciesGraph } = await import("./api.js");
    const rawData = await fetchDependenciesGraph();

    const allNodes = Array.isArray(rawData?.nodes) ? rawData.nodes : [];
    const allLinks = Array.isArray(rawData?.links) ? rawData.links : [];

    // === SOURCE OF TRUTH: assets currently visible on the map ===
    const visibleAssets = Array.isArray(window.MAP_VISIBLE_ASSETS)
      ? window.MAP_VISIBLE_ASSETS
      : [];

    if (visibleAssets.length === 0) {
      mountEl.textContent = "No assets are currently visible on the map.";
      return;
    }

    const visibleIds = new Set(visibleAssets.map((a) => a.id));

    // Nodes: only assets currently shown on the map
    const nodes = allNodes.filter((n) => visibleIds.has(n.id));

    // Links: only dependencies fully inside the visible asset set
    const links = allLinks.filter((l) => {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      return visibleIds.has(s) && visibleIds.has(t);
    });

    if (nodes.length === 0) {
      mountEl.textContent = "No dependencies for the currently visible assets.";
      return;
    }

    const data = { nodes, links };
    depsFullData = data;
    depsFocusedNodeId = null;

    depsGraph = FG()(mountEl)
      .graphData(data)
      .nodeId("id")
      .nodeLabel((node) => `${node.name}\n(${node.sector})`)
      .nodeAutoColorBy("sector")
      .nodeRelSize(6)
      .linkDirectionalArrowLength(6)
      .linkDirectionalArrowRelPos(1)
      .linkWidth((link) => Math.max(1, link.weight || 1))
      .backgroundColor("#f7f8fb");

    // =========================
    // UI elements (left panel)
    // =========================
    const metaEl = document.getElementById("depsSelectedMeta");
    const upEl = document.getElementById("depsListUpstream");
    const downEl = document.getElementById("depsListDownstream");
    const resetBtn = document.getElementById("depsResetViewBtn");

    function setMeta(title, sub) {
      if (!metaEl) return;
      const nameEl = metaEl.querySelector(".deps-selected-meta__name");
      const subEl = metaEl.querySelector(".deps-selected-meta__sub");
      if (nameEl) nameEl.textContent = title || "—";
      if (subEl) subEl.textContent = sub || "";
    }

    function clearLists() {
      if (upEl) upEl.innerHTML = "";
      if (downEl) downEl.innerHTML = "";
    }

    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c]));
    }

    function fillList(el, items) {
      if (!el) return;
      el.innerHTML = items
        .map(
          (n) =>
            `<li>${escapeHtml(n.name)} <span style="color:#64748b;">(${escapeHtml(
              n.sector || "—"
            )})</span></li>`
        )
        .join("");
    }

    // =========================
    // Depth slider (1..5)
    // =========================
    // depsFocusDepth is a global (already in your file): let depsFocusDepth = 1; // 1..5
    function ensureDepthSlider() {
      if (!metaEl) return;

      // if already exists, don't duplicate
      if (metaEl.querySelector("#depsDepthSlider")) return;

      const wrap = document.createElement("div");
      wrap.style.marginTop = "10px";
      wrap.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div style="font-size:12px; font-weight:800; color:#0f172a;">
            Dependency depth
          </div>
          <div style="font-size:12px; font-weight:900; color:#1E42AC;">
            <span id="depsDepthVal">${Number(depsFocusDepth) || 1}</span>
          </div>
        </div>
        <input id="depsDepthSlider" type="range" min="1" max="5" step="1" value="${Number(depsFocusDepth) || 1}"
               style="width:100%; margin-top:6px;" />
        <div style="font-size:11px; color:#64748b; margin-top:6px;">
          1 = direct dependencies only, 5 = broader neighborhood.
        </div>
      `;

      metaEl.appendChild(wrap);

      const slider = metaEl.querySelector("#depsDepthSlider");
      const valEl = metaEl.querySelector("#depsDepthVal");

      slider?.addEventListener("input", () => {
        depsFocusDepth = Math.max(1, Math.min(5, Number(slider.value || 1)));
        if (valEl) valEl.textContent = String(depsFocusDepth);

        // If we are already focused on a node, re-render focused subgraph with the new depth
        if (depsFocusedNodeId && depsFullData) {
          const nodesById = new Map(depsFullData.nodes.map((n) => [n.id, n]));
          const n = nodesById.get(depsFocusedNodeId);
          if (n) focusOnNode(n);
        }
      });
    }

    ensureDepthSlider();

    // =========================
    // MULTI-HOP focus (limited by slider depth)
    // =========================
    function focusOnNode(node) {
      if (!node || !depsFullData) return;

      const id = node.id;
      depsFocusedNodeId = id;

      const nodesById = new Map(depsFullData.nodes.map((n) => [n.id, n]));

      // Build directed adjacency maps
      const out = new Map(); // source -> targets
      const inc = new Map(); // target -> sources

      for (const l of depsFullData.links) {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        if (!s || !t) continue;

        if (!out.has(s)) out.set(s, []);
        if (!inc.has(t)) inc.set(t, []);

        out.get(s).push(t);
        inc.get(t).push(s);
      }

      // BFS with depth cap
      function bfsDepth(startId, nextMap, maxDepth) {
        const dist = new Map();
        const q = [startId];
        dist.set(startId, 0);

        while (q.length) {
          const cur = q.shift();
          const d = dist.get(cur);

          if (d >= maxDepth) continue;

          const next = nextMap.get(cur) || [];
          for (const nid of next) {
            if (!dist.has(nid)) {
              dist.set(nid, d + 1);
              q.push(nid);
            }
          }
        }
        return dist;
      }

      const depth = Math.max(1, Math.min(5, Number(depsFocusDepth) || 1));

      // Upstream: follow incoming edges
      const upstreamDist = bfsDepth(id, inc, depth);
      // Downstream: follow outgoing edges
      const downstreamDist = bfsDepth(id, out, depth);

      const reachableIds = new Set([
        ...upstreamDist.keys(),
        ...downstreamDist.keys(),
      ]);

      // Subgraph nodes
      const subNodes = [...reachableIds]
        .map((nid) => nodesById.get(nid))
        .filter(Boolean);

      // Subgraph links: both ends reachable
      const subLinks = depsFullData.links.filter((l) => {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        return reachableIds.has(s) && reachableIds.has(t);
      });

      depsGraph.graphData({ nodes: subNodes, links: subLinks });
      depsGraph.zoomToFit?.(800, 60);

      // Lists with hop labels (exclude selected node itself)
      const upstreamNodes = [...upstreamDist.entries()]
        .filter(([nid]) => nid !== id)
        .sort((a, b) => a[1] - b[1])
        .map(([nid, hop]) => {
          const n = nodesById.get(nid);
          if (!n) return null;
          return { ...n, name: `L${hop} – ${n.name}` };
        })
        .filter(Boolean);

      const downstreamNodes = [...downstreamDist.entries()]
        .filter(([nid]) => nid !== id)
        .sort((a, b) => a[1] - b[1])
        .map(([nid, hop]) => {
          const n = nodesById.get(nid);
          if (!n) return null;
          return { ...n, name: `L${hop} – ${n.name}` };
        })
        .filter(Boolean);

      // Better English labels in UI are your HTML concern,
      // but meta text here will reflect depth:
      setMeta(
        node.name || node.id,
        `Focused view: dependencies up to depth ${depth} (double-click another node to switch)`
      );
      fillList(upEl, upstreamNodes);
      fillList(downEl, downstreamNodes);
    }

    function resetView() {
      if (!depsFullData) return;
      depsFocusedNodeId = null;
      depsGraph.graphData(depsFullData);
      depsGraph.zoomToFit?.(450, 12);
      setMeta("—", "Double-click a node to focus");
      clearLists();
    }

    // Wire reset button once
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.addEventListener("click", resetView);
      resetBtn.__wired = true;
    }

    // Double-click behavior on node click
    depsGraph.onNodeClick((node) => {
      const now = Date.now();
      const isSameNode = depsLastClickNodeId === node?.id;
      const isDbl = isSameNode && (now - depsLastClickAt) <= DEPS_DBLCLICK_MS;

      depsLastClickAt = now;
      depsLastClickNodeId = node?.id;

      if (isDbl) {
        focusOnNode(node);
      } else {
        setMeta(
          node?.name || "—",
          "Double-click to focus this asset and its dependencies"
        );
      }
    });

    // Constrain canvas to modal size
    // Constrain canvas to modal size
    // Constrain canvas to modal size + reliable zoom-to-fit
    const resize = () => {
      const w = mountEl.clientWidth || 800;
      const h = mountEl.clientHeight || 500;
      depsGraph.width(w).height(h);
    };

    // IMPORTANT: zoomToFit must happen AFTER size is correct (and after modal layout settles)
    const fitNow = (ms = 450, padding = 12) => {
      try {
        // smaller padding => "closer" camera while still fitting the graph
        depsGraph.zoomToFit?.(ms, padding);
      } catch (_) {}
    };

    resize();

    // Run fit multiple times to catch final modal size after CSS/layout/paint
    requestAnimationFrame(() => {
      resize();
      fitNow(0, 12);
      requestAnimationFrame(() => {
        resize();
        fitNow(250, 12);
      });
    });

    // Extra safety for slower machines / fonts / modal transitions
    setTimeout(() => { resize(); fitNow(350, 12); }, 120);
    setTimeout(() => { resize(); fitNow(350, 12); }, 350);

    window.addEventListener("resize", () => {
      resize();
      // keep it tight on resize too
      fitNow(250, 12);
    }, { passive: true });

    //window.addEventListener("resize", resizeAndFit, { passive: true });

  } catch (err) {
    console.error("[Dependencies Graph] Failed to render graph", err);
    mountEl.textContent = "Failed to load dependencies graph.";
  }
}



/* =========================
   Boot
   ========================= */
document.addEventListener("DOMContentLoaded", () => {
  SIM_RUNNING = false;
  const depsCloseBtn = document.getElementById("depsCloseBtn");
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
  
  if (depsCloseBtn) {
    depsCloseBtn.addEventListener("click", closeDependenciesOverlay);
  }

});

// =========================
// Expose dependencies overlay controls globally
// =========================
window.openDependenciesOverlay = openDependenciesOverlay;
window.closeDependenciesOverlay = closeDependenciesOverlay;
