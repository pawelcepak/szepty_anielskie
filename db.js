import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

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

/** Wstępne godziny online (HH:MM, strefa serwera / lokalna przeglądarka przy wyświetlaniu) — orientacyjnie. */
const DEFAULT_TYPICAL_HOURS = {
  "tarot-klasyczny": ["10:00", "13:00"],
  "tarot-intuicyjny": ["11:00", "15:00"],
  "runy-skandynawskie": ["09:00", "12:00"],
  "horoskop-dzienny": ["10:00", "14:00"],
  synastria: ["14:00", "18:00"],
  numerologia: ["08:00", "11:00"],
  pendulum: ["12:00", "15:00"],
  fusy: ["16:00", "20:00"],
  anioly: ["10:00", "12:00"],
  "sny-znaczenie": ["20:00", "23:00"],
  "astrologia-karmiczna": ["09:30", "13:30"],
  "karty-cygańskie": ["13:00", "17:00"],
  "energia-aury": ["18:00", "22:00"],
};

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

/** Zdjęcia ilustracyjne (Unsplash) — na produkcję podmień na własne, z licencją. */
const CHARACTER_PORTRAITS = {
  "tarot-klasyczny":
    "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=400&h=500&fit=crop&q=80",
  "tarot-intuicyjny":
    "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=500&fit=crop&q=80",
  "runy-skandynawskie":
    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=500&fit=crop&q=80",
  "horoskop-dzienny":
    "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&h=500&fit=crop&q=80",
  "synastria":
    "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=500&fit=crop&q=80",
  numerologia:
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=500&fit=crop&q=80",
  pendulum:
    "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=400&h=500&fit=crop&q=80",
  fusy: "https://images.unsplash.com/photo-1589156280159-27698a70f29e?w=400&h=500&fit=crop&q=80",
  anioly:
    "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=500&fit=crop&q=80",
  "sny-znaczenie":
    "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=400&h=500&fit=crop&q=80",
  "astrologia-karmiczna":
    "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&h=500&fit=crop&q=80",
  "karty-cygańskie":
    "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=400&h=500&fit=crop&q=80",
  "energia-aury":
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=500&fit=crop&q=80",
};

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

