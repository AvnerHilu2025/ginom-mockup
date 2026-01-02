/**
 * app.js
 * - Preserves existing HTML/CSS structure (no SPA router assumptions).
 * - English-only.
 * - No global APP reference (removes “APP not found” class of issues).
 * - Uses api.js for backend calls, with fallback.
 */

import { SECTORS, ASSET_STATUS } from "./constants.js";
import { apiChat, apiExecute, localFallbackReply } from "./api.js";


let MAP = null;

/* =========================
   Safe icon init (if Lucide exists)
   ========================= */
try {
  if (window.lucide?.createIcons) window.lucide.createIcons();
} catch (_) {}

/* =========================
   Helpers
   ========================= */
function el(sel, root = document) { return root.querySelector(sel); }
function els(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

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

function applyActionsSoft(actions = []) {
  // Safe, non-disruptive actions that can be executed without approval.
  for (const a of actions) {
    if (a?.type === "NAVIGATE" && a.payload?.url) {
      window.location.href = a.payload.url;
    }
    // You can add other safe actions later if needed.
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

  try { if (window.lucide?.createIcons) window.lucide.createIcons(); } catch (_) {}

  wrapper.querySelector('[data-approve="1"]')?.addEventListener("click", async () => {
    wrapper.remove();
    await onApprove?.();
  });

  wrapper.querySelector('[data-reject="1"]')?.addEventListener("click", () => {
    wrapper.remove();
    appendBubble({ role: "bot", text: "Understood — actions rejected. Tell me what you want to change." });
  });
}


/* =========================
   Map Assets (GeoJSON circles)
   ========================= */
const SECTOR_DEFAULT_COLOR = "#94A3B8";

const SECTOR_COLOR_EXPR = [
  "match",
  ["get", "sector"],
  "electricity", SECTORS.electricity.color,
  "water", SECTORS.water.color,
  "gas", SECTORS.gas.color,
  "communication", SECTORS.communication.color,
  "first_responders", SECTORS.first_responders.color,
  SECTOR_DEFAULT_COLOR
];


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
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        8, 3,
        12, 5,
        15, 8
      ],
      "circle-color": [
        "match",
        ["get", "sector"],
        "electricity", SECTORS.electricity.color,
        "water", SECTORS.water.color,
        "gas", SECTORS.gas.color,
        "communication", SECTORS.communication.color,
        "first_responders", SECTORS.first_responders.color,
        "#94A3B8" // default
      ],

      "circle-stroke-color": "rgba(255,255,255,0.9)",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9
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
  });
}

