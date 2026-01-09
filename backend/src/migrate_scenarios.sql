PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scenario_templates (
  template_id   TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  hazard_type   TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS scenario_template_rules (
  rule_id           TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL,

  event_kind        TEXT NOT NULL,              -- IMPACT | REPAIR
  time_pct          REAL NOT NULL,              -- 0..100 (percent of scenario duration)
  time_jitter_pct   REAL NOT NULL DEFAULT 0,    -- optional jitter in percent

  selection_scope   TEXT NOT NULL,              -- GEO_RADIUS | GEO_SCATTER | GRAPH_CENTRALITY
  sector            TEXT NOT NULL,
  subtype           TEXT NOT NULL,

  target_mode       TEXT NOT NULL,              -- PCT | COUNT
  target_value      REAL NOT NULL,

  allow_reuse_asset INTEGER NOT NULL DEFAULT 0, -- 0/1

  performance_pct   INTEGER NOT NULL,           -- set-to 0..100
  repair_time_min   INTEGER,                    -- minutes (nullable)
  repair_time_max   INTEGER,                    -- minutes (nullable)

  geo_anchor        TEXT NOT NULL DEFAULT 'CITY_CENTER', -- EPICENTER | CITY_CENTER | FLOOD_POCKET | FIRE_FRONT | ...
  geo_param_1_km    REAL NOT NULL DEFAULT 0,             -- radius/param in km when relevant

  priority          INTEGER NOT NULL DEFAULT 5,
  notes             TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,

  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (template_id) REFERENCES scenario_templates(template_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_str_template_rules_template_id
  ON scenario_template_rules(template_id);

CREATE INDEX IF NOT EXISTS idx_str_template_rules_sector_subtype
  ON scenario_template_rules(sector, subtype);

CREATE INDEX IF NOT EXISTS idx_str_template_rules_template_time
  ON scenario_template_rules(template_id, time_pct);
