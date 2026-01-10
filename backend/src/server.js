/// CHANGE STARTER ...........
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

//import { getDependenciesGraph, openDb, initSchema, all } from "./db.js";
import { getDependenciesGraph, openDb, initSchema, all, run, get } from "./db.js";

import { ollamaChat } from "./ollama.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { ragSearch } from "./rag.js";
import { seedCity, rollbackSeedRun, getLatestSeedRunIdForCity } from "./seed_city.js";
import { loadScenarioTemplatesAuto } from "./scenario_loader.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "./demo.db";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const db = openDb(DB_PATH);
await initSchema(db, path.resolve("src/schema.sql"));
loadScenarioTemplatesAuto(DB_PATH);

////////////////////////////////////////////

// ============================================================
// Simulation Runs (Phase 2) - In-memory (sqlite3 async version)
// ============================================================

const SIM_RUNS = new Map(); // sim_run_id -> run object

function makeSimRunId() {
  return `sim_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function perfPctToStatus(perfPct) {
  const p = clamp(Number(perfPct ?? 100), 0, 100);
  if (p >= 100) return "RECOVERED";
  if (p >= 50) return "DEGRADED";
  return "FAILED";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Creates a simulation run shell, then computes ticks asynchronously.
 * IMPORTANT: This version matches your sqlite3 Database + schema.sql.
 */
async function startSimulationRun(db, scenario_instance_id) {
  // 1) Load scenario instance
  const inst = await get(
    db,
    `
    SELECT
      id,
      city,
      scenario,
      duration_hours,
      tick_minutes
    FROM scenario_instances
    WHERE id = ?
  `,
    [String(scenario_instance_id)]
  );

  if (!inst) {
    throw new Error(`scenario_instance_id not found: ${scenario_instance_id}`);
  }

  const durationHours = Number(inst.duration_hours || 0);
  const tickMinutes = Math.max(1, Number(inst.tick_minutes || 10));
  const totalMinutes = Math.max(0, durationHours * 60);
  const totalTicks = Math.max(1, Math.floor(totalMinutes / tickMinutes));

  // 2) Load assets (city-scoped)
  const assets = await all(
    db,
    `
    SELECT id, name, sector, subtype, criticality, lat, lng
    FROM assets
    WHERE city = ?
  `,
    [String(inst.city)]
  );

  // 3) Load events for this instance
  // schema.sql: scenario_events(instance_id, tick_index, asset_id, performance_pct, ...)
  const events = await all(
    db,
    `
    SELECT tick_index, asset_id, performance_pct, event_kind
    FROM scenario_events
    WHERE instance_id = ?
    ORDER BY tick_index ASC
  `,
    [String(scenario_instance_id)]
  );

  // Index events by tick
  const eventsByTick = new Map();
  for (const ev of events) {
    const t = Math.max(0, Math.trunc(Number(ev.tick_index || 0)));
    if (!eventsByTick.has(t)) eventsByTick.set(t, []);
    eventsByTick.get(t).push({
      asset_id: String(ev.asset_id),
      performance_pct: clamp(Number(ev.performance_pct ?? 100), 0, 100),
      event_kind: String(ev.event_kind || ""),
    });
  }

  const sim_run_id = makeSimRunId();

  const run = {
    sim_run_id,
    scenario_instance_id: String(scenario_instance_id),
    city: String(inst.city || ""),
    tick_minutes: tickMinutes,
    total_ticks: totalTicks,

    computed_max_tick: -1,
    done: false,

    cache: new Map(), // tick_index -> payload

    // State: asset_id -> performance_pct (0..100)
    perfPctById: new Map(),

    assets,
    eventsByTick,
  };

  // Baseline: all 100%
  for (const a of assets) run.perfPctById.set(String(a.id), 100);

  SIM_RUNS.set(sim_run_id, run);

  // async compute (backend continues even if UI pauses)
  computeSimRunTicks(run).catch((err) => {
    console.error("computeSimRunTicks failed:", err);
    run.done = true;
  });

  return run;
}

async function computeSimRunTicks(run) {
  // Prev status for "changed" detection (baseline)
  const prevStatus = new Map();
  for (const a of run.assets) {
    const id = String(a.id);
    const perf = Number(run.perfPctById.get(id) ?? 100);
    prevStatus.set(id, perfPctToStatus(perf));
  }

  // Precompute sector weights (criticality)
  const sectorWeights = {};
  for (const a of run.assets) {
    const sec = String(a.sector || "unknown");
    const w = Math.max(1, Number(a.criticality || 1));
    sectorWeights[sec] = (sectorWeights[sec] || 0) + w;
  }

  for (let t = 0; t < run.total_ticks; t++) {
    // Apply direct events at tick t (set-to performance_pct)
    const evs = run.eventsByTick.get(t) || [];
    for (const ev of evs) {
      run.perfPctById.set(ev.asset_id, clamp(ev.performance_pct, 0, 100));
    }

    // Compute changed assets + sector health
    const assets_changed = [];
    const sectorPerfSum = {}; // sec -> sum(perf% * weight)

    for (const a of run.assets) {
      const id = String(a.id);
      const sec = String(a.sector || "unknown");
      const w = Math.max(1, Number(a.criticality || 1));
      const perf = clamp(Number(run.perfPctById.get(id) ?? 100), 0, 100);

      sectorPerfSum[sec] = (sectorPerfSum[sec] || 0) + perf * w;

      const status = perfPctToStatus(perf);
      const old = prevStatus.get(id);
      if (old !== status) {
        assets_changed.push({ id, status });
      }
      prevStatus.set(id, status);
    }

    const sectors = {};
    for (const sec of Object.keys(sectorWeights)) {
      const wSum = sectorWeights[sec] || 1;
      const avgPerf = (sectorPerfSum[sec] || 100 * wSum) / wSum; // 0..100
      sectors[sec] = Math.round(clamp(avgPerf, 0, 100));
    }

    // Simple demo recommendations
    const recommendations = [];
    if (assets_changed.length) {
      recommendations.push(
        `Tick ${t + 1}: ${assets_changed.length} assets changed state. Prioritize critical repairs in affected sectors.`
      );
    }

    const payload = {
      sim_run_id: run.sim_run_id,
      tick_index: t,
      total_ticks: run.total_ticks,
      sectors,
      assets_changed,
      recommendations,
    };

    run.cache.set(t, payload);
    run.computed_max_tick = t;

    // Simulate compute time (optional)
    await sleep(40);
  }

  run.done = true;
}
//////////////////////////////////////////////

app.get("/health", (req, res) => res.json({ ok: true }));
/* ============================================================
   Simulation APIs (Phase 2)
   ============================================================ */

// GET /api/sim/state?sim_run_id=...
app.get("/api/sim/state", (req, res) => {
  const sim_run_id = String(req.query.sim_run_id || "").trim();
  if (!sim_run_id) return res.status(400).json({ error: "sim_run_id is required" });

  const run = SIM_RUNS.get(sim_run_id);
  if (!run) return res.status(404).json({ error: `sim_run_id not found: ${sim_run_id}` });

  return res.json({
    sim_run_id: run.sim_run_id,
    scenario_instance_id: run.scenario_instance_id,
    city: run.city,
    total_ticks: run.total_ticks,
    computed_max_tick: run.computed_max_tick,
    done: run.done,
  });
});

// GET /api/sim/tick?sim_run_id=...&tick_index=...
app.get("/api/sim/tick", (req, res) => {
  const sim_run_id = String(req.query.sim_run_id || "").trim();
  const tick_index = Number(req.query.tick_index);
  if (!sim_run_id) return res.status(400).json({ error: "sim_run_id is required" });
  if (!Number.isFinite(tick_index)) return res.status(400).json({ error: "tick_index is required" });

  const run = SIM_RUNS.get(sim_run_id);
  if (!run) return res.status(404).json({ error: `sim_run_id not found: ${sim_run_id}` });

  const t = Math.max(0, Math.min(run.total_ticks - 1, Math.trunc(tick_index)));
  const payload = run.cache.get(t);

  if (!payload) {
    return res.json({
      sim_run_id,
      tick_index: t,
      pending: true,
      computed_max_tick: run.computed_max_tick,
      done: run.done,
    });
  }

  return res.json({ ...payload, pending: false, computed_max_tick: run.computed_max_tick, done: run.done });
});


/* ============================================================
   Scenario Prepare API (Option A) - create instance + events
   ============================================================ */

const SCENARIO_TO_TEMPLATE = {
  earthquake: { template_id: "EQ_030", hazard_type: "EARTHQUAKE", anchor_required: "EPICENTER" },
  cyber_attack: { template_id: "CY_020", hazard_type: "CYBER", anchor_required: null },
  tsunami: { template_id: "TS_025", hazard_type: "TSUNAMI", anchor_required: "IMPACT_CENTER" },
  pandemic: { template_id: "PD_040", hazard_type: "PANDEMIC", anchor_required: null },
  severe_storm: { template_id: "SS_020", hazard_type: "SEVERE_STORM", anchor_required: "FLOOD_POCKET" },
  wildfire: { template_id: "WF_020", hazard_type: "WILDFIRE", anchor_required: "FIRE_ORIGIN" },
};

function nowId(prefix = "scn") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${Math.random().toString(16).slice(2, 8)}`;
}

