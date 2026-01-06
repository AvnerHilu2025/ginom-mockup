// backend/src/seed_city.js
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { run, all } from "./db.js";

/**
 * Deterministic RNG (Mulberry32) for repeatable seeds.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid() {
  return crypto.randomUUID();
}

function safeInt(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function randIn(rng, min, max) {
  return min + rng() * (max - min);
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffleInPlace(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}


/**
 * Introspect SQLite schema.
 */
async function tableExists(db, tableName) {
  const rows = await all(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [tableName]
  );
  return rows.length > 0;
}

async function getTableColumns(db, tableName) {
  const rows = await all(db, `PRAGMA table_info(${tableName});`, []);
  return new Set(rows.map((r) => r.name));
}

/**
 * Create a random point inside bbox.
 * bbox: { latMin, latMax, lngMin, lngMax }
 * Adds mild bias towards center for better visuals.
 */
function randomPointInBbox(rng, bbox, center = null) {
  const lat = randIn(rng, bbox.latMin, bbox.latMax);
  const lng = randIn(rng, bbox.lngMin, bbox.lngMax);

  if (!center) return { lat, lng };

  const w = 0.35 * rng(); // 0..0.35
  return {
    lat: lat * (1 - w) + center.lat * w,
    lng: lng * (1 - w) + center.lng * w,
  };
}

/**
 * Point-in-polygon helpers (GeoJSON uses [lng, lat]).
 * Ray casting.
 */
