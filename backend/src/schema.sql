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
