import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import { getDependenciesGraph, openDb, initSchema, all } from "./db.js";
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



app.get("/health", (req, res) => res.json({ ok: true }));

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
        // Phase 2: we will add real sim artifacts and the Recommendations screen.
        artifacts.push({
          type: "sim_status",
          data: {
            state: "running",
            message: "Simulation execution is not implemented yet (Phase 2).",
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
