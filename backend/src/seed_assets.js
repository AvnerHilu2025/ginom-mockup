import "dotenv/config";
import crypto from "crypto";
import path from "path";
import { openDb, initSchema, run } from "./db.js";

function uuid() {
  return crypto.randomUUID();
}

function randIn(min, max) {
  return min + Math.random() * (max - min);
}

// Jerusalem bounding box (rough but safe for demo – no sea)
const JERUSALEM = {
  latMin: 31.73,
  latMax: 31.83,
  lngMin: 35.15,
  lngMax: 35.27,
};

const CITY_NAME = "Jerusalem";

// Canonical sectors (FINAL naming)
const SECTORS = [
  {
    sector: "electricity",
    subtypes: ["substation", "transformer", "distribution_node"],
    count: 100,
  },
  {
    sector: "water",
    subtypes: ["pump_station", "reservoir", "treatment_facility"],
    count: 100,
  },
  {
    sector: "gas",
    subtypes: ["gas_station", "regulator", "pipeline_node"],
    count: 80,
  },
  {
    sector: "communication",
    subtypes: ["cell_tower", "fiber_node", "switch"],
    count: 120,
  },
  {
    sector: "first_responders",
    subtypes: ["police_station", "fire_station", "ems_station"],
    count: 60,
  },
];

async function main() {
  const db = openDb(process.env.DB_PATH || "./demo.db");
  await initSchema(db, path.resolve("src/schema.sql"));

  console.log("Cleaning existing assets...");
  await run(db, "DELETE FROM assets");

  console.log("Seeding assets for Jerusalem...");

  for (const s of SECTORS) {
    for (let i = 0; i < s.count; i++) {
      const id = uuid();
      const subtype = s.subtypes[i % s.subtypes.length];

      const name = `${s.sector.toUpperCase()}_${subtype}_${String(i + 1).padStart(3, "0")}`;

      const lat = randIn(JERUSALEM.latMin, JERUSALEM.latMax);
      const lng = randIn(JERUSALEM.lngMin, JERUSALEM.lngMax);

      // Criticality: first responders & electricity are more critical
      let criticality = 3;
      if (s.sector === "electricity") criticality = 5;
      if (s.sector === "first_responders") criticality = 5;
      if (s.sector === "communication") criticality = 4;

      await run(
        db,
        `
        INSERT INTO assets
        (id, name, sector, subtype, lat, lng, city, criticality, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          name,
          s.sector,
          subtype,
          lat,
          lng,
          CITY_NAME,
          criticality,
          JSON.stringify({
            demo: true,
            seeded_at: new Date().toISOString(),
          }),
        ]
      );
    }
  }

  console.log("Seed complete.");
  console.log(
    `Total assets seeded: ${SECTORS.reduce((sum, s) => sum + s.count, 0)}`
  );

  db.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
