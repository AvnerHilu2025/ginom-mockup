/**
 * load_scenario_templates.js
 * Usage:
 *   node load_scenario_templates.js demo.db scenario_templates.csv migrate_scenarios.sql
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parse } = require("csv-parse/sync");

function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
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

const [,, dbPath, csvPath, migratePath] = process.argv;
must(dbPath, "Missing db path argument");
must(csvPath, "Missing csv path argument");
must(migratePath, "Missing migrate sql path argument");

const absDb = path.resolve(dbPath);
const absCsv = path.resolve(csvPath);
const absMig = path.resolve(migratePath);

if (!fs.existsSync(absDb)) throw new Error(`DB not found: ${absDb}`);
if (!fs.existsSync(absCsv)) throw new Error(`CSV not found: ${absCsv}`);
if (!fs.existsSync(absMig)) throw new Error(`Migration SQL not found: ${absMig}`);

const db = new Database(absDb);
db.pragma("foreign_keys = ON");

console.log("Running migration...");
db.exec(fs.readFileSync(absMig, "utf8"));

console.log("Reading CSV...");
const csvText = fs.readFileSync(absCsv, "utf8");

// Expect headers like: template_id,template_name,hazard_type,rule_id,event_kind,time_pct,...
const rows = parse(csvText, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

// Minimal header validation
const requiredCols = ["template_id", "template_name", "hazard_type", "rule_id", "event_kind",
  "time_pct", "time_jitter_pct", "selection_scope", "sector", "subtype",
  "target_mode", "target_value", "allow_reuse_asset",
  "performance_pct", "repair_time_min", "repair_time_max",
  "geo_anchor", "geo_param_1_km", "priority", "notes"
];

for (const c of requiredCols) {
  if (!(c in rows[0])) {
    throw new Error(`Missing column in CSV: ${c}`);
  }
}

// Prepared statements
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

const tx = db.transaction((rows) => {
  // Upsert templates (dedupe by id)
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

  // Upsert rules
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
  }
});

console.log("Loading into DB...");
tx(rows);

console.log("Done. Quick sanity checks:");
const templates = db.prepare(`SELECT template_id, template_name, hazard_type, version, is_active FROM scenario_templates ORDER BY template_id`).all();
const counts = db.prepare(`SELECT template_id, COUNT(*) AS rules_count FROM scenario_template_rules WHERE enabled=1 GROUP BY template_id ORDER BY template_id`).all();
console.table(templates);
console.table(counts);

db.close();
