import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { CHARACTER_PORTRAITS, CHAR_ABOUT, DEFAULT_TYPICAL_HOURS, EXTRA_OR_BASE_ROWS } from "./character-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "portal.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function needsFullReset() {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  if (!tables.includes("users")) return false;
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const names = new Set(cols.map((c) => c.name));
  return !names.has("email");
}

if (needsFullReset()) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS ledger;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS threads;
    DROP TABLE IF EXISTS customer_sessions;
    DROP TABLE IF EXISTS operator_sessions;
    DROP TABLE IF EXISTS operators;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS characters;
    PRAGMA foreign_keys = ON;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','staff')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customer_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operator_sessions (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_operator_sessions_token ON operator_sessions(token);

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    portrait_url TEXT
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    internal_notes TEXT,
    assigned_operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL,
    response_due_at TEXT,
    last_staff_activity_at TEXT,
    reclaim_operator_id TEXT,
    reclaim_until TEXT,
    UNIQUE(user_id, character_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK(sender IN ('user','staff')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS thread_facts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('client','consultant')),
    category TEXT NOT NULL,
    field TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 0,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(thread_id, scope, category, field, slot)
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const threadColNames = new Set(
  db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name)
);
if (!threadColNames.has("internal_notes")) {
  db.exec("ALTER TABLE threads ADD COLUMN internal_notes TEXT");
}
const opCols = new Set(db.prepare("PRAGMA table_info(operators)").all().map((c) => c.name));
if (!opCols.has("role")) {
  db.exec("ALTER TABLE operators ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'");
}
if (!opCols.has("disabled_at")) {
  db.exec("ALTER TABLE operators ADD COLUMN disabled_at TEXT");
}
for (const [col, sqlt] of [
  ["payout_first_name", "TEXT"],
  ["payout_last_name", "TEXT"],
  ["payout_address_line", "TEXT"],
  ["payout_city", "TEXT"],
  ["payout_postal_code", "TEXT"],
  ["payout_country", "TEXT"],
  ["payout_iban", "TEXT"],
  ["payout_frequency", "TEXT"],
  ["kyc_status", "TEXT"],
  ["kyc_provider_ref", "TEXT"],
  ["kyc_updated_at", "TEXT"],
]) {
  if (!opCols.has(col)) {
    db.exec(`ALTER TABLE operators ADD COLUMN ${col} ${sqlt}`);
  }
}

const t3 = new Set(db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name));
if (!t3.has("client_hidden_at")) {
  db.exec("ALTER TABLE threads ADD COLUMN client_hidden_at TEXT");
}
const bootEmail = String(process.env.OPERATOR_BOOTSTRAP_EMAIL || "")
  .trim()
  .toLowerCase();
if (bootEmail) {
  db.prepare("UPDATE operators SET role = 'owner' WHERE lower(email) = ?").run(bootEmail);
}
const ownerCount = db.prepare("SELECT COUNT(*) AS c FROM operators WHERE role = 'owner'").get().c;
if (ownerCount === 0) {
  const one = db.prepare("SELECT id FROM operators ORDER BY datetime(created_at) LIMIT 1").get();
  if (one) db.prepare("UPDATE operators SET role = 'owner' WHERE id = ?").run(one.id);
}

const t2 = new Set(db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["assigned_operator_id", "TEXT"],
  ["response_due_at", "TEXT"],
  ["last_staff_activity_at", "TEXT"],
  ["reclaim_operator_id", "TEXT"],
  ["reclaim_until", "TEXT"],
  ["resume_operator_id", "TEXT"],
  ["resume_until", "TEXT"],
]) {
  if (!t2.has(col)) {
    db.exec(`ALTER TABLE threads ADD COLUMN ${col} ${sqlt}`);
  }
}

const msgCols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
if (!msgCols.has("operator_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL");
}

const factCols = new Set(db.prepare("PRAGMA table_info(thread_facts)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["created_operator_id", "TEXT"],
  ["updated_operator_id", "TEXT"],
]) {
  if (!factCols.has(col)) {
    db.exec(`ALTER TABLE thread_facts ADD COLUMN ${col} ${sqlt}`);
  }
}

const factColsAfter = new Set(db.prepare("PRAGMA table_info(thread_facts)").all().map((c) => c.name));
if (!factColsAfter.has("slot")) {
  db.exec(`
    CREATE TABLE thread_facts_mig (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('client','consultant')),
      category TEXT NOT NULL,
      field TEXT NOT NULL,
      slot INTEGER NOT NULL DEFAULT 0,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_operator_id TEXT,
      updated_operator_id TEXT,
      UNIQUE(thread_id, scope, category, field, slot)
    );
    INSERT INTO thread_facts_mig (id, thread_id, scope, category, field, slot, value, updated_at, created_operator_id, updated_operator_id)
      SELECT id, thread_id, scope, category, field, 0, value, updated_at, created_operator_id, updated_operator_id FROM thread_facts;
    DROP TABLE thread_facts;
    ALTER TABLE thread_facts_mig RENAME TO thread_facts;
  `);
}

