import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { createSqliteDatabase } from "./sqlite-db.js";
import { createPgDatabase } from "./lib/pg-database.js";

function wrapSqliteAsync(syncDb) {
  return {
    prepare(sql) {
      const stmt = syncDb.prepare(sql);
      return {
        run(...args) {
          return Promise.resolve(stmt.run(...args));
        },
        get(...args) {
          return Promise.resolve(stmt.get(...args));
        },
        all(...args) {
          return Promise.resolve(stmt.all(...args));
        },
      };
    },
    async transaction(fn) {
      syncDb.prepare("BEGIN").run();
      try {
        await fn(wrapSqliteAsync(syncDb));
        syncDb.prepare("COMMIT").run();
      } catch (e) {
        syncDb.prepare("ROLLBACK").run();
        throw e;
      }
    },
  };
}

/**
 * Inicjalizacja bazy: PostgreSQL przy DATABASE_URL, w przeciwnym razie SQLite (dev).
 * Jednolite async API: await db.prepare(...).run/get/all, await db.transaction(async (tx) => ...).
 */
export async function initDatabase() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (url) {
    return createPgDatabase(url);
  }
  return wrapSqliteAsync(createSqliteDatabase());
}

/** Konto operatorskie bootstrap z .env (tworzy lub synchronizuje dane logowania). */
export async function ensureBootstrapOperator(db) {
  const email = String(process.env.OPERATOR_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const pass = String(process.env.OPERATOR_BOOTSTRAP_PASSWORD || "");
  const name = String(process.env.OPERATOR_BOOTSTRAP_NAME || "Operator").trim() || "Operator";
  if (!email || !pass || pass.length < 8) {
    console.warn(
      "[db] Brak operatorów: ustaw OPERATOR_BOOTSTRAP_EMAIL i OPERATOR_BOOTSTRAP_PASSWORD (min. 8 znaków) w .env"
    );
    return;
  }
  const hash = bcrypt.hashSync(pass, 12);
  const existing = await db.prepare("SELECT id FROM operators WHERE lower(email) = lower(?)").get(email);
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE operators
         SET password_hash = ?, display_name = ?, role = 'owner', disabled_at = NULL
         WHERE id = ?`
      )
      .run(hash, name, existing.id);
    console.log(`[db] Zsynchronizowano konto operatorskie: ${email}`);
    return;
  }
  const id = uuidv4();
  await db
    .prepare(
      `INSERT INTO operators (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'owner')`
    )
    .run(id, email, hash, name);
  console.log(`[db] Utworzono konto operatorskie: ${email}`);
}
