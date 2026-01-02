/**
 * api.js
 * - Single source of truth for calling the backend.
 * - Works even if backend is down (fallback responses).
 * - English-only.
 */


export const DEMO_BACKEND_BASE =
  (window.DEMO_BACKEND_BASE && String(window.DEMO_BACKEND_BASE)) ||
  "http://localhost:3000";

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

/**
 * Chat API
 * Expected backend response shape:
 * {
 *   assistant_message: string,
 *   requires_confirmation: boolean,
 *   actions: Array<{type: string, payload: object}>
 * }
 */
export async function apiChat(session_id, message, context = {}) {
  const url = `${DEMO_BACKEND_BASE}/api/chat`;
  const payload = { session_id, message, context };
  return await postJson(url, payload);
}

/**
 * Execute API (optional backend endpoint).
 * For now the demo can run without it. If backend is missing, you can simulate.
 */
export async function apiExecute(session_id, actions = [], context = {}) {
  const url = `${DEMO_BACKEND_BASE}/api/execute`;
  const payload = { session_id, actions, context };
  return await postJson(url, payload);
}

/** Local fallback when backend is not running. */
export function localFallbackReply(message) {
  const m = (message || "").toLowerCase();

  if (m.includes("config") || m.includes("parameters") || m.includes("simulation config")) {
    return {
      assistant_message: "Opening Simulation Configuration screen.",
      requires_confirmation: false,
      actions: [{ type: "NAVIGATE", payload: { url: "./simconf.html" } }],
    };
  }

  if ((m.includes("run") || m.includes("start")) && m.includes("simulation")) {
    return {
      assistant_message:
        "I can prepare the simulation run. Approve to proceed (demo safety).",
      requires_confirmation: true,
      actions: [
        {
          type: "SIM_RUN",
          payload: { scenario: "Earthquake", location: "Tel Aviv", magnitude: 6.4 },
        },
      ],
    };
  }

  if (m.includes("show") && (m.includes("assets") || m.includes("map"))) {
    return {
      assistant_message:
        "I can load demo assets on the map. Approve to proceed.",
      requires_confirmation: true,
      actions: [
        { type: "MAP_SET_VIEW", payload: { lat: 32.0853, lng: 34.7818, zoom: 11 } },
        { type: "MAP_SHOW_ASSETS", payload: { city: "Tel Aviv", sectors: ["electricity","water","gas","communication","first_responders"] } }
      ],
    };
  }

  return {
    assistant_message:
      "Acknowledged. You can ask me to show assets on the map, open Simulation Configuration, or run a scenario.",
    requires_confirmation: false,
    actions: [],
  };
}
