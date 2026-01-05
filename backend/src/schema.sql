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