const userCols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["username", "TEXT"],
  ["first_name", "TEXT"],
  ["birth_date", "TEXT"],
  ["avatar_url", "TEXT"],
]) {
  if (!userCols.has(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${sqlt}`);
  }
}
if (userCols.has("display_name")) {
  db.prepare(`UPDATE users SET first_name = display_name WHERE first_name IS NULL OR trim(first_name) = ''`).run();
  db.prepare(
    `UPDATE users SET username = lower(replace(substr(id,1,8) || substr(id,10,4), '-', '')) WHERE username IS NULL OR trim(username) = ''`
  ).run();
  const dup = db
    .prepare(
      `SELECT username FROM users GROUP BY username HAVING count(*) > 1`
    )
    .all();
  for (const { username } of dup) {
    const rows = db.prepare(`SELECT id FROM users WHERE username = ?`).all(username);
    for (let i = 1; i < rows.length; i++) {
      const nid = `${username}_${i}`;
      db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(nid, rows[i].id);
    }
  }
}

const userCols2 = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
if (!userCols2.has("city")) {
  db.exec("ALTER TABLE users ADD COLUMN city TEXT");
}
if (!userCols2.has("blocked_at")) {
  db.exec("ALTER TABLE users ADD COLUMN blocked_at TEXT");
}

const userCols3 = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["email_verified_at", "TEXT"],
  ["email_verification_token", "TEXT"],
  ["email_verification_expires_at", "TEXT"],
  ["pending_open_character_id", "TEXT"],
  ["pending_email_change", "TEXT"],
]) {
  if (!userCols3.has(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${sqlt}`);
  }
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token) WHERE email_verification_token IS NOT NULL`
);
/** Istniejące konta (bez tokenu weryfikacji) uznajemy za zweryfikowane. */
db.prepare(
  `UPDATE users SET email_verified_at = datetime('now') WHERE email_verified_at IS NULL AND email_verification_token IS NULL`
).run();

/** Jednorazowa migracja starych kluczy notatek klienta → nowe kategorie. */
if (!db.prepare("SELECT 1 FROM app_kv WHERE key = ?").get("facts_schema_v2_migrated")) {
  const stmts = [
    `UPDATE thread_facts SET category = 'dane_osobowe', field = 'imie' WHERE scope = 'client' AND category = 'personal_info' AND field = 'name'`,
    `UPDATE thread_facts SET category = 'dane_osobowe', field = 'miasto' WHERE scope = 'client' AND category = 'personal_info' AND field = 'city'`,
    `UPDATE thread_facts SET category = 'dane_osobowe', field = 'wiek' WHERE scope = 'client' AND category = 'personal_info' AND field = 'age'`,
    `UPDATE thread_facts SET category = 'rodzina', field = 'notatka' WHERE scope = 'client' AND category = 'personal_info' AND field = 'family'`,
    `UPDATE thread_facts SET category = 'zainteresowania', field = 'sport' WHERE scope = 'client' AND category = 'hobby' AND field = 'sport'`,
    `UPDATE thread_facts SET category = 'zainteresowania', field = 'hobby' WHERE scope = 'client' AND category = 'hobby' AND field = 'other'`,
    `UPDATE thread_facts SET category = 'dane_osobowe', field = 'zawod' WHERE scope = 'client' AND category = 'work' AND field = 'job'`,
    `UPDATE thread_facts SET category = 'dane_osobowe', field = 'firma' WHERE scope = 'client' AND category = 'work' AND field = 'employer'`,
    `UPDATE thread_facts SET category = 'inne', field = 'notatka' WHERE scope = 'client' AND category = 'other' AND field = 'notes'`,
  ];
  db.transaction(() => {
    for (const sql of stmts) db.exec(sql);
    db.prepare("INSERT OR REPLACE INTO app_kv (key, value) VALUES ('facts_schema_v2_migrated', '1')").run();
  })();
}

/** Zdrowie: pole rodzina → rodzina_klienta; zawód/firma z danych osobowych → Inne (notatka). */
if (!db.prepare("SELECT 1 FROM app_kv WHERE key = ?").get("facts_schema_v3_client_fields")) {
  const stmtsV3 = [
    `UPDATE thread_facts SET field = 'rodzina_klienta' WHERE scope = 'client' AND category = 'zdrowie' AND field = 'rodzina'`,
    `UPDATE thread_facts SET category = 'inne', field = 'notatka', value = '[Zawód] ' || COALESCE(value, '') WHERE scope = 'client' AND category = 'dane_osobowe' AND field = 'zawod'`,
    `UPDATE thread_facts SET category = 'inne', field = 'notatka', value = '[Firma] ' || COALESCE(value, '') WHERE scope = 'client' AND category = 'dane_osobowe' AND field = 'firma'`,
  ];
  db.transaction(() => {
    for (const sql of stmtsV3) db.exec(sql);
    db.prepare("INSERT OR REPLACE INTO app_kv (key, value) VALUES ('facts_schema_v3_client_fields', '1')").run();
  })();
}

const charCols2 = new Set(db.prepare("PRAGMA table_info(characters)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["gender", "TEXT"],
  ["skills", "TEXT"],
  ["about", "TEXT"],
]) {
  if (!charCols2.has(col)) {
    db.exec(`ALTER TABLE characters ADD COLUMN ${col} ${sqlt}`);
  }
}

const charColsHours = new Set(db.prepare("PRAGMA table_info(characters)").all().map((c) => c.name));
for (const [col, sqlt] of [
  ["typical_hours_from", "TEXT"],
  ["typical_hours_to", "TEXT"],
]) {
  if (!charColsHours.has(col)) {
    db.exec(`ALTER TABLE characters ADD COLUMN ${col} ${sqlt}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS operator_payout_ledger (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    amount_pln REAL NOT NULL,
    label TEXT NOT NULL,
    period_label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payout_ledger_op ON operator_payout_ledger(operator_id);

  CREATE TABLE IF NOT EXISTS operator_audit (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    thread_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_reports (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    reporter_operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
    owner_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by_operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status);
  CREATE INDEX IF NOT EXISTS idx_message_reports_thread ON message_reports(thread_id);
  CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports(message_id);
`);

db.prepare("INSERT OR IGNORE INTO app_kv (key, value) VALUES ('assign_rr', '0')").run();

const charColNames = new Set(
  db.prepare("PRAGMA table_info(characters)").all().map((c) => c.name)
);
if (!charColNames.has("portrait_url")) {
  db.exec("ALTER TABLE characters ADD COLUMN portrait_url TEXT");
}

const updPortrait = db.prepare("UPDATE characters SET portrait_url = ? WHERE id = ?");
db.transaction(() => {
  for (const [id, url] of Object.entries(CHARACTER_PORTRAITS)) {
    updPortrait.run(url, id);
  }
})();

const updCharMeta = db.prepare(
  `UPDATE characters SET gender = ?, skills = ?, about = ? WHERE id = ?`
);
const updCharCore = db.prepare(
  `UPDATE characters SET name = ?, tagline = ?, category = ?, sort_order = ? WHERE id = ?`
);
db.transaction(() => {
  for (const r of EXTRA_OR_BASE_ROWS) {
    updCharCore.run(r[1], r[2], r[3], r[4], r[0]);
  }
})();
db.transaction(() => {
  for (const [id, m] of Object.entries(CHAR_ABOUT)) {
    updCharMeta.run(m.gender, m.skills, m.about, id);
  }
})();

const updTypicalHoursIfEmpty = db.prepare(
  `UPDATE characters SET typical_hours_from = ?, typical_hours_to = ? WHERE id = ? AND (typical_hours_from IS NULL OR typical_hours_to IS NULL)`
);
db.transaction(() => {
  for (const [id, pair] of Object.entries(DEFAULT_TYPICAL_HOURS)) {
    const [fr, to] = pair;
    updTypicalHoursIfEmpty.run(fr, to, id);
  }
})();

const countChars = db.prepare("SELECT COUNT(*) AS c FROM characters");
if (countChars.get().c === 0) {
  const ins = db.prepare(
    `INSERT INTO characters (id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of EXTRA_OR_BASE_ROWS) {
      const url = CHARACTER_PORTRAITS[r[0]] || null;
      const m = CHAR_ABOUT[r[0]] || { gender: "", skills: "", about: "" };
      const hp = DEFAULT_TYPICAL_HOURS[r[0]] || [null, null];
      ins.run(...r, url, m.gender, m.skills, m.about, hp[0], hp[1]);
    }
  })();
}

const ensureCharRow = db.prepare(
  `INSERT OR IGNORE INTO characters (id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
db.transaction(() => {
  for (const r of EXTRA_OR_BASE_ROWS) {
    const url = CHARACTER_PORTRAITS[r[0]] || null;
    const m = CHAR_ABOUT[r[0]] || { gender: "", skills: "", about: "" };
    const hp = DEFAULT_TYPICAL_HOURS[r[0]] || [null, null];
    ensureCharRow.run(...r, url, m.gender, m.skills, m.about, hp[0], hp[1]);
  }
})();

export function createSqliteDatabase() {
  return db;
}
