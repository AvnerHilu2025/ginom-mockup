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
  console.log("Cleaning existing data...");
  await run(db, "DELETE FROM asset_dependencies");
  await run(db, "DELETE FROM asset_operational_state");
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
      await run(
        db,
        `
        INSERT INTO asset_operational_state (asset_id, status, updated_at)
        VALUES (?, 'active', CURRENT_TIMESTAMP)
        `,
        [id]
      );
    }
  }

  console.log("Seed complete.");
  console.log(
    `Total assets seeded: ${SECTORS.reduce((sum, s) => sum + s.count, 0)}`
  );

  // ================================
  // ADD HERE: Seed asset dependencies
  // ================================

  console.log("Seeding dependencies (rich graph, chains up to ~5)...");

  const selectAssets = (sector) =>
    new Promise((resolve, reject) => {
      db.all(
        `SELECT id, subtype FROM assets WHERE sector=?`,
        [sector],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

  const electricity = await selectAssets("electricity");
  const water = await selectAssets("water");
  const gas = await selectAssets("gas");
  const comm = await selectAssets("communication");
  const fr = await selectAssets("first_responders");

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pickN = (arr, n) => {
    const out = new Set();
    while (out.size < n && out.size < arr.length) out.add(pick(arr).id);
    return Array.from(out);
  };

  const addDep = async (providerId, consumerId, type, priority = 1) => {
    await run(
      db,
      `
      INSERT INTO asset_dependencies
      (provider_asset_id, consumer_asset_id, dependency_type, priority, is_active)
      VALUES (?, ?, ?, ?, 1)
      `,
      [providerId, consumerId, type, priority]
    );
  };

  // Define "root-like" providers to encourage bounded chain depth
  // We keep some assets as anchors (less likely to depend on others)
  const electricRoots = electricity
    .filter(a => a.subtype === "substation")
    .map(a => a.id);
  const commRoots = comm
    .filter(a => a.subtype === "switch")
    .map(a => a.id);

  const electricAllIds = electricity.map(a => a.id);
  const waterAllIds = water.map(a => a.id);
  const gasAllIds = gas.map(a => a.id);
  const commAllIds = comm.map(a => a.id);
  const frAllIds = fr.map(a => a.id);

  let depCount = 0;

  // Helper: add 1-2 power deps with backup probability
  const addPowerDeps = async (consumerId, backupProb = 0.75) => {
    const primary = pick(electricRoots.length ? electricRoots : electricAllIds);
    await addDep(primary, consumerId, "power", 1); depCount++;

    if (Math.random() < backupProb) {
      let backup = pick(electricAllIds);
      if (backup === primary && electricAllIds.length > 1) backup = pick(electricAllIds);
      await addDep(backup, consumerId, "power", 2); depCount++;
    }
  };

  // Helper: add comms dependency
  const addCommsDep = async (consumerId, prob = 0.85) => {
    if (Math.random() > prob) return;
    const provider = pick(commRoots.length ? commRoots : commAllIds);
    await addDep(provider, consumerId, "comms", 1); depCount++;
  };

  // 1) WATER: power + comms almost always, sometimes depends on gas (diesel) as backup (demo)
  for (const c of waterAllIds) {
    await addPowerDeps(c, 0.8);
    await addCommsDep(c, 0.9);

    if (Math.random() < 0.25) { // optional extra dependency
      const pGas = pick(gasAllIds);
      await addDep(pGas, c, "fuel", 2); depCount++;
    }
  }

  // 2) COMMUNICATION: power always, plus intra-sector (fiber_node -> switch) to create depth
  for (const a of comm) {
    const c = a.id;
    await addPowerDeps(c, 0.7);

    // intra-sector dependency: fiber_node depends on switch; cell_tower depends on fiber_node
    if (a.subtype === "fiber_node" && commRoots.length) {
      const p = pick(commRoots);
      await addDep(p, c, "comms", 1); depCount++;
    } else if (a.subtype === "cell_tower" && comm.length) {
      const fiber = pick(comm.filter(x => x.subtype === "fiber_node"));
      if (fiber?.id) { await addDep(fiber.id, c, "comms", 1); depCount++; }
    }
  }

  // 3) GAS: power + comms always, sometimes depends on water (cooling) to create cross-sector depth
  for (const c of gasAllIds) {
    await addPowerDeps(c, 0.75);
    await addCommsDep(c, 0.9);

    if (Math.random() < 0.35) {
      const pWater = pick(waterAllIds);
      await addDep(pWater, c, "water", 1); depCount++;
    }
  }

  // 4) FIRST RESPONDERS: power + comms always; often water; sometimes depends on gas (fuel)
  for (const c of frAllIds) {
    await addPowerDeps(c, 0.85);
    await addCommsDep(c, 0.95);

    if (Math.random() < 0.7) {
      const pWater = pick(waterAllIds);
      await addDep(pWater, c, "water", 1); depCount++;
    }

    if (Math.random() < 0.3) {
      const pGas = pick(gasAllIds);
      await addDep(pGas, c, "fuel", 1); depCount++;
    }
  }

  // 5) ELECTRICITY intra-sector depth: distribution_node depends on substation and comms (SCADA)
  for (const a of electricity) {
    if (a.subtype !== "distribution_node") continue;

    // Depend on a substation (primary)
    const pSub = pick(electricRoots.length ? electricRoots : electricAllIds);
    await addDep(pSub, a.id, "power", 1); depCount++;

    // SCADA / comms link (creates chain depth)
    await addCommsDep(a.id, 0.8);
  }

  console.log(`Dependencies seeded (rich): ${depCount}`);


  // ================================
  // END dependencies seed
  // ================================

  db.close();
}


main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