function assetsToGeoJSON(rows = []) {
  return {
    type: "FeatureCollection",
    features: rows
      .filter(r => Number.isFinite(Number(r.lng)) && Number.isFinite(Number(r.lat)))
      .map(r => ({
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

function updateAssetsOnMap(rows = [], { fitBounds = true } = {}) {
  if (!MAP) return;

  const doUpdate = () => {
    ensureAssetsLayer(MAP);
    const src = MAP.getSource("ginom-assets");
    if (!src) return;

    const geo = assetsToGeoJSON(rows);
    src.setData(geo);

    if (fitBounds && geo.features.length) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const f of geo.features) {
        const [lng, lat] = f.geometry.coordinates;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
      MAP.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 800 });
    }
  };

  // If style isn't loaded yet, wait
  if (!MAP.isStyleLoaded()) {
    MAP.once("load", doUpdate);
  } else {
    doUpdate();
  }
}

function applyExecuteArtifacts(execResult) {
  const artifacts = execResult?.artifacts || [];
  for (const a of artifacts) {
    if (a?.type === "assets" && Array.isArray(a.data)) {
      updateAssetsOnMap(a.data, { fitBounds: true });
    }

    if (a?.type === "sim_status") {
      // Show timeline as soon as a simulation starts/runs
      setImpactTimelineVisible(true);
    }
  }
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

  // Token must exist
  const token =
    window.MAPBOX_TOKEN ||
    window.mapboxToken ||
    "pk.eyJ1IjoiZ2lub20yMDI1IiwiYSI6ImNtNWY1OXZsejR3ZGUycXIwMDMzMHg3NWUifQ.IV4RcRpODnafJoqMZQzltQ";

  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [35.2137, 31.7683], // Jerusalem
    zoom: 10.5,
    pitch: 0,
    bearing: 0,
    antialias: true,
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-left");

  map.on("load", () => {
    // Keep your demo links/nodes example (minimal, safe)
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
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[34.78, 32.08],[34.83, 32.10]] } },
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[34.78, 32.08],[34.74, 32.05]] } },
      ],
    };

    if (!map.getSource("links")) map.addSource("links", { type: "geojson", data: links });
    if (!map.getSource("nodes")) map.addSource("nodes", { type: "geojson", data: nodes });

    if (!map.getLayer("links-glow")) {
      map.addLayer({
        id: "links-glow",
        type: "line",
        source: "links",
        paint: {
          "line-color": "#C3CFEF",
          "line-width": 4,
          "line-opacity": 0.35,
          "line-blur": 6,
        },
      });
    }

    if (!map.getLayer("links-core")) {
      map.addLayer({
        id: "links-core",
        type: "line",
        source: "links",
        paint: {
          "line-color": "#1E42AC",
          "line-width": 1.6,
          "line-opacity": 0.85,
        },
      });
    }

    if (!map.getLayer("nodes-glow")) {
      map.addLayer({
        id: "nodes-glow",
        type: "circle",
        source: "nodes",
        paint: {
          "circle-radius": 12,
          "circle-color": "#E5C3F0",
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      });
    }

    if (!map.getLayer("nodes-core")) {
      map.addLayer({
        id: "nodes-core",
        type: "circle",
        source: "nodes",
        paint: {
          "circle-radius": 4.5,
          "circle-color": "#F2F2F2",
          "circle-stroke-color": "#1E42AC",
          "circle-stroke-width": 2,
        },
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
    const root = document.documentElement; // or document.body
    inFlight = on;

    // Disable composer controls
    document.body.classList.toggle("is-thinking", on);

    if (input) input.disabled = on;
    if (send) send.disabled = on;

    if (on) {
      // Add a "thinking" bubble (bot side)
      thinkingBubbleEl = appendBubble({
        role: "bot",
        text: "GINOM AI is thinking…",
        isProgress: true,
        extraHTML: `
          <div class="thinking-row" style="margin-top:8px;">
            <div class="spinner" aria-hidden="true"></div>
            <div style="font-size:12px; opacity:0.9; font-weight:700;">Working on it</div>
          </div>
        `
      });
      scrollChatToBottom(true);
    } else {
      // Remove thinking bubble if it exists
      if (thinkingBubbleEl && thinkingBubbleEl.parentNode) {
        thinkingBubbleEl.parentNode.removeChild(thinkingBubbleEl);
      }
      scrollChatToBottom(true);
      thinkingBubbleEl = null;

      // Restore focus
      setTimeout(() => input?.focus(), 0);
    }
  }


  if (!input || !send) {
    // Not all pages include chat
    return;
  }

  async function handleSend() {
    if (inFlight) return; // prevent multiple requests
    const message = (input.value || "").trim();
    if (!message) return;

    input.value = "";
    appendBubble({ role: "user", text: message });

    setThinking(true);

    let resp;
    try {
      resp = await apiChat("demo-1", message, {
        page: window.location.pathname.split("/").pop(),
        simcfg: readSimConfigFromForm(),
      });
    } catch (e) {
      // Backend down -> fallback (or show a clean error)
      resp = localFallbackReply(message);
    } finally {
      setThinking(false);
    }

    appendBubble({ role: "bot", text: resp?.assistant_message || "No response received." });

    const actions = resp?.actions || [];
    if (resp?.requires_confirmation && actions.length) {
      renderApproval(actions, async () => {
        if (inFlight) return;
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
    if (t.includes("run simulation")) btn.addEventListener("click", () => (window.location.href = "./simconf.html"));
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

  try { if (window.lucide?.createIcons) window.lucide.createIcons(); } catch (_) {}
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



/* =========================
   Boot
   ========================= */
document.addEventListener("DOMContentLoaded", () => {
  setImpactTimelineVisible(false);
  MAP = initMapIfPresent();
  initDecisionSupportChartsIfPresent();
  initChat();
  syncSectorBarsToConstants();
});