function clampInt(n, lo, hi) {
  const x = Math.trunc(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pickCount(target_mode, target_value, candidatesCount) {
  const mode = String(target_mode || "").toUpperCase();
  const val = Number(target_value || 0);

  if (mode === "COUNT") {
    return clampInt(val, 0, candidatesCount);
  }
  // default PCT
  const pct = Math.max(0, Math.min(100, val));
  return clampInt(Math.ceil((pct / 100) * candidatesCount), 0, candidatesCount);
}

function pctToTickIndex(timePct, totalTicks) {
  const p = Math.max(0, Math.min(100, Number(timePct || 0)));
  // event can happen between ticks; visible on next tick -> ceil
  const idx = Math.ceil((p / 100) * totalTicks);
  return Math.max(0, Math.min(totalTicks - 1, idx));
}

function avgRepairMinutes(minv, maxv) {
  const a = Number(minv);
  const b = Number(maxv);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  if (!Number.isFinite(a)) return Math.trunc(b);
  if (!Number.isFinite(b)) return Math.trunc(a);
  return Math.trunc((a + b) / 2);
}
// ============================================================
// Demo enhancement: auto recovery events (so the scenario improves over time)
// ============================================================

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * For each damaged asset event (<100%), schedule:
 * 1) a partial repair (to 50..95%) a few ticks later
 * 2) a full repair (to 100%) later
 *
 * Inserts into scenario_events with:
 * (instance_id, tick_index, event_kind, asset_id, performance_pct, repair_time_minutes, source_rule_id)
 */


