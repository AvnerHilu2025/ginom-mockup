PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT NOT NULL,
  subtype TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  city TEXT,
  criticality INTEGER DEFAULT 3,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

-- =========================================
-- Asset Dependencies (Provider -> Consumer)
-- =========================================
CREATE TABLE IF NOT EXISTS asset_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  provider_asset_id TEXT NOT NULL,
  consumer_asset_id TEXT NOT NULL,

  dependency_type TEXT NOT NULL,     -- e.g. power, water, comms
  priority INTEGER DEFAULT 1,         -- 1 = primary, 2+ = backup
  is_active INTEGER DEFAULT 1,        -- logical enable/disable

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (provider_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (consumer_asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dep_provider
  ON asset_dependencies(provider_asset_id);

CREATE INDEX IF NOT EXISTS idx_dep_consumer
  ON asset_dependencies(consumer_asset_id);

-- =========================================
-- Asset Operational State
-- =========================================
CREATE TABLE IF NOT EXISTS asset_operational_state (
  asset_id TEXT PRIMARY KEY,

  status TEXT NOT NULL CHECK (
    status IN ('active', 'partial', 'inactive')
  ),

  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- =========================================
-- Scenario Templates (if not already created by migration)
-- =========================================
CREATE TABLE IF NOT EXISTS scenario_templates (
  template_id TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  hazard_type TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scenario_template_rules (
  rule_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,                 -- IMPACT | REPAIR
  time_pct REAL NOT NULL,                   -- % of scenario duration
  time_jitter_pct REAL NOT NULL DEFAULT 0,  -- optional jitter
  selection_scope TEXT NOT NULL,            -- GEO_RADIUS | GEO_SCATTER | GRAPH_CENTRALITY ...
  sector TEXT NOT NULL,
  subtype TEXT NOT NULL,
  target_mode TEXT NOT NULL,                -- PCT | COUNT
  target_value REAL NOT NULL,
  allow_reuse_asset INTEGER NOT NULL DEFAULT 0,
  performance_pct INTEGER NOT NULL,         -- 0..100 (set-to)
  repair_time_min INTEGER,
  repair_time_max INTEGER,
  geo_anchor TEXT NOT NULL DEFAULT 'CITY_CENTER',
  geo_param_1_km REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 5,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES scenario_templates(template_id)
);

CREATE INDEX IF NOT EXISTS idx_rules_template
  ON scenario_template_rules(template_id);

-- =========================================
-- Scenario Instance + Prepared Events (Option A)
-- =========================================
CREATE TABLE IF NOT EXISTS scenario_instances (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  scenario TEXT NOT NULL,               -- UI scenario key (earthquake, tsunami...)
  hazard_type TEXT NOT NULL,
  template_id TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  tick_minutes INTEGER NOT NULL,
  repair_crews INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PREPARED',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES scenario_templates(template_id)
);

CREATE TABLE IF NOT EXISTS scenario_instance_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL,            -- EPICENTER / IMPACT_CENTER / ...
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instance_id) REFERENCES scenario_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_instance_anchors_instance
  ON scenario_instance_anchors(instance_id);

CREATE TABLE IF NOT EXISTS scenario_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  tick_index INTEGER NOT NULL,
  event_kind TEXT NOT NULL,             -- IMPACT | REPAIR
  asset_id TEXT NOT NULL,
  performance_pct INTEGER NOT NULL,     -- set-to 0..100
  repair_time_minutes INTEGER,          -- optional
  source_rule_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instance_id) REFERENCES scenario_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_instance
  ON scenario_events(instance_id);

CREATE INDEX IF NOT EXISTS idx_events_instance_tick
  ON scenario_events(instance_id, tick_index);
