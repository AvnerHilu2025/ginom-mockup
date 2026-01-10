/**
 * api.js
 * Single source of truth for calling the backend.
 * - If backend is down: returns a safe fallback reply (no DB writes).
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
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}. ${text}`);
  }

  return res.json();
}

/**
 * Chat endpoint
 * Backend should return:
 * {
 *   assistant_message: string,
 *   requires_confirmation: boolean,
 *   actions: Array<{type:string, payload?:any}>
 * }
 */
export async function apiChat(sessionId, message, context = {}) {
  const url = `${DEMO_BACKEND_BASE}/api/chat`;
  return postJson(url, {
    session_id: sessionId,
    message,
    context,
  });
}

/**
 * Execute endpoint
 * Backend should return:
 * {
 *   artifacts: Array<{type:string, data:any}>
 * }
 */
export async function apiExecute(sessionId, actions = [], context = {}) {
  const url = `${DEMO_BACKEND_BASE}/api/execute`;
  return postJson(url, {
    session_id: sessionId,
    actions,
    context,
  });
}

/**
 * Used when backend is down/unreachable.
 * IMPORTANT: no seeding here because you explicitly want DB seeding in backend.
 */
export function localFallbackReply(message = "") {
  const m = String(message).trim().toLowerCase();

  // Minimal helpful guidance while backend is offline
  if (!m) {
    return {
      assistant_message: "Please type a command (e.g., 'show assets') or a city name.",
      requires_confirmation: false,
      actions: [],
    };
  }

  // If user typed a city name but backend is down — we cannot resolve boundaries or seed DB
  if (/^[a-z\s.'-]{2,}$/.test(m) && !m.includes("show") && !m.includes("run")) {
    return {
      assistant_message:
        `I understood you may be referring to the city "${message}". ` +
        `However, the backend is currently unavailable, so I cannot resolve the city's boundary or seed the database. ` +
        `Please start the backend and try again.`,
      requires_confirmation: false,
      actions: [],
    };
  }

  return {
    assistant_message:
      "Backend is unavailable. Start it and try again. (Expected endpoints: POST /api/chat and POST /api/execute)",
    requires_confirmation: false,
    actions: [],
  };
}


export async function apiPrepareScenario(payload = {}) {
  const url = `${DEMO_BACKEND_BASE}/api/scenario/prepare`;
  return postJson(url, payload);
}


// =========================
// Dependencies Graph API
// =========================
export async function fetchDependenciesGraph() {
  //const res = await fetch("/api/dependencies/graph");
  const res = await fetch(`${DEMO_BACKEND_BASE}/api/dependencies/graph`);
  if (!res.ok) {
    throw new Error("Failed to load dependencies graph");
  }
  return res.json();
}


// =========================
// Simulation Run API (Phase 2)
// =========================
export async function apiSimState(sim_run_id) {
  const url = `${DEMO_BACKEND_BASE}/api/sim/state?sim_run_id=${encodeURIComponent(sim_run_id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}. ${text}`);
  }
  return res.json();
}

export async function apiSimTick(sim_run_id, tick_index) {
  const url = `${DEMO_BACKEND_BASE}/api/sim/tick?sim_run_id=${encodeURIComponent(sim_run_id)}&tick_index=${encodeURIComponent(String(tick_index))}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}. ${text}`);
  }
  return res.json();
}
