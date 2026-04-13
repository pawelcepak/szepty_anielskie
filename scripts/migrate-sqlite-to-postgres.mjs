import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlitePath = path.join(__dirname, "..", "data", "portal.sqlite");

const TABLES = [
  "users",
  "operators",
  "customer_sessions",
  "operator_sessions",
  "characters",
  "threads",
  "messages",
  "thread_facts",
  "ledger",
  "app_kv",
  "operator_payout_ledger",
  "operator_audit",
  "message_reports",
];

function placeholders(count, startAt = 1) {
  return Array.from({ length: count }, (_, i) => `$${i + startAt}`).join(", ");
}

async function copyTable(pg, sqlite, table) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) {
    console.log(`[pg:migrate] ${table}: 0 rows`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const colSql = cols.map((c) => `"${c}"`).join(", ");
  const conflictSql =
    table === "app_kv"
      ? ` ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`
      : ` ON CONFLICT ("id") DO NOTHING`;
  const insertSql = `INSERT INTO "${table}" (${colSql}) VALUES (${placeholders(cols.length)})${conflictSql}`;

  await pg.query("BEGIN");
  try {
    for (const r of rows) {
      const vals = cols.map((c) => r[c]);
      await pg.query(insertSql, vals);
    }
    await pg.query("COMMIT");
    console.log(`[pg:migrate] ${table}: ${rows.length} rows`);
  } catch (err) {
    await pg.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("Brak DATABASE_URL.");
  }
  const sqlite = new Database(sqlitePath, { readonly: true });
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  try {
    // Disable FK checks during bulk load order differences.
    await pg.query("SET session_replication_role = replica");
    for (const table of TABLES) {
      await copyTable(pg, sqlite, table);
    }
    await pg.query("SET session_replication_role = DEFAULT");
    console.log("[pg:migrate] Done.");
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error("[pg:migrate] error:", err?.message || err);
  process.exit(1);
});