const CHAR_ABOUT = {
  "tarot-klasyczny": {
    gender: "kobieta",
    skills:
      "Pracuję Riderem–Waite, układami na relacje i decyzje; zapraszam z konkretnym pytaniem — tak łatwiej Ci pomóc.",
    about:
      "Od lat układam karty klasycznie: łączę symbole talii z rozmową o tym, co naprawdę Cię ciąży. Szanuję Twoje tempo i delikatnie zarysowuję ramy czasu.",
  },
  "tarot-intuicyjny": {
    gender: "kobieta",
    skills:
      "Używam kart jak lustra — krótkie rozszerzenia, refleksja, coaching językiem obrazów z talii.",
    about:
      "Mniej „wróżenie z kart”, więcej wspólnego ułożenia sensu. Dobrze czuję tematy życiowe i momenty przejścia — jestem tu, żebyś wyszedł z rozmowy z lżejszą głową.",
  },
  "runy-skandynawskie": {
    gender: "mężczyzna",
    skills: "Futhark starszy, rzuty proste, pytania tak/nie i kierunkowe — wchodzę w temat szybko i jasno.",
    about:
      "Lubię krótkie, konkretne pytania i decyzje „dziś albo jutro”. Jeśli potrzebujesz prostego sygnału z run, napisz — ułożę rzut i wytłumaczę go po ludzku.",
  },
  "horoskop-dzienny": {
    gender: "kobieta",
    skills: "Mapa urodzeniowa, Słońce, Księżyc, ascendent i przebieg tygodnia — tłumaczę to przystępnie.",
    about:
      "Pomagam zobaczyć Twój tydzień i siebie w kontekście gwiazd, bez żargonu dla „wtajemniczonych”. Jeśli chcesz złapać rytm dni, zapraszam na rozmowę.",
  },
  synastria: {
    gender: "mężczyzna",
    skills: "Porównuję dwie mapy — dynamika pary, napięcia i miejsca na wsparcie.",
    about:
      "Patrzę na związek przez pryzmat astrologii: co się klei, co wymaga pracy. Potrzebuję dokładnych dat urodzenia obu osób — wtedy mogę wejść w temat uczciwie i konkretnie.",
  },
  numerologia: {
    gender: "kobieta",
    skills: "Liczba drogi życia, pętle, imię i data — szukam w liczbach tego, co pasuje do Twojej historii.",
    about:
      "Łączę cyfry z etapem życia i wyborem zawodowym lub relacyjnym. Jeśli lubisz uporządkowane podpowiedzi z nutą intuicji, zajrzymy razem w Twój profil liczb.",
  },
  pendulum: {
    gender: "kobieta",
    skills: "Wahadło, wybór z kilku opcji, proste pytania decyzyjne — krótko i na temat.",
    about:
      "Najlepiej sprawdzam się, gdy masz 2–4 nazwane ścieżki i chcesz lekkiego „kierunku”. Napisz dylemat — przejdziemy przez niego w spokojnym tempie.",
  },
  fusy: {
    gender: "kobieta",
    skills: "Fusy w kubku po zaparzeniu — tradycyjne skojarzenia i ciepły, domowy ton.",
    about:
      "Zapraszam do krótkiej historii za pytaniem: fusy lubią kontekst. Pracuję spokojnie, bez pośpiechu — idealnie, jeśli szukasz klimatu „przy stole w kuchni”.",
  },
  anioly: {
    gender: "kobieta",
    skills: "Karty anielskie, łagodny komunikat i ton wsparcia — bez straszenia.",
    about:
      "Stawiam na pocieszenie i perspektywę. Jeśli czujesz stres albo niepewność co do przyszłości, mogę pomóc złapać oddech i zobaczyć rzeczy łagodniej.",
  },
  "sny-znaczenie": {
    gender: "kobieta",
    skills: "Symbolika snów, powtarzalne motywy, emocje ukryte pod obrazem snu.",
    about:
      "Pomagam rozkodować sny, które wracają noc po nocy. Łączę symbole z Twoją codziennością i podpowiadam, co może wołać o uwagę.",
  },
  "astrologia-karmiczna": {
    gender: "mężczyzna",
    skills: "Węzły księżycowe, lekcje karmiczne, cykle przełomów życiowych.",
    about:
      "Patrzę szerzej niż horoskop dnia. Jeśli czujesz, że powtarzasz te same scenariusze, przeanalizujemy je przez karmiczne osie mapy.",
  },
  "karty-cygańskie": {
    gender: "kobieta",
    skills: "Tradycyjny rozkład kart cygańskich, pytania relacyjne i domowe.",
    about:
      "Pracuję klasycznie i spokojnie. Dobrze prowadzę tematy sercowe oraz rodzinne, gdzie potrzeba ciepłego, ale konkretnego spojrzenia.",
  },
  "energia-aury": {
    gender: "kobieta",
    skills: "Czytanie energii aury, oczyszczanie intencji i kierunek na najbliższy czas.",
    about:
      "Skupiam się na tym, co wzmacnia, a co osłabia Twoją energię. Rozmowa jest łagodna, ale praktyczna: dostajesz jasne kroki na dziś.",
  },
};

