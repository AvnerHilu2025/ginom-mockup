/**
 * scenario_loader.js (ESM)
 * Auto-load scenario template CSVs into SQLite on server startup.
 *
 * Expected directory structure:
 *   src/scenarios/*.csv
 *   src/migrate_scenarios.sql
 *
 * Environment variables (optional):
 *   SCENARIO_TEMPLATES_DIR   default: ./src/scenarios
 *   SCENARIO_MIGRATION_SQL  default: ./src/migrate_scenarios.sql
 *   SCENARIO_AUTOLOAD       default: "1" (set to "0" to disable)
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";

function asBool(v, def = true) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return def;
}

function toInt(v, def = null) {
  if (v === undefined || v === null || String(v).trim() === "") return def;
  return Math.trunc(Number(v));
}
function toFloat(v, def = 0) {
  if (v === undefined || v === null || String(v).trim() === "") return def;
  return Number(v);
}
function normStr(v, def = "") {
  if (v === undefined || v === null) return def;
  return String(v).trim();
}

const REQUIRED_COLS = [
  "template_id","template_name","hazard_type","rule_id","event_kind",
  "time_pct","time_jitter_pct","selection_scope","sector","subtype",
  "target_mode","target_value","allow_reuse_asset",
  "performance_pct","repair_time_min","repair_time_max",
  "geo_anchor","geo_param_1_km","priority","notes"
];

function validateHeaders(row0) {
  for (const c of REQUIRED_COLS) {
    if (!(c in row0)) throw new Error(`Missing column in CSV: ${c}`);
  }
}

export function loadScenarioTemplatesAuto(dbPath) {
  const enabled = asBool(process.env.SCENARIO_AUTOLOAD, true);
  if (!enabled) {
    console.log("[scenarios] Auto-load disabled (SCENARIO_AUTOLOAD=0).");
    return { loadedFiles: 0, loadedRules: 0, loadedTemplates: 0 };
  }

  const templatesDir = process.env.SCENARIO_TEMPLATES_DIR || "./src/scenarios";
  const migrationSql = process.env.SCENARIO_MIGRATION_SQL || "./src/migrate_scenarios.sql";

  const absDb = path.resolve(dbPath);
  const absDir = path.resolve(templatesDir);
  const absMig = path.resolve(migrationSql);

  if (!fs.existsSync(absMig)) {
    console.warn(`[scenarios] migration SQL not found: ${absMig} (skipping)`);
    return { loadedFiles: 0, loadedRules: 0, loadedTemplates: 0 };
  }
  if (!fs.existsSync(absDir)) {
    console.warn(`[scenarios] templates dir not found: ${absDir} (skipping)`);
    return { loadedFiles: 0, loadedRules: 0, loadedTemplates: 0 };
  }

  const files = fs.readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(absDir, f))
    .sort();

  if (!files.length) {
    console.log(`[scenarios] No CSV templates found in ${absDir}.`);
    return { loadedFiles: 0, loadedRules: 0, loadedTemplates: 0 };
  }

  const db = new Database(absDb);
  db.pragma("foreign_keys = ON");

  console.log(`[scenarios] Running migration: ${absMig}`);
  db.exec(fs.readFileSync(absMig, "utf8"));

  const upsertTemplate = db.prepare(`
    INSERT INTO scenario_templates (template_id, template_name, hazard_type, version, updated_at)
    VALUES (@template_id, @template_name, @hazard_type, @version, CURRENT_TIMESTAMP)
    ON CONFLICT(template_id) DO UPDATE SET
      template_name=excluded.template_name,
      hazard_type=excluded.hazard_type,
      version=excluded.version,
      updated_at=CURRENT_TIMESTAMP
  `);

  const upsertRule = db.prepare(`
    INSERT INTO scenario_template_rules (
      rule_id, template_id,
      event_kind, time_pct, time_jitter_pct,
      selection_scope, sector, subtype,
      target_mode, target_value,
      allow_reuse_asset,
      performance_pct, repair_time_min, repair_time_max,
      geo_anchor, geo_param_1_km,
      priority, notes, enabled
    ) VALUES (
      @rule_id, @template_id,
      @event_kind, @time_pct, @time_jitter_pct,
      @selection_scope, @sector, @subtype,
      @target_mode, @target_value,
      @allow_reuse_asset,
      @performance_pct, @repair_time_min, @repair_time_max,
      @geo_anchor, @geo_param_1_km,
      @priority, @notes, 1
    )
    ON CONFLICT(rule_id) DO UPDATE SET
      template_id=excluded.template_id,
      event_kind=excluded.event_kind,
      time_pct=excluded.time_pct,
      time_jitter_pct=excluded.time_jitter_pct,
      selection_scope=excluded.selection_scope,
      sector=excluded.sector,
      subtype=excluded.subtype,
      target_mode=excluded.target_mode,
      target_value=excluded.target_value,
      allow_reuse_asset=excluded.allow_reuse_asset,
      performance_pct=excluded.performance_pct,
      repair_time_min=excluded.repair_time_min,
      repair_time_max=excluded.repair_time_max,
      geo_anchor=excluded.geo_anchor,
      geo_param_1_km=excluded.geo_param_1_km,
      priority=excluded.priority,
      notes=excluded.notes,
      enabled=1
  `);

  let loadedFiles = 0;
  let loadedRules = 0;
  let loadedTemplates = 0;

  const tx = db.transaction((rows) => {
    const seen = new Set();
    for (const r of rows) {
      const tid = normStr(r.template_id);
      if (seen.has(tid)) continue;
      seen.add(tid);
      upsertTemplate.run({
        template_id: tid,
        template_name: normStr(r.template_name, tid),
        hazard_type: normStr(r.hazard_type),
        version: 1,
      });
    }
    loadedTemplates += seen.size;

    for (const r of rows) {
      upsertRule.run({
        rule_id: normStr(r.rule_id),
        template_id: normStr(r.template_id),
        event_kind: normStr(r.event_kind),
        time_pct: toFloat(r.time_pct),
        time_jitter_pct: toFloat(r.time_jitter_pct, 0),

        selection_scope: normStr(r.selection_scope),
        sector: normStr(r.sector),
        subtype: normStr(r.subtype),

        target_mode: normStr(r.target_mode),
        target_value: toFloat(r.target_value),

        allow_reuse_asset: toInt(r.allow_reuse_asset, 0),

        performance_pct: toInt(r.performance_pct, 100),
        repair_time_min: toInt(r.repair_time_min, null),
        repair_time_max: toInt(r.repair_time_max, null),

        geo_anchor: normStr(r.geo_anchor, "CITY_CENTER"),
        geo_param_1_km: toFloat(r.geo_param_1_km, 0),

        priority: toInt(r.priority, 5),
        notes: normStr(r.notes, ""),
      });
      loadedRules += 1;
    }
  });

  for (const file of files) {
    const csvText = fs.readFileSync(file, "utf8");
    const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
    if (!rows.length) continue;

    validateHeaders(rows[0]);
    tx(rows);
    loadedFiles += 1;
    console.log(`[scenarios] Loaded: ${path.basename(file)} (${rows.length} rules)`);
  }

  // Quick sanity output
  const counts = db.prepare(`
    SELECT template_id, COUNT(*) AS rules_count
    FROM scenario_template_rules
    WHERE enabled=1
    GROUP BY template_id
    ORDER BY template_id
  `).all();
  console.table(counts);

  db.close();
  return { loadedFiles, loadedRules, loadedTemplates };
}
