import "dotenv/config";
import crypto from "crypto";
import path from "path";
import { openDb, initSchema, run } from "./db.js";

function uuid() { return crypto.randomUUID(); }
function randIn(min, max) { return min + Math.random() * (max - min); }

// Default demo city: Jerusalem (inland, avoids sea points entirely)
// You can override via env:
//   DEMO_CITY="Jerusalem"
//   DEMO_BBOX="31.72,31.83,35.14,35.27"  // latMin,latMax,lngMin,lngMax
const DEFAULT_CITY = "Jerusalem";
const DEFAULT_BBOX = { latMin: 31.72, latMax: 31.83, lngMin: 35.14, lngMax: 35.27 };

function loadDemoCityAndBbox() {
  const city = (process.env.DEMO_CITY || DEFAULT_CITY).trim();

  const bboxStr = (process.env.DEMO_BBOX || "").trim();
  if (bboxStr) {
    const parts = bboxStr.split(",").map(s => Number(s.trim()));
    if (parts.length === 4 && parts.every(n => Number.isFinite(n))) {
      const [latMin, latMax, lngMin, lngMax] = parts;
      return { city, bbox: { latMin, latMax, lngMin, lngMax } };
    }
    console.warn(`Invalid DEMO_BBOX="${bboxStr}". Using default bbox.`);
  }

  // If you ever switch DEMO_CITY, you can add more presets here.
  return { city, bbox: DEFAULT_BBOX };
}

const SECTORS = [
  { sector: "electricity", subtypes: ["substation", "transformer", "line_node"] },
  { sector: "water", subtypes: ["pump", "reservoir", "treatment"] },
  { sector: "gas", subtypes: ["station", "valve", "pipeline_node"] },
  { sector: "communication", subtypes: ["cell_tower", "fiber_node", "switch"] },
  { sector: "emergency", subtypes: ["police_station", "fire_station", "ems"] }
];

async function main() {
  const db = openDb(process.env.DB_PATH || "./demo.db");
  await initSchema(db, path.resolve("src/schema.sql"));

  const { city, bbox } = loadDemoCityAndBbox();

  await run(db, "DELETE FROM assets");

  for (const s of SECTORS) {
    for (let i = 0; i < 100; i++) {
      const id = uuid();
      const subtype = s.subtypes[i % s.subtypes.length];
      const name = `${s.sector.toUpperCase()}_${subtype}_${String(i + 1).padStart(3, "0")}`;

      const lat = randIn(bbox.latMin, bbox.latMax);
      const lng = randIn(bbox.lngMin, bbox.lngMax);

      const criticality = 1 + (i % 5);

      await run(
        db,
        `INSERT INTO assets (id, name, sector, subtype, lat, lng, city, criticality, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,

        [id, name, s.sector, subtype, lat, lng, city, criticality, JSON.stringify({ demo: true })]
      );
    }
  }

  console.log(`Seed complete: 500 assets (100 per sector) in ${city}.`);
  console.log(`BBOX: lat ${bbox.latMin}..${bbox.latMax}, lng ${bbox.lngMin}..${bbox.lngMax}`);
  db.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