async function injectAutoRecoveries(db, instance_id, { totalTicks, tick_minutes }) {
  const damageEvents = await all(
    db,
    `
    SELECT tick_index, asset_id, performance_pct
    FROM scenario_events
    WHERE instance_id = ?
      AND performance_pct < 100
    ORDER BY tick_index ASC
  `,
    [String(instance_id)]
  );

  if (!damageEvents.length) return { added: 0 };

  let added = 0;
  const seen = new Set(); // de-dup: instance|asset|tick|pct

  for (const ev of damageEvents) {
    const t0 = Math.max(0, Math.trunc(Number(ev.tick_index || 0)));
    const assetId = String(ev.asset_id);
    const damagedPct = clampInt(ev.performance_pct ?? 100, 0, 100);

    // Demo tuning: you can adjust these windows later
    const partialDelay = randInt(2, 10);
    const fullDelay = randInt(8, 40);

    const tPartial = Math.min(totalTicks - 1, t0 + partialDelay);
    const tFull = Math.min(totalTicks - 1, t0 + fullDelay);

    // Partial recovery target: ensure it becomes DEGRADED (>=50), and improves vs damagedPct
    const partialPct = Math.max(50, Math.min(95, damagedPct + randInt(20, 45)));

    // Repair time minutes (for story / later use)
    const partialRepairMin = partialDelay * tick_minutes;
    const fullRepairMin = fullDelay * tick_minutes;

    // Insert partial repair if it improves
    if (partialPct > damagedPct && tPartial > t0) {
      const key = `${instance_id}|${assetId}|${tPartial}|${partialPct}`;
      if (!seen.has(key)) {
        await run(
          db,
          `
          INSERT INTO scenario_events
            (instance_id, tick_index, event_kind, asset_id, performance_pct, repair_time_minutes, source_rule_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          [String(instance_id), tPartial, "REPAIR_PARTIAL", assetId, partialPct, partialRepairMin, null]
        );
        seen.add(key);
        added++;
      }
    }

    // Insert full repair
    if (tFull > t0) {
      const key2 = `${instance_id}|${assetId}|${tFull}|100`;
      if (!seen.has(key2)) {
        await run(
          db,
          `
          INSERT INTO scenario_events
            (instance_id, tick_index, event_kind, asset_id, performance_pct, repair_time_minutes, source_rule_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          [String(instance_id), tFull, "REPAIR_FULL", assetId, 100, fullRepairMin, null]
        );
        seen.add(key2);
        added++;
      }
    }
  }

  return { added };
}

async function fetchRules(db, templateId) {
  return all(
    db,
    `
    SELECT
      rule_id, template_id,
      event_kind, time_pct, time_jitter_pct,
      selection_scope, sector, subtype,
      target_mode, target_value, allow_reuse_asset,
      performance_pct, repair_time_min, repair_time_max,
      geo_anchor, geo_param_1_km, priority, notes
    FROM scenario_template_rules
    WHERE template_id = ? AND enabled = 1
    ORDER BY time_pct ASC, priority DESC, rule_id ASC
    `,
    [templateId]
  );
}

async function fetchAssetsByCitySectorSubtype(db, city, sector, subtype) {
  return all(
    db,
    `
    SELECT id, lat, lng, criticality
    FROM assets
    WHERE city = ? AND sector = ? AND subtype = ?
    `,
    [city, sector, subtype]
  );
}

function selectAssetsForRule(rule, candidates, anchors) {
  const scope = String(rule.selection_scope || "").toUpperCase();
  let pool = candidates.slice();

  // GEO_RADIUS: filter by distance from anchor
  if (scope === "GEO_RADIUS") {
    const anchorKey = String(rule.geo_anchor || "CITY_CENTER").toUpperCase();
    const a = anchors.find(x => String(x.type).toUpperCase() === anchorKey);
    const rKm = Number(rule.geo_param_1_km || 0);

    if (a && rKm > 0) {
      pool = pool.filter(c => haversineKm(a.lat, a.lng, c.lat, c.lng) <= rKm);
    }
  }

  // GRAPH_CENTRALITY (mock): prefer high criticality
  if (scope === "GRAPH_CENTRALITY") {
    pool.sort((x, y) => Number(y.criticality || 0) - Number(x.criticality || 0));
  } else {
    // GEO_SCATTER / default: random-ish but stable order
    pool.sort((x, y) => String(x.id).localeCompare(String(y.id)));
  }

  const k = pickCount(rule.target_mode, rule.target_value, pool.length);
  return pool.slice(0, k);
}

app.post("/api/scenario/prepare", async (req, res) => {
  try {
    const body = req.body || {};
    const city = String(body.city || "").trim();
    const scenario = String(body.scenario || "").trim(); // earthquake, tsunami, ...
    const duration_hours = clampInt(body.duration_hours ?? 72, 1, 168);
    const tick_minutes = clampInt(body.tick_minutes ?? 10, 1, 60);
    const repair_crews = clampInt(body.repair_crews ?? 0, 0, 999);

    const anchors = Array.isArray(body.anchors) ? body.anchors : [];

    if (!city) return res.status(400).json({ error: "Missing city" });
    if (!scenario) return res.status(400).json({ error: "Missing scenario" });

    const mapping = SCENARIO_TO_TEMPLATE[scenario];
    if (!mapping) return res.status(400).json({ error: `Unknown scenario: ${scenario}` });

    // anchor requirement validation (if required)
    if (mapping.anchor_required) {
      const has = anchors.some(a => String(a.type).toUpperCase() === mapping.anchor_required);
      if (!has) {
        return res.status(400).json({
          error: `Missing required anchor: ${mapping.anchor_required}`,
          required_anchor: mapping.anchor_required,
        });
      }
    }

    // Create instance
    const instance_id = nowId("scn");
    await run(
      db,
      `
      INSERT INTO scenario_instances
        (id, city, scenario, hazard_type, template_id, duration_hours, tick_minutes, repair_crews, status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED')
      `,
      [
        instance_id,
        city,
        scenario,
        mapping.hazard_type,
        mapping.template_id,
        duration_hours,
        tick_minutes,
        repair_crews,
      ]
    );

    // Save anchors
    for (const a of anchors) {
      const type = String(a.type || "").toUpperCase();
      const lat = Number(a.lat);
      const lng = Number(a.lng);
      if (!type || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      await run(
        db,
        `
        INSERT INTO scenario_instance_anchors (instance_id, anchor_type, lat, lng)
        VALUES (?, ?, ?, ?)
        `,
        [instance_id, type, lat, lng]
      );
    }

    const rules = await fetchRules(db, mapping.template_id);
    const totalTicks = Math.max(1, Math.trunc((duration_hours * 60) / tick_minutes));

    // Build events
    let eventsCreated = 0;
    const usedAssets = new Set();

    for (const rule of rules) {
      const candidates = await fetchAssetsByCitySectorSubtype(db, city, rule.sector, rule.subtype);

      if (!candidates.length) {
        // If you want: collect warnings for UI ("not enough assets")
        continue;
      }

      const chosen = selectAssetsForRule(rule, candidates, anchors);

      for (const a of chosen) {
        // enforce allow_reuse_asset = 0 by default across entire scenario
        if (!rule.allow_reuse_asset && usedAssets.has(a.id)) continue;

        const tick_index = pctToTickIndex(rule.time_pct, totalTicks);
        const repair_time_minutes = avgRepairMinutes(rule.repair_time_min, rule.repair_time_max);

        await run(
          db,
          `
          INSERT INTO scenario_events
            (instance_id, tick_index, event_kind, asset_id, performance_pct, repair_time_minutes, source_rule_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            instance_id,
            tick_index,
            String(rule.event_kind || "").toUpperCase(),
            a.id,
            clampInt(rule.performance_pct, 0, 100),
            repair_time_minutes,
            rule.rule_id,
          ]
        );

        eventsCreated++;
        usedAssets.add(a.id);
      }
    }
/*
  const rec = await injectAutoRecoveries(db, instance_id, {
    totalTicks,
    tick_minutes,
  });
*/
    
  let rec = { added: 0 };
  try {
    rec = await injectAutoRecoveries(db, instance_id, { totalTicks, tick_minutes });
  } catch (e) {
    console.warn("injectAutoRecoveries failed (continuing):", e);
  }

// Important: include in prepared summary (helps verify behavior)
  return res.json({
    scenario_instance_id: instance_id,
    template_id: mapping.template_id,
    hazard_type: mapping.hazard_type,
    total_rules: rules.length,
    events_created: eventsCreated,
    auto_recoveries_added: rec.added,
    assets_used: usedAssets.size,
    total_ticks: totalTicks,
    status: "PREPARED",
  });
  } catch (err) {
    console.error("POST /api/scenario/prepare failed:", err);
    return res.status(500).json({
      error: "Internal error",
      details: String(err?.message || err),
    });

  }
});

/* ============================================================
   Dependencies API
   ============================================================ */
/**
 * GET /api/dependencies/chain
 * Query:
 *   asset_id=ASSET_ID (required)
 *   direction=upstream|downstream (default: upstream)
 *   max_depth=number (default: 4, max: 12)
 *
 * Data model: asset_dependencies is Provider -> Consumer
 * - upstream:   consumer -> provider (what does this asset depend on?)
 * - downstream: provider -> consumer (who depends on this asset?)
 */
app.get("/api/dependencies/chain", async (req, res) => {
  try {
    const asset_id = String(req.query.asset_id || "").trim();
    const direction = String(req.query.direction || "upstream").toLowerCase();
    const max_depth = Math.max(1, Math.min(12, Number(req.query.max_depth || 4)));

    if (!asset_id) return res.status(400).json({ error: "asset_id is required" });
    if (!["upstream", "downstream"].includes(direction)) {
      return res.status(400).json({ error: "direction must be 'upstream' or 'downstream'" });
    }

    const deps = await all(
      db,
      `SELECT provider_asset_id, consumer_asset_id, dependency_type, priority
       FROM asset_dependencies
       WHERE is_active = 1`
    );

    const visited = new Set([asset_id]);
    const nodesSet = new Set([asset_id]);
    const edges = [];
    const q = [{ id: asset_id, depth: 0 }];
    const seenEdges = new Set();

    const edgeKey = (from, to, t, p) => `${from}__${to}__${t || ""}__${p ?? ""}`;

    while (q.length) {
      const { id, depth } = q.shift();
      if (depth >= max_depth) continue;

      for (const d of deps) {
        const match =
          direction === "upstream"
            ? d.consumer_asset_id === id
            : d.provider_asset_id === id;

        if (!match) continue;

        const from =
          direction === "upstream" ? d.consumer_asset_id : d.provider_asset_id;
        const to =
          direction === "upstream" ? d.provider_asset_id : d.consumer_asset_id;

        const k = edgeKey(from, to, d.dependency_type, d.priority);
        if (!seenEdges.has(k)) {
          seenEdges.add(k);
          edges.push({
            from,
            to,
            dependency_type: d.dependency_type,
            priority: d.priority,
            level: depth + 1,
          });
        }

        nodesSet.add(from);
        nodesSet.add(to);

        if (!visited.has(to)) {
          visited.add(to);
          q.push({ id: to, depth: depth + 1 });
        }
      }
    }

    const ids = Array.from(nodesSet);
    const placeholders = ids.map(() => "?").join(",");

    const nodes = await all(
      db,
      `SELECT id, name, sector, subtype, lat, lng, city, criticality
       FROM assets
       WHERE id IN (${placeholders})`,
      ids
    );

    if (!nodes.some((n) => n.id === asset_id)) {
      return res.status(404).json({ error: `asset_id not found: ${asset_id}` });
    }

    return res.json({ root_asset_id: asset_id, direction, max_depth, nodes, edges });
  } catch (err) {
    console.error("GET /api/dependencies/chain failed:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});


/* =========================
   Helpers: city inference + defaults
   ========================= */
function pickCityFromMessage(message) {
  const m = String(message || "").toLowerCase();
  if (m.includes("jerusalem")) return "Jerusalem";
  if (m.includes("tel aviv") || m.includes("tlv")) return "Tel Aviv";
  return null;
}
/*
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
*/

/*
async function injectAutoRecoveries(db, instanceId, { totalTicks, tickMinutes }) {
  // Load all events that reduce performance < 100
  const damageEvents = await all(
    db,
    `
    SELECT tick_index, asset_id, performance_pct
    FROM scenario_events
    WHERE instance_id = ?
      AND performance_pct < 100
    ORDER BY tick_index ASC
  `,
    [String(instanceId)]
  );

  if (!damageEvents.length) return { added: 0 };

  // Recovery policy (demo tuning)
  // - partial fix between 2..10 ticks after damage
  // - full fix between 8..40 ticks after damage
  // Keep inside totalTicks
  let added = 0;
  const seen = new Set(); // instanceId|assetId|tickIndex|perfPct

  for (const ev of damageEvents) {
    const t0 = Math.max(0, Math.trunc(Number(ev.tick_index || 0)));
    const assetId = String(ev.asset_id);
    const damagedPct = Math.max(0, Math.min(100, Number(ev.performance_pct || 100)));

    // If it's already lightly damaged, still recover, but shorter window
    const partialDelay = randInt(2, 10);
    const fullDelay = randInt(8, 40);

    const tPartial = Math.min(totalTicks - 1, t0 + partialDelay);
    const tFull = Math.min(totalTicks - 1, t0 + fullDelay);

    // Choose target partial performance (at least 50 to make it DEGRADED, and above damagedPct)
    const partialPct = Math.max(50, Math.min(95, damagedPct + randInt(20, 45)));

    // Insert partial recovery (if it actually improves)
    if (partialPct > damagedPct && tPartial > t0) {
      const key = `${instanceId}|${assetId}|${tPartial}|${partialPct}`;
      if (!seen.has(key)) {
        await run(
          db,
          `
          INSERT INTO scenario_events (instance_id, tick_index, asset_id, event_kind, performance_pct, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          [
            String(instanceId),
            tPartial,
            assetId,
            "REPAIR_PARTIAL",
            partialPct,
            `Auto repair: partial recovery scheduled (+${partialDelay} ticks)`,
          ]
        );
        seen.add(key);
        added++;
      }
    }

    // Insert full recovery to 100
    if (tFull > t0) {
      const key2 = `${instanceId}|${assetId}|${tFull}|100`;
      if (!seen.has(key2)) {
        await run(
          db,
          `
          INSERT INTO scenario_events (instance_id, tick_index, asset_id, event_kind, performance_pct, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          [
            String(instanceId),
            tFull,
            assetId,
            "REPAIR_FULL",
            100,
            `Auto repair: full recovery scheduled (+${fullDelay} ticks)`,
          ]
        );
        seen.add(key2);
        added++;
      }
    }
  }

  return { added };
}
*/

async function getDefaultCityFromDb(db, fallback = "Jerusalem") {
  try {
    const rows = await all(
      db,
      `SELECT city, COUNT(*) AS c
       FROM assets
       GROUP BY city
       ORDER BY c DESC
       LIMIT 1`
    );
    if (rows?.length && rows[0]?.city) return rows[0].city;
  } catch (_) {}
  return fallback;
}

const VIEW_BY_CITY = {
  Jerusalem: { lat: 31.7683, lng: 35.2137, zoom: 11.0 },
  "Tel Aviv": { lat: 32.0853, lng: 34.7818, zoom: 11.0 },
};
async function resolveCityBoundary(cityName) {
  const q = String(cityName || "").trim();
  if (!q) return null;

  // Nominatim requires a User-Agent / Referer
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q,
      format: "jsonv2",
      limit: "1",
      polygon_geojson: "1",
      addressdetails: "1",
    }).toString();

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "GINOM-Mockup/1.0 (demo)",
      "Accept": "application/json",
    },
  });

  if (!resp.ok) return null;
  const arr = await resp.json();
  if (!Array.isArray(arr) || !arr.length) return null;

  const r = arr[0];
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null;
  // boundingbox: [south, north, west, east]
  const bbox =
    bb && bb.length === 4
      ? { latMin: bb[0], latMax: bb[1], lngMin: bb[2], lngMax: bb[3] }
      : null;

  const boundary_json = r.geojson || null;

  // Rough zoom heuristic from bbox size
  let zoom = 11;
  if (bbox) {
    const dLat = Math.abs(bbox.latMax - bbox.latMin);
    const dLng = Math.abs(bbox.lngMax - bbox.lngMin);
    const d = Math.max(dLat, dLng);
    if (d > 3) zoom = 7;
    else if (d > 1.5) zoom = 8;
    else if (d > 0.7) zoom = 9;
    else if (d > 0.3) zoom = 10;
    else zoom = 11.5;
  }

  return {
    city: r.name || q,
    view: { lat: Number.isFinite(lat) ? lat : 0, lng: Number.isFinite(lng) ? lng : 0, zoom },
    bbox,
    boundary_json,
  };
}

async function countAssetsInCity(db, city) {
  const rows = await all(
    db,
    `SELECT COUNT(*) AS c FROM assets WHERE city = ?`,
    [city]
  );
  return Number(rows?.[0]?.c || 0);
}

const ALL_SECTORS = ["electricity", "water", "gas", "communication", "first_responders"];
// =========================
// Scenario Templates helpers
// =========================

function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toFixed(n < 10 ? 1 : 0);
}

async function fetchTemplatesSummary(db) {
  const rows = await all(
    db,
    `
    SELECT
      t.template_id,
      t.template_name,
      t.hazard_type,
      COUNT(r.rule_id) AS rules_count,
      SUM(CASE WHEN r.event_kind='IMPACT' THEN 1 ELSE 0 END) AS impacts,
      SUM(CASE WHEN r.event_kind='REPAIR' THEN 1 ELSE 0 END) AS repairs,
      MIN(r.time_pct) AS min_time_pct,
      MAX(r.time_pct) AS max_time_pct
    FROM scenario_templates t
    JOIN scenario_template_rules r ON r.template_id = t.template_id
    WHERE t.is_active=1 AND r.enabled=1
    GROUP BY t.template_id, t.template_name, t.hazard_type
    ORDER BY rules_count DESC, t.hazard_type, t.template_id
    `
  );
  return rows || [];
}

async function fetchTemplateBreakdown(db, templateId) {
  const [header] = await all(
    db,
    `
    SELECT
      t.template_id,
      t.template_name,
      t.hazard_type,
      COUNT(r.rule_id) AS rules_count,
      SUM(CASE WHEN r.event_kind='IMPACT' THEN 1 ELSE 0 END) AS impacts,
      SUM(CASE WHEN r.event_kind='REPAIR' THEN 1 ELSE 0 END) AS repairs,
      MIN(r.time_pct) AS min_time_pct,
      MAX(r.time_pct) AS max_time_pct
    FROM scenario_templates t
    JOIN scenario_template_rules r ON r.template_id = t.template_id
    WHERE t.template_id = ? AND t.is_active=1 AND r.enabled=1
    GROUP BY t.template_id, t.template_name, t.hazard_type
    `,
    [templateId]
  );

  const sectorRows = await all(
    db,
    `
    SELECT sector, subtype, COUNT(*) AS cnt
    FROM scenario_template_rules
    WHERE template_id = ? AND enabled=1
    GROUP BY sector, subtype
    ORDER BY cnt DESC, sector, subtype
    `,
    [templateId]
  );

  const scopeRows = await all(
    db,
    `
    SELECT selection_scope, COUNT(*) AS cnt
    FROM scenario_template_rules
    WHERE template_id = ? AND enabled=1
    GROUP BY selection_scope
    ORDER BY cnt DESC
    `,
    [templateId]
  );

  return { header: header || null, sectorRows: sectorRows || [], scopeRows: scopeRows || [] };
}

async function fetchTemplateTimelineBuckets(db, templateId, bucketSizePct = 5) {
  const bucket = Math.max(1, Math.min(20, Number(bucketSizePct || 5)));

  const rows = await all(
    db,
    `
    SELECT
      CAST(time_pct / ? AS INT) * ? AS bucket_start,
      CAST(time_pct / ? AS INT) * ? + ? AS bucket_end,
      COUNT(*) AS rules,
      SUM(CASE WHEN event_kind='IMPACT' THEN 1 ELSE 0 END) AS impacts,
      SUM(CASE WHEN event_kind='REPAIR' THEN 1 ELSE 0 END) AS repairs
    FROM scenario_template_rules
    WHERE template_id = ? AND enabled=1
    GROUP BY bucket_start, bucket_end
    ORDER BY bucket_start
    `,
    [bucket, bucket, bucket, bucket, bucket, templateId]
  );

  return rows || [];
}

function renderTemplatesSummaryText(rows) {
  if (!rows.length) return "No scenario templates found in the database.";
  const lines = [];
  lines.push("Scenario templates loaded:");
  lines.push("");

  for (const r of rows) {
    lines.push(
      `• ${r.template_id} — ${r.template_name} [${r.hazard_type}] | ` +
      `${r.rules_count} rules (IMPACT ${r.impacts}, REPAIR ${r.repairs}) | ` +
      `Time ${fmtPct(r.min_time_pct)}–${fmtPct(r.max_time_pct)}%`
    );
  }

  lines.push("");
  lines.push("Commands:");
  lines.push("• template <TEMPLATE_ID>   (e.g., template EQ_030)");
  lines.push("• timeline <TEMPLATE_ID>  (e.g., timeline EQ_030)");
  return lines.join("\n");
}

function renderTemplateDetailsText({ header, sectorRows, scopeRows }) {
  if (!header) return "Template not found (or inactive).";

  const lines = [];
  lines.push(`${header.template_id} — ${header.template_name}`);
  lines.push(`Hazard: ${header.hazard_type}`);
  lines.push(
    `Rules: ${header.rules_count} (IMPACT ${header.impacts}, REPAIR ${header.repairs}) | ` +
    `Time ${fmtPct(header.min_time_pct)}–${fmtPct(header.max_time_pct)}%`
  );
  lines.push("");

  lines.push("Top sector/subtype coverage:");
  for (const r of sectorRows.slice(0, 10)) {
    lines.push(`• ${r.sector} / ${r.subtype}: ${r.cnt}`);
  }
  if (sectorRows.length > 10) lines.push(`… +${sectorRows.length - 10} more`);

  lines.push("");
  lines.push("Selection scopes:");
  for (const r of scopeRows) {
    lines.push(`• ${r.selection_scope}: ${r.cnt}`);
  }

  lines.push("");
  lines.push("Commands:");
  lines.push(`• timeline ${header.template_id}`);
  return lines.join("\n");
}

function renderTimelineText(templateId, rows, bucketSizePct = 5) {
  if (!rows.length) return `No timeline data for ${templateId}.`;
  const lines = [];
  lines.push(`Timeline for ${templateId} (bucket = ${bucketSizePct}%):`);
  lines.push("");
  for (const r of rows) {
    lines.push(
      `• ${r.bucket_start}–${r.bucket_end}%: ${r.rules} rules ` +
      `(IMPACT ${r.impacts}, REPAIR ${r.repairs})`
    );
  }
  return lines.join("\n");
}
// =========================
// Prepared scenarios helpers
// =========================

async function fetchPreparedInstances(db, limit = 10) {
  return all(
    db,
    `
    SELECT
      i.id,
      i.city,
      i.scenario,
      i.template_id,
      i.status,
      i.created_at,
      (SELECT COUNT(*) FROM scenario_events e WHERE e.instance_id = i.id) AS events_count,
      (SELECT COUNT(DISTINCT asset_id) FROM scenario_events e WHERE e.instance_id = i.id) AS assets_count,
      (SELECT MIN(tick_index) FROM scenario_events e WHERE e.instance_id = i.id) AS min_tick,
      (SELECT MAX(tick_index) FROM scenario_events e WHERE e.instance_id = i.id) AS max_tick
    FROM scenario_instances i
    WHERE i.status = 'PREPARED'
    ORDER BY i.created_at DESC
    LIMIT ?
    `,
    [limit]
  );
}

async function fetchPreparedSummary(db, instanceId) {
  const [header] = await all(
    db,
    `
    SELECT id, city, scenario, template_id, hazard_type, duration_hours, tick_minutes, repair_crews, status, created_at
    FROM scenario_instances
    WHERE id = ?
    `,
    [instanceId]
  );

  if (!header) return null;

  const anchors = await all(
    db,
    `
    SELECT anchor_type, lat, lng
    FROM scenario_instance_anchors
    WHERE instance_id = ?
    ORDER BY id
    `,
    [instanceId]
  );

  const kindBreakdown = await all(
    db,
    `
    SELECT event_kind, COUNT(*) AS cnt
    FROM scenario_events
    WHERE instance_id = ?
    GROUP BY event_kind
    `,
    [instanceId]
  );

  const sectorBreakdown = await all(
    db,
    `
    SELECT a.sector, a.subtype, COUNT(*) AS cnt
    FROM scenario_events e
    JOIN assets a ON a.id = e.asset_id
    WHERE e.instance_id = ?
    GROUP BY a.sector, a.subtype
    ORDER BY cnt DESC
    LIMIT 10
    `,
    [instanceId]
  );

  const [range] = await all(
    db,
    `
    SELECT MIN(tick_index) AS min_tick, MAX(tick_index) AS max_tick
    FROM scenario_events
    WHERE instance_id = ?
    `,
    [instanceId]
  );

  return { header, anchors, kindBreakdown, sectorBreakdown, range };
}

async function fetchPreparedTimeline(db, instanceId, bucketSize = 20) {
  const b = Math.max(1, Math.trunc(bucketSize));
  return all(
    db,
    `
    SELECT
      CAST(tick_index / ? AS INT) * ? AS bucket_start,
      CAST(tick_index / ? AS INT) * ? + (? - 1) AS bucket_end,
      COUNT(*) AS cnt,
      SUM(CASE WHEN event_kind='IMPACT' THEN 1 ELSE 0 END) AS impacts,
      SUM(CASE WHEN event_kind='REPAIR' THEN 1 ELSE 0 END) AS repairs
    FROM scenario_events
    WHERE instance_id = ?
    GROUP BY bucket_start, bucket_end
    ORDER BY bucket_start
    `,
    [b, b, b, b, b, instanceId]
  );
}

function renderPreparedList(rows) {
  if (!rows.length) return "No prepared scenarios found.";
  const lines = ["Prepared scenarios:"];
  for (const r of rows) {
    lines.push(
      `• ${r.id} | ${r.city} | ${r.scenario} | ${r.template_id} | ` +
      `${r.events_count} events / ${r.assets_count} assets | ticks ${r.min_tick}–${r.max_tick}`
    );
  }
  lines.push("");
  lines.push("Commands:");
  lines.push("• show prepared <INSTANCE_ID>");
  lines.push("• timeline prepared <INSTANCE_ID> [bucket]");
  return lines.join("\n");
}

function renderPreparedSummaryText(data) {
  if (!data) return "Prepared scenario not found.";

  const { header, anchors, kindBreakdown, sectorBreakdown, range } = data;
  const lines = [];

  lines.push(`Prepared Scenario: ${header.id}`);
  lines.push(`City: ${header.city}`);
  lines.push(`Scenario: ${header.scenario}`);
  lines.push(`Template: ${header.template_id}`);
  lines.push(`Status: ${header.status}`);
  lines.push(`Created: ${header.created_at}`);
  lines.push(`Duration: ${header.duration_hours}h | Tick: ${header.tick_minutes} min`);
  lines.push("");

  if (anchors.length) {
    lines.push("Anchors:");
    for (const a of anchors) {
      lines.push(`• ${a.anchor_type}: (${a.lat.toFixed(5)}, ${a.lng.toFixed(5)})`);
    }
    lines.push("");
  }

  lines.push("Events breakdown:");
  for (const k of kindBreakdown) {
    lines.push(`• ${k.event_kind}: ${k.cnt}`);
  }

  lines.push("");
  lines.push(`Tick range: ${range.min_tick} – ${range.max_tick}`);
  lines.push("");

  lines.push("Top sectors:");
  for (const s of sectorBreakdown) {
    lines.push(`• ${s.sector} / ${s.subtype}: ${s.cnt}`);
  }

  lines.push("");
  lines.push(`Command: timeline prepared ${header.id}`);
  return lines.join("\n");
}

function renderPreparedTimelineText(instanceId, rows, bucket) {
  if (!rows.length) return `No timeline data for ${instanceId}.`;
  const lines = [`Timeline for ${instanceId} (bucket=${bucket} ticks):`, ""];
  for (const r of rows) {
    lines.push(
      `• ticks ${r.bucket_start}–${r.bucket_end}: ${r.cnt} events ` +
      `(IMPACT ${r.impacts}, REPAIR ${r.repairs})`
    );
  }
  return lines.join("\n");
}


/**
 * POST /api/chat
 * Body: { session_id, message, context }
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "Missing message" });

    const text = String(message).toLowerCase();

    // ---------- helper: parse sectors from text ----------
    function parseSectorsFromText(t) {
      // Map possible user words -> canonical sector keys used in DB/UI
      const dict = [
        { key: "electricity", synonyms: ["electricity", "power", "grid", "electric"] },
        { key: "water", synonyms: ["water", "wastewater", "sewage"] },
        { key: "gas", synonyms: ["gas", "pipeline"] },
        { key: "communication", synonyms: ["communication", "communications", "telecom", "cell", "fiber", "network"] },
        { key: "emergency", synonyms: ["emergency", "police", "fire", "ems"] },
        { key: "first_responders", synonyms: ["first responders", "first responder", "responders"] },
      ];

      const found = [];
      for (const item of dict) {
        for (const s of item.synonyms) {
          if (t.includes(s)) {
            found.push(item.key);
            break;
          }
        }
      }

      // if user didn't specify sectors -> default all
      if (!found.length) return ALL_SECTORS;

      // ensure uniqueness
      return Array.from(new Set(found));
    }

        
    
    // =========================
    // Scenario templates commands (must come BEFORE looksLikeCity)
    // =========================
    if (/^(templates|scenario templates)$/i.test(message.trim())) {
      const rows = await fetchTemplatesSummary(db);
      return res.json({
        assistant_message: renderTemplatesSummaryText(rows),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    const mTemplate = message.trim().match(/^template\s+([A-Za-z0-9_-]+)$/i);
    if (mTemplate) {
      const templateId = mTemplate[1].toUpperCase();
      const data = await fetchTemplateBreakdown(db, templateId);
      return res.json({
        assistant_message: renderTemplateDetailsText(data),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    const mTimeline = message.trim().match(/^timeline\s+([A-Za-z0-9_-]+)(?:\s+(\d+))?$/i);
    if (mTimeline) {
      const templateId = mTimeline[1].toUpperCase();
      const bucket = mTimeline[2] ? Number(mTimeline[2]) : 5;
      const rows = await fetchTemplateTimelineBuckets(db, templateId, bucket);
      return res.json({
        assistant_message: renderTimelineText(templateId, rows, bucket),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    // =========================
    // Prepared scenarios commands
    // =========================

    if (/^prepared$/i.test(message.trim())) {
      const rows = await fetchPreparedInstances(db, 10);
      return res.json({
        assistant_message: renderPreparedList(rows),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    const mShow = message.trim().match(/^show\s+prepared\s+([A-Za-z0-9_-]+)$/i);
    if (mShow) {
      const id = mShow[1];
      const data = await fetchPreparedSummary(db, id);
      return res.json({
        assistant_message: renderPreparedSummaryText(data),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    const mPreparedTimeline = message.trim().match(
      /^timeline\s+prepared\s+([A-Za-z0-9_-]+)(?:\s+(\d+))?$/i
    );
    if (mPreparedTimeline) {
      const id = mPreparedTimeline[1];
      const bucket = mPreparedTimeline[2] ? Number(mPreparedTimeline[2]) : 20;
      const rows = await fetchPreparedTimeline(db, id, bucket);
      return res.json({
        assistant_message: renderPreparedTimelineText(id, rows, bucket),
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
}

// ---------- City intent: user typed a city name (e.g., "London") ----------
    const looksLikeCity =
      /^[a-zA-Z\s.'-]{2,}$/.test(text) &&
      !text.includes("show") &&
      !text.includes("assets") &&
      !text.includes("simulate") &&
      !text.includes("simulation") &&
      !text.includes("run") &&
      !text.includes("config");

    if (looksLikeCity) {
      const resolved = await resolveCityBoundary(text);
      const city = resolved?.city || text;

      // Focus map even if we cannot seed yet
      const view = resolved?.view || VIEW_BY_CITY[city] || { lat: 31.7683, lng: 35.2137, zoom: 11.0 };

      const c = await countAssetsInCity(db, city);

      if (c === 0) {
        // Ask to seed
        return res.json({
          assistant_message:
            `I focused the map on ${city}. No assets were found for this city. ` +
            `Would you like me to generate synthetic assets for ${city} and load them on the map?`,
          requires_confirmation: true,
          actions: [
            { type: "MAP_SET_VIEW", payload: { ...view, city } },
            {
              type: "SEED_CITY",
              payload: {
                city,
                profile: "balanced",
                random_seed: 1234,
                boundary: resolved
                  ? { bbox: resolved.bbox, center: { lat: view.lat, lng: view.lng }, boundary_json: resolved.boundary_json }
                  : null,
              },
            },
          ],
          questions: [],
        });
      }

      // If assets already exist, show them
      return res.json({
        assistant_message: `I focused the map on ${city}. Found ${c} assets. Display them?`,
        requires_confirmation: true,
        actions: [
          { type: "MAP_SET_VIEW", payload: { ...view, city } },
          { type: "MAP_SHOW_ASSETS", payload: { city, sectors: ALL_SECTORS } },
        ],
        questions: [],
      });
    }


    // ---------- city ----------
    const cityFromMsg = pickCityFromMessage(message);
    const defaultCity = await getDefaultCityFromDb(db, "Jerusalem");
    const city = cityFromMsg || defaultCity;

    // ---------- view ----------
    const view = VIEW_BY_CITY[city] || VIEW_BY_CITY["Jerusalem"];

    // =========================
    // FAST INTENT ROUTER (NO LLM)
    // =========================
    
    const wantsShowAssets =
      (text.includes("show") && (text.includes("asset") || text.includes("infrastructure"))) ||
      text === "show assets" ||
      text.includes("display assets") ||
      text.includes("show infrastructure") ||
      text.includes("present assets") ||
      text.includes("display assets") ||
      text.includes("show assets in");

    if (wantsShowAssets) {
      const sectors = parseSectorsFromText(text);

      return res.json({
        assistant_message:
          sectors.length === ALL_SECTORS.length
            ? `Displaying assets in ${city}.`
            : `Displaying ${sectors.join(", ")} assets in ${city}.`,
        requires_confirmation: true,
        actions: [
          { type: "MAP_SET_VIEW", payload: { ...view, city } },
          { type: "MAP_SHOW_ASSETS", payload: { city, sectors } },
        ],
        questions: [],
      });
    }

    const wantsRunSim =
      text.includes("run simulation") ||
      (text.includes("run") && text.includes("simulation")) ||
      text.includes("simulate") ||
      text.includes("earthquake simulation");

    if (wantsRunSim) {
      return res.json({
        assistant_message: `Starting simulation for ${city}.`,
        requires_confirmation: true,
        actions: [
          { type: "MAP_SET_VIEW", payload: { ...view, city }},
          { type: "SIM_RUN", payload: { city, scenario: "earthquake" } },
        ],
        questions: [],
      });
    }

    const wantsDeps =
      text.includes("dependencies") ||
      text.includes("view dependencies") ||
      (text.includes("show") && text.includes("dependencies"));

    if (wantsDeps) {
      return res.json({
        assistant_message: "Dependencies view is not implemented in this demo yet.",
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    const wantsUpload =
      text.includes("upload") ||
      text.includes("upload data") ||
      text.includes("upload infrastructure");

    if (wantsUpload) {
      return res.json({
        assistant_message: "Upload flow is not implemented in this demo yet.",
        requires_confirmation: false,
        actions: [],
        questions: [],
      });
    }

    // =========================
    // LLM PATH (only if not a known command)
    // =========================
    const isCommand =
      text.includes("show") ||
      text.includes("asset") ||
      text.includes("map") ||
      text.includes("simulate") ||
      text.includes("run") ||
      text.includes("upload") ||
      text.includes("dependencies");

    // RAG only for non-command, narrative questions
    const snippets = isCommand ? [] : await ragSearch(db, message);

    const raw = await ollamaChat(
      [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt(message, snippets) },
      ],
      { fast: isCommand }
    );

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        assistant_message:
          "Acknowledged. I can show assets on the map or run a simulation. What would you like to do?",
        requires_confirmation: false,
        actions: [],
        questions: [],
      };
    }

    // Enforce expected fields
    parsed.questions ||= [];
    parsed.actions ||= [];
    if (typeof parsed.requires_confirmation !== "boolean") parsed.requires_confirmation = false;

    // Convenience fallback: if model forgot actions for assets, add them + sector parsing
    const wantsAssetsFallback =
      text.includes("asset") ||
      text.includes("infrastructure") ||
      (text.includes("show") && (text.includes("map") || text.includes("layer")));

    if (!parsed.actions.length && wantsAssetsFallback) {
      const sectors = parseSectorsFromText(text);
      parsed.requires_confirmation = true;
      parsed.actions = [
        { type: "MAP_SET_VIEW", payload: { ...view, city } },
        { type: "MAP_SHOW_ASSETS", payload: { city, sectors: ALL_SECTORS } },

      ];
    }

    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "chat_failed", details: e.message });
  }
});

app.get("/api/dependencies", async (req, res) => {
  try {
    const city = String(req.query.city || "").trim();
    if (!city) return res.status(400).json({ error: "city is required" });

    const rows = await all(
      db,
      `
      SELECT
        d.provider_asset_id,
        d.consumer_asset_id,
        d.dependency_type,
        d.priority,
        ap.sector AS provider_sector,
        ac.sector AS consumer_sector,
        ap.lat AS provider_lat,
        ap.lng AS provider_lng,
        ac.lat AS consumer_lat,
        ac.lng AS consumer_lng
      FROM asset_dependencies d
      JOIN assets ap ON ap.id = d.provider_asset_id
      JOIN assets ac ON ac.id = d.consumer_asset_id
      WHERE ap.city = ? AND ac.city = ?
      `,
      [city, city]
    );

    res.json({ city, dependencies: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to load dependencies" });
  }
});


/**
 * POST /api/execute
 * Body: { session_id, actions, context }
 * For now: supports MAP_SHOW_ASSETS by returning an artifact with assets list.
 */
app.post("/api/execute", async (req, res) => {
  try {
    const { actions } = req.body || {};
    if (!Array.isArray(actions)) return res.status(400).json({ error: "Missing actions[]" });

    const artifacts = [];

    for (const a of actions) {
              if (a?.type === "SEED_CITY") {
        const city = a.payload?.city;
        const profile = a.payload?.profile || "balanced";
        const random_seed = a.payload?.random_seed ?? 1234;

        const boundary = a.payload?.boundary;
        if (!city) {
          artifacts.push({ type: "error", data: { message: "SEED_CITY missing city" } });
          continue;
        }
        if (!boundary?.bbox) {
          artifacts.push({ type: "error", data: { message: "SEED_CITY missing boundary bbox (resolve city first)" } });
          continue;
        }

        const result = await seedCity(db, {
          city,
          boundary,
          profile,
          random_seed,
          created_by: "chat",
        });

        // Return the newly created assets so frontend can render immediately
        const rows = await all(
          db,
          `SELECT id, name, sector, subtype, lat, lng, criticality
           FROM assets
           WHERE city = ? AND seed_run_id = ?`,
          [city, result.seed_run_id]
        );

        artifacts.push({
          type: "assets",
          data: rows,
        });

        artifacts.push({
          type: "seed_status",
          data: result,
        });

        continue;
      }

      if (a?.type === "SEED_ROLLBACK") {
        const seed_run_id = a.payload?.seed_run_id;
        const city = a.payload?.city;

        let id = seed_run_id;
        if (!id && city) {
          id = await getLatestSeedRunIdForCity(db, city);
        }

        if (!id) {
          artifacts.push({ type: "error", data: { message: "SEED_ROLLBACK missing seed_run_id (or no applied seed found for city)" } });
          continue;
        }

        const rr = await rollbackSeedRun(db, { seed_run_id: id, hard: true });

        artifacts.push({ type: "seed_rollback", data: rr });
        continue;
      }

        if (a?.type === "MAP_SHOW_ASSETS") {
        const defaultCity = await getDefaultCityFromDb(db, "Jerusalem");
        const city = a.payload?.city || defaultCity;

        // Normalize sectors: allow "emergency" alias -> "first_responders"
        let sectors = Array.isArray(a.payload?.sectors) ? a.payload.sectors : ALL_SECTORS;

        sectors = sectors
            .map(s => String(s || "").trim().toLowerCase())
            .map(s => (s === "emergency" ? "first_responders" : s));

        // If user passed empty array or removed responders by mistake, default back
        if (!sectors.length) sectors = ALL_SECTORS;

        // Safety: only allow known sectors
        sectors = sectors.filter(s => ALL_SECTORS.includes(s));

        const rows = await all(
            db,
            `SELECT id, name, sector, subtype, lat, lng, criticality
            FROM assets
            WHERE city = ?
            AND sector IN (${sectors.map(() => "?").join(",")})`,
            [city, ...sectors]
        );

        artifacts.push({ type: "assets", data: rows });
        }


        if (a?.type === "SIM_RUN") {
          const scenario_instance_id = a.payload?.scenario_instance_id;
          if (!scenario_instance_id) {
            artifacts.push({
              type: "error",
              data: { message: "SIM_RUN missing scenario_instance_id" },
            });
            continue;
          }

          const run = await startSimulationRun(db, String(scenario_instance_id));

          artifacts.push({
            type: "sim_status",
            data: {
              state: "running",
              sim_run_id: run.sim_run_id,
              scenario_instance_id: run.scenario_instance_id,
              city: run.city,
              total_ticks: run.total_ticks,
              message: "Simulation started.",
            },
          });
        }

    }

    res.json({ ok: true, artifacts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "execute_failed", details: e.message });
  }
});

// =========================
// Dependencies Graph (Structural)
// =========================
app.get("/api/dependencies/graph", async (req, res) => {
  try {
    const graph = await getDependenciesGraph(db);
    res.json(graph);
  } catch (err) {
    console.error("[api/dependencies/graph]", err);
    res.status(500).json({
      error: "Failed to load dependencies graph",
    });
  }
});


app.listen(PORT, () => {
  console.log(`GINOM backend running on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});

async function keepAlive() {
  try {
    await ollamaChat([
      { role: "system", content: "You are GINOM AI." },
      { role: "user", content: "Reply with OK." }
    ],
    { fast: true });
  } catch (_) {}
}

setInterval(keepAlive, 120000); // every 2 minutes

async function warmup() {
  try {
    console.log("Warming up Ollama...");
    await ollamaChat([
      { role: "system", content: "You are GINOM AI." },
      { role: "user", content: "Say OK." }
    ],{ fast: true });
    console.log("Ollama warm-up complete.");
  } catch (e) {
    console.warn("Warm-up failed:", e.message);
  }
}
setTimeout(warmup, 1500);
