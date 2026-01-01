import sqlite3 from "sqlite3";
import fs from "fs";

sqlite3.verbose();

export function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

export function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

export function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

export function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

export async function initSchema(db, schemaPath) {
  const schema = fs.readFileSync(schemaPath, "utf-8");
  const statements = schema
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  for (const st of statements) {
    await run(db, st);
  }
}
