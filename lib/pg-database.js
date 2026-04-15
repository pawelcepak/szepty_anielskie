import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { translateSqliteToPostgres, toPgParams } from "./sql-translate.js";
import { CHARACTER_PORTRAITS, CHAR_ABOUT, DEFAULT_TYPICAL_HOURS, EXTRA_OR_BASE_ROWS } from "../character-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePrepare(poolOrClient, useTranslate) {
  return function prepare(sql) {
    const base = useTranslate ? translateSqliteToPostgres(sql) : sql;
    return {
      async run(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return { changes: r.rowCount ?? 0, lastInsertRowid: null };
      },
      async get(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return r.rows[0] ?? undefined;
      },
      async all(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return r.rows;
      },
    };
  };
}

async function seedCharacters(db) {
  const ins = `INSERT INTO characters (id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      category = EXCLUDED.category,
      sort_order = EXCLUDED.sort_order,
      portrait_url = COALESCE(EXCLUDED.portrait_url, characters.portrait_url),
      gender = EXCLUDED.gender,
      skills = EXCLUDED.skills,
      about = EXCLUDED.about,
      typical_hours_from = COALESCE(EXCLUDED.typical_hours_from, characters.typical_hours_from),
      typical_hours_to = COALESCE(EXCLUDED.typical_hours_to, characters.typical_hours_to)`;
  for (const r of EXTRA_OR_BASE_ROWS) {
    const url = CHARACTER_PORTRAITS[r[0]] || null;
    const m = CHAR_ABOUT[r[0]] || { gender: "", skills: "", about: "" };
    const hp = DEFAULT_TYPICAL_HOURS[r[0]] || [null, null];
    await db.prepare(ins).run(...r, url, m.gender, m.skills, m.about, hp[0], hp[1]);
  }
}

export async function createPgDatabase(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  const schemaPath = path.join(__dirname, "..", "scripts", "postgres-schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);

  const db = {
    prepare: makePrepare(pool, true),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = { prepare: makePrepare(client, true) };
        await fn(tx);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    _pool: pool,
  };

  await db
    .prepare(
      `INSERT INTO app_kv (key, value) VALUES ('assign_rr', '0') ON CONFLICT (key) DO NOTHING`
    )
    .run();

  await seedCharacters(db);

  return db;
}

export async function closePgDatabase(db) {
  if (db?._pool) await db._pool.end();
}