function pointInRing(point, ring) {
  const x = point.lng;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function polygonContainsPoint(point, poly) {
  // poly = [outerRing, hole1, hole2,...]
  const outer = poly[0];
  if (!outer || outer.length < 3) return false;

  if (!pointInRing(point, outer)) return false;

  // holes: if inside any hole -> reject
  for (let h = 1; h < poly.length; h++) {
    const hole = poly[h];
    if (hole && hole.length >= 3 && pointInRing(point, hole)) return false;
  }
  return true;
}

function pointInGeoJSON(point, geojson) {
  if (!geojson || !geojson.type || !geojson.coordinates) return true;

  if (geojson.type === "Polygon") return polygonContainsPoint(point, geojson.coordinates);

  if (geojson.type === "MultiPolygon") {
    for (const poly of geojson.coordinates) {
      if (polygonContainsPoint(point, poly)) return true;
    }
    return false;
  }

  // Unknown type -> accept (fail-open)
  return true;
}

/**
 * LAND MASK loading (Natural Earth land polygons).
 * Put file at: backend/src/data/ne_land.geojson
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let LAND_GEOJSON_CACHE = null;

function loadLandGeoJSON() {
  if (LAND_GEOJSON_CACHE) return LAND_GEOJSON_CACHE;

  const p = path.join(__dirname, "data", "ne_land.geojson");
  const raw = fs.readFileSync(p, "utf8");
  const gj = JSON.parse(raw);

  // Accept FeatureCollection or direct geometry
  LAND_GEOJSON_CACHE = gj;
  return LAND_GEOJSON_CACHE;
}

function pointOnLand(point) {
  const land = loadLandGeoJSON();

  if (!land) return true;

  if (land.type === "FeatureCollection") {
    for (const f of land.features || []) {
      if (!f?.geometry) continue;
      if (pointInGeoJSON(point, f.geometry)) return true;
    }
    return false;
  }

  // Geometry
  return pointInGeoJSON(point, land);
}

/**
 * Sample a point inside boundary:
 * - must be inside city polygon (if exists)
 * - must be on land (always)
 */
async function randomPointInBoundary(rng, boundary) {
  const bbox = boundary?.bbox;
  const center = boundary?.center || null;
  const cityPoly = boundary?.boundary_json || null;

  if (!bbox) throw new Error("randomPointInBoundary: bbox is required");

  const MAX_TRIES = 2000; // high enough to be robust for narrow coastal cities
  for (let i = 0; i < MAX_TRIES; i++) {
    const p = randomPointInBbox(rng, bbox, center);

    // 1) City polygon constraint (if exists)
    if (cityPoly && !pointInGeoJSON(p, cityPoly)) continue;

    // 2) Land mask constraint (bullet-proof against sea)
    if (!pointOnLand(p)) continue;

    return p;
  }

  // Fallback: center if it is on land, else just return center anyway
  if (center && pointOnLand(center)) return { lat: center.lat, lng: center.lng };
  return { lat: (bbox.latMin + bbox.latMax) / 2, lng: (bbox.lngMin + bbox.lngMax) / 2 };
}

function deriveCounts(profile) {
  if (profile === "dense") return { perSector: 120, electricityBonus: 30 };
  if (profile === "basic") return { perSector: 25, electricityBonus: 10 };
  return { perSector: 60, electricityBonus: 20 }; // balanced default
}

function subtypeFor(sector, rng) {
  const dict = {
    electricity: ["substation", "transformer", "mv_node", "lv_node"],
    water: ["pump_station", "reservoir", "treatment"],
    gas: ["regulator", "pipeline_node", "storage"],
    communication: ["cell_tower", "exchange", "fiber_node"],
    first_responders: ["police", "fire_station", "ems"],
  };
  return pick(rng, dict[sector] || ["node"]);
}

function criticalityFor(sector, subtype) {
  if (sector === "electricity") return subtype === "substation" ? 5 : 4;
  if (sector === "first_responders") return 5;
  if (sector === "communication") return 4;
  if (sector === "water") return 4;
  if (sector === "gas") return 4;
  return 3;
}

export async function seedCity(
  db,
  { city, boundary, profile = "balanced", random_seed = 1234, created_by = "system" }
) {
  if (!city) throw new Error("seedCity: city is required");
  if (!boundary?.bbox) throw new Error("seedCity: boundary.bbox is required");

  // Ensure required tables exist
  const hasAssets = await tableExists(db, "assets");
  const hasDeps = await tableExists(db, "asset_dependencies");
  const hasState = await tableExists(db, "asset_operational_state");
  const hasSeedRuns = await tableExists(db, "seed_runs");

  if (!hasAssets) throw new Error("seedCity: missing table 'assets'");
  if (!hasDeps) throw new Error("seedCity: missing table 'asset_dependencies'");
  if (!hasState) throw new Error("seedCity: missing table 'asset_operational_state'");
  if (!hasSeedRuns) throw new Error("seedCity: missing table 'seed_runs'");

  const assetsCols = await getTableColumns(db, "assets");
  const stateCols = await getTableColumns(db, "asset_operational_state");
  const depsCols = await getTableColumns(db, "asset_dependencies");

  const hasSeedRunIdInAssets = assetsCols.has("seed_run_id");
  const hasIsSyntheticInAssets = assetsCols.has("is_synthetic");
  const hasMetaJsonInAssets = assetsCols.has("meta_json");
  const hasCriticality = assetsCols.has("criticality");

  const hasUpdatedAt = stateCols.has("updated_at");
  const hasIsActive = depsCols.has("is_active");

  const seed_run_id = uuid();
  const rng = mulberry32(safeInt(random_seed, 1234));

  await run(
    db,
    `
    INSERT INTO seed_runs (id, city, boundary_json, profile, random_seed, created_by, status)
    VALUES (?, ?, ?, ?, ?, ?, 'applied')
    `,
    [
      seed_run_id,
      city,
      boundary?.boundary_json ? JSON.stringify(boundary.boundary_json) : null,
      profile,
      safeInt(random_seed, 1234),
      created_by,
    ]
  );

  const { perSector, electricityBonus } = deriveCounts(profile);
  const sectors = ["electricity", "water", "gas", "communication", "first_responders"];

  const idsBySector = {};
  let insertedAssets = 0;

  for (const sector of sectors) {
    const n = sector === "electricity" ? perSector + electricityBonus : perSector;
    idsBySector[sector] = [];

    for (let i = 0; i < n; i++) {
      const id = uuid();
      const subtype = subtypeFor(sector, rng);
      const pt = await randomPointInBoundary(rng, boundary);

      const name = `${city} ${sector} ${subtype} ${i + 1}`;
      const criticality = criticalityFor(sector, subtype);

      const cols = ["id", "name", "sector", "subtype", "lat", "lng", "city"];
      const vals = [id, name, sector, subtype, pt.lat, pt.lng, city];

      if (hasCriticality) {
        cols.push("criticality");
        vals.push(criticality);
      }

      if (hasMetaJsonInAssets) {
        cols.push("meta_json");
        vals.push(
          JSON.stringify({
            synthetic: true,
            seed_run_id,
            profile,
            random_seed: safeInt(random_seed, 1234),
            generated_at: new Date().toISOString(),
          })
        );
      }

      if (hasSeedRunIdInAssets) {
        cols.push("seed_run_id");
        vals.push(seed_run_id);
      }

      if (hasIsSyntheticInAssets) {
        cols.push("is_synthetic");
        vals.push(1);
      }

      const placeholders = cols.map(() => "?").join(", ");
      await run(db, `INSERT INTO assets (${cols.join(", ")}) VALUES (${placeholders})`, vals);

      if (hasUpdatedAt) {
        await run(
          db,
          `INSERT INTO asset_operational_state (asset_id, status, updated_at)
           VALUES (?, 'active', CURRENT_TIMESTAMP)`,
          [id]
        );
      } else {
        await run(db, `INSERT INTO asset_operational_state (asset_id, status) VALUES (?, 'active')`, [
          id,
        ]);
      }

      idsBySector[sector].push(id);
      insertedAssets++;
    }
  }

  // Dependencies (no meta_json column in your DB)
  const electricityIds = idsBySector.electricity || [];
  const commIds = idsBySector.communication || [];

  let insertedDeps = 0;

  async function addDep(provider, consumer, depType, priority = 1) {
    if (hasIsActive) {
      await run(
        db,
        `
        INSERT INTO asset_dependencies
          (provider_asset_id, consumer_asset_id, dependency_type, priority, is_active)
        VALUES (?, ?, ?, ?, 1)
        `,
        [provider, consumer, depType, priority]
      );
    } else {
      await run(
        db,
        `
        INSERT INTO asset_dependencies
          (provider_asset_id, consumer_asset_id, dependency_type, priority)
        VALUES (?, ?, ?, ?)
        `,
        [provider, consumer, depType, priority]
      );
    }
    insertedDeps++;
  }
  for (const sector of Object.keys(idsBySector)) {
    const ids = [...(idsBySector[sector] || [])];
    if (ids.length < 2) continue;

    shuffleInPlace(rng, ids);

    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      await addDep(a, b, "sector_link", 1);
    }
  }

  async function addPowerDeps(consumerId) {
    if (!electricityIds.length) return;
    const primary = pick(rng, electricityIds);
    await addDep(primary, consumerId, "power", 1);

    if (rng() < 0.7 && electricityIds.length > 1) {
      let backup = pick(rng, electricityIds);
      if (backup === primary) backup = pick(rng, electricityIds);
      await addDep(backup, consumerId, "power", 2);
    }
  }

  async function addCommDep(consumerId) {
    if (!commIds.length) return;
    if (rng() < 0.45) {
      const provider = pick(rng, commIds);
      await addDep(provider, consumerId, "communication", 1);
    }
  }

  for (const sector of ["water", "gas", "first_responders", "communication"]) {
    for (const id of idsBySector[sector] || []) {
      await addPowerDeps(id);
      await addCommDep(id);
    }
  }
   const degree = new Map();
  for (const sector of Object.keys(idsBySector)) {
    for (const id of idsBySector[sector] || []) degree.set(id, 0);
  }

  // Count degrees from DB (authoritative)
  const depRows = await all(
    db,
    `
    SELECT provider_asset_id AS asset_id FROM asset_dependencies
    UNION ALL
    SELECT consumer_asset_id AS asset_id FROM asset_dependencies
    `,
    []
  );

  for (const r of depRows) {
    const aid = r?.asset_id;
    if (!aid) continue;
    if (degree.has(aid)) degree.set(aid, (degree.get(aid) || 0) + 1);
  }

  // Fix isolated assets
  const electricityIds2 = idsBySector.electricity || [];
  for (const sector of Object.keys(idsBySector)) {
    const ids = idsBySector[sector] || [];
    for (const id of ids) {
      if ((degree.get(id) || 0) > 0) continue;

      // Prefer same-sector partner if available
      if (ids.length > 1) {
        const partner = pick(rng, ids.filter((x) => x !== id));
        await addDep(id, partner, "sector_link", 1);
        degree.set(id, 1);
        continue;
      }

      // Fallback: connect to electricity (power)
      if (electricityIds2.length) {
        const provider = pick(rng, electricityIds2);
        await addDep(provider, id, "power", 1);
        degree.set(id, 1);
      }
    }
  }


  return {
    seed_run_id,
    city,
    profile,
    counts: {
      assets: insertedAssets,
      dependencies: insertedDeps,
    },
  };
}