const updCharMeta = db.prepare(
  `UPDATE characters SET gender = ?, skills = ?, about = ? WHERE id = ?`
);
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
  const rows = [
    ["tarot-klasyczny", "Anna W. — tarot klasyczny", "Rider–Waite, układy na relacje i decyzje", "Tarot", 10],
    ["tarot-intuicyjny", "Maja K. — tarot intuicyjny", "Karty jako punkt wyjścia do rozmowy", "Tarot", 20],
    ["runy-skandynawskie", "Erik L. — runy", "Futhark, pytania proste / tak–nie", "Runy", 30],
    ["horoskop-dzienny", "Dorota S. — horoskop osobisty", "Słońce, ascendent, przebiegi tygodnia", "Astrologia", 40],
    ["synastria", "Piotr M. — analiza pary", "Porównanie map: dynamika związku", "Astrologia", 50],
    ["numerologia", "Iza N. — numerologia imienia i daty", "Liczbę drogi życia, cykle roczne", "Numerologia", 60],
    ["pendulum", "Karolina P. — wahadło", "Krótkie pytania, wybór z kilku opcji", "Inne techniki", 70],
    ["fusy", "Bożena T. — wróżba z fusów", "Symbolika kubka, domowy klimat", "Tradycyjne", 80],
    ["anioly", "Magdalena R. — karty anielskie", "Komunikat łagodny, wspierający", "Karty", 90],
    ["sny-znaczenie", "Nina Ś. — znaczenie snów", "Sny, symbole i intuicyjne odczyty", "Sny", 100],
    ["astrologia-karmiczna", "Oskar V. — astrologia karmiczna", "Węzły karmiczne i cykle życia", "Astrologia", 110],
    ["karty-cygańskie", "Ewa C. — karty cygańskie", "Tradycyjne rozkłady relacyjne", "Karty", 120],
    ["energia-aury", "Lena A. — odczyt aury", "Energia, blokady i kierunek", "Energetyka", 130],
  ];
  db.transaction(() => {
    for (const r of rows) {
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
const EXTRA_OR_BASE_ROWS = [
  ["tarot-klasyczny", "Anna W. — tarot klasyczny", "Rider–Waite, układy na relacje i decyzje", "Tarot", 10],
  ["tarot-intuicyjny", "Maja K. — tarot intuicyjny", "Karty jako punkt wyjścia do rozmowy", "Tarot", 20],
  ["runy-skandynawskie", "Erik L. — runy", "Futhark, pytania proste / tak–nie", "Runy", 30],
  ["horoskop-dzienny", "Dorota S. — horoskop osobisty", "Słońce, ascendent, przebiegi tygodnia", "Astrologia", 40],
  ["synastria", "Piotr M. — analiza pary", "Porównanie map: dynamika związku", "Astrologia", 50],
  ["numerologia", "Iza N. — numerologia imienia i daty", "Liczbę drogi życia, cykle roczne", "Numerologia", 60],
  ["pendulum", "Karolina P. — wahadło", "Krótkie pytania, wybór z kilku opcji", "Inne techniki", 70],
  ["fusy", "Bożena T. — wróżba z fusów", "Symbolika kubka, domowy klimat", "Tradycyjne", 80],
  ["anioly", "Magdalena R. — karty anielskie", "Komunikat łagodny, wspierający", "Karty", 90],
  ["sny-znaczenie", "Nina Ś. — znaczenie snów", "Sny, symbole i intuicyjne odczyty", "Sny", 100],
  ["astrologia-karmiczna", "Oskar V. — astrologia karmiczna", "Węzły karmiczne i cykle życia", "Astrologia", 110],
  ["karty-cygańskie", "Ewa C. — karty cygańskie", "Tradycyjne rozkłady relacyjne", "Karty", 120],
  ["energia-aury", "Lena A. — odczyt aury", "Energia, blokady i kierunek", "Energetyka", 130],
];
db.transaction(() => {
  for (const r of EXTRA_OR_BASE_ROWS) {
    const url = CHARACTER_PORTRAITS[r[0]] || null;
    const m = CHAR_ABOUT[r[0]] || { gender: "", skills: "", about: "" };
    const hp = DEFAULT_TYPICAL_HOURS[r[0]] || [null, null];
    ensureCharRow.run(...r, url, m.gender, m.skills, m.about, hp[0], hp[1]);
  }
})();

export function getDb() {
  return db;
}

/** Pierwsze konto operatorskie z .env (tylko gdy brak operatorów). */
export function ensureBootstrapOperator() {
  const n = db.prepare("SELECT COUNT(*) AS c FROM operators").get().c;
  if (n > 0) return;
  const email = String(process.env.OPERATOR_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const pass = String(process.env.OPERATOR_BOOTSTRAP_PASSWORD || "");
  const name = String(process.env.OPERATOR_BOOTSTRAP_NAME || "Operator").trim() || "Operator";
  if (!email || !pass || pass.length < 8) {
    console.warn(
      "[db] Brak operatorów: ustaw OPERATOR_BOOTSTRAP_EMAIL i OPERATOR_BOOTSTRAP_PASSWORD (min. 8 znaków) w .env"
    );
    return;
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(pass, 12);
  db.prepare(
    `INSERT INTO operators (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'owner')`
  ).run(id, email, hash, name);
  console.log(`[db] Utworzono konto operatorskie: ${email}`);
}
