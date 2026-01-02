import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import { openDb, initSchema, all } from "./db.js";
import { ollamaChat } from "./ollama.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { ragSearch } from "./rag.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "./demo.db";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const db = openDb(DB_PATH);
await initSchema(db, path.resolve("src/schema.sql"));

app.get("/health", (req, res) => res.json({ ok: true }));

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

const ALL_SECTORS = ["electricity", "water", "gas", "communication", "first_responders"];

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
          { type: "MAP_SET_VIEW", payload: view },
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
          { type: "MAP_SET_VIEW", payload: view },
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
        { type: "MAP_SET_VIEW", payload: view },
        { type: "MAP_SHOW_ASSETS", payload: { city, sectors: ALL_SECTORS } },

      ];
    }

    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "chat_failed", details: e.message });
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