export async function rollbackSeedRun(db, { seed_run_id, hard = true }) {
  if (!seed_run_id) throw new Error("rollbackSeedRun: seed_run_id is required");

  const hasAssets = await tableExists(db, "assets");
  const hasSeedRuns = await tableExists(db, "seed_runs");
  if (!hasAssets) throw new Error("rollbackSeedRun: missing table 'assets'");
  if (!hasSeedRuns) throw new Error("rollbackSeedRun: missing table 'seed_runs'");

  const assetsCols = await getTableColumns(db, "assets");
  if (!assetsCols.has("seed_run_id")) {
    throw new Error("rollbackSeedRun: assets.seed_run_id column is missing. Run the migration first.");
  }

  if (!hard) {
    throw new Error("rollbackSeedRun: soft mode not implemented (requires assets.deleted_at)");
  }

  const r = await run(db, `DELETE FROM assets WHERE seed_run_id = ?`, [seed_run_id]);
  await run(db, `UPDATE seed_runs SET status='rolled_back' WHERE id = ?`, [seed_run_id]);

  return { seed_run_id, mode: "hard", deleted_assets: r?.changes || 0 };
}

export async function getLatestSeedRunIdForCity(db, city) {
  const hasSeedRuns = await tableExists(db, "seed_runs");
  if (!hasSeedRuns) return null;

  const rows = await all(
    db,
    `
    SELECT id
    FROM seed_runs
    WHERE city = ? AND status = 'applied'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [city]
  );
  return rows?.[0]?.id || null;
}
