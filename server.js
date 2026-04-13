import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { getDb, ensureBootstrapOperator } from "./db.js";
import { flattenSchemaForApi, isValidFactKey, FACT_VALUE_MAX_LEN } from "./facts-schema.js";
import { maskClientNumbersForOperator } from "./masking.js";
import {
  findBannedStaffReplySubstring,
  getStaffBannedSubstrings,
} from "./staff-reply-rules.js";
import {
  assertStaffCanMutate,
  bumpStaffActivity,
  ensureReplyPermission,
  getAssignmentPayload,
  getOperatorMonitorSnapshot,
  getOperatorStats,
  getStaffDashboard,
  getStaffQueueSlots,
  inboxBucketClause,
  onClientMessage,
  onStaffReply,
  OWNER_REPLY_MAX_CHARS,
  OWNER_REPLY_MIN_CHARS,
  STAFF_REPLY_MAX_CHARS,
  STAFF_REPLY_MIN_CHARS,
  sweepAssignments,
  threadVisibleToOperator,
  tryClaimStoppedThread,
  tryClaimThread,
} from "./assignment.js";
import { APP_CONFIG } from "./app-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = getDb();

const PORT = Number(process.env.PORT) || 3000;
const ALLOW_FAKE_PURCHASE =
  String(process.env.ALLOW_FAKE_PURCHASE || "true").toLowerCase() === "true";

const COOKIE_CUSTOMER = "customer_session";
const COOKIE_OPERATOR = "operator_session";
const PKG_AMOUNTS = new Set(APP_CONFIG.pricing.clientPackages.map((pkg) => Number(pkg.amount)));
const CUSTOMER_SESSION_IDLE_MINUTES = Math.min(
  24 * 60,
  Math.max(1, Number(process.env.CUSTOMER_SESSION_IDLE_MINUTES || 10))
);
const CUSTOMER_SESSION_IDLE_MS = CUSTOMER_SESSION_IDLE_MINUTES * 60 * 1000;

function defaultClientPkgPln(amount) {
  const pkg = APP_CONFIG.pricing.clientPackages.find((item) => Number(item.amount) === Number(amount));
  return pkg ? Number(pkg.price_pln) : 0;
}

function pricingPackagesForClient() {
  return APP_CONFIG.pricing.clientPackages.map((pkg) => {
    const amount = Number(pkg.amount);
    const envKey = `CLIENT_PKG_${amount}_PLN`;
    const raw = process.env[envKey];
    const fromConfig = Number(pkg.price_pln);
    const price_pln = raw != null && String(raw).trim() !== "" ? Number(raw) : fromConfig;
    const n = Number(price_pln);
    return { amount, price_pln: Number.isFinite(n) ? Math.round(n * 100) / 100 : defaultClientPkgPln(amount) };
  });
}

const app = express();
if (["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase())) {
  app.set("trust proxy", 1);
}
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "512kb" }));
app.use(cookieParser());
const registerJsonParser = express.json({ limit: "1mb" });

function tokenBytes() {
  return crypto.randomBytes(32).toString("hex");
}

function sessionExpires(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function cookieSecureFlag() {
  return ["1", "true", "yes"].includes(String(process.env.COOKIE_SECURE || "").toLowerCase());
}

function sessionCookieClearOpts() {
  const o = { path: "/" };
  if (cookieSecureFlag()) o.secure = true;
  return o;
}

function customerCookieOpts() {
  const o = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: CUSTOMER_SESSION_IDLE_MS,
  };
  if (cookieSecureFlag()) o.secure = true;
  return o;
}

function operatorCookieOpts() {
  const o = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 14 * 24 * 60 * 60 * 1000,
  };
  if (cookieSecureFlag()) o.secure = true;
  return o;
}

function customerSessionExpiresAt() {
  return new Date(Date.now() + CUSTOMER_SESSION_IDLE_MS).toISOString();
}

function extendCustomerSession(res, sessionId, token) {
  const exp = customerSessionExpiresAt();
  db.prepare(`UPDATE customer_sessions SET expires_at = ? WHERE id = ?`).run(exp, sessionId);
  res.cookie(COOKIE_CUSTOMER, token, customerCookieOpts());
}

function messagesBalance(userId) {
  const r = db.prepare("SELECT COALESCE(SUM(delta), 0) AS bal FROM ledger WHERE user_id = ?").get(
    userId
  );
  return r.bal;
}

function requireCustomer(req, res, next) {
  const token = req.cookies[COOKIE_CUSTOMER];
  if (!token) {
    return res.status(401).json({ error: "Zaloguj się, aby kontynuować." });
  }
  const row = db
    .prepare(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.username, u.first_name, u.birth_date, u.city, u.avatar_url
       FROM customer_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(token);
  if (!row) {
    res.clearCookie(COOKIE_CUSTOMER, sessionCookieClearOpts());
    return res.status(401).json({
      error: `Sesja wygasła po ${CUSTOMER_SESSION_IDLE_MINUTES} min bezczynności. Zaloguj się ponownie.`,
    });
  }
  extendCustomerSession(res, row.session_id, token);
  req.customer = {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    username: row.username,
    first_name: row.first_name,
    birth_date: row.birth_date,
    city: row.city || "",
    avatar_url: row.avatar_url,
  };
  next();
}

function requireOperator(req, res, next) {
  const token = req.cookies[COOKIE_OPERATOR];
  if (!token) {
    return res.status(401).json({ error: "Zaloguj się do panelu pracy." });
  }
  const row = db
    .prepare(
      `SELECT o.id, o.email, o.display_name, COALESCE(o.role, 'staff') AS role
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
         AND o.disabled_at IS NULL`
    )
    .get(token);
  if (!row) {
    res.clearCookie(COOKIE_OPERATOR, sessionCookieClearOpts());
    return res.status(401).json({ error: "Sesja wygasła." });
  }
  req.operator = row;
  next();
}

function setCustomerSession(res, userId) {
  const token = tokenBytes();
  const id = uuidv4();
  const exp = customerSessionExpiresAt();
  db.prepare(
    `INSERT INTO customer_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, userId, token, exp);
  res.cookie(COOKIE_CUSTOMER, token, customerCookieOpts());
  return token;
}

function clearCustomerSession(req, res) {
  const token = req.cookies[COOKIE_CUSTOMER];
  if (token) db.prepare("DELETE FROM customer_sessions WHERE token = ?").run(token);
  res.clearCookie(COOKIE_CUSTOMER, sessionCookieClearOpts());
}

function setOperatorSession(res, operatorId) {
  const token = tokenBytes();
  const id = uuidv4();
  const exp = sessionExpires(14);
  db.prepare(
    `INSERT INTO operator_sessions (id, operator_id, token, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, operatorId, token, exp);
  res.cookie(COOKIE_OPERATOR, token, operatorCookieOpts());
}

function clearOperatorSession(req, res) {
  const token = req.cookies[COOKIE_OPERATOR];
  if (token) db.prepare("DELETE FROM operator_sessions WHERE token = ?").run(token);
  res.clearCookie(COOKIE_OPERATOR, sessionCookieClearOpts());
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const usernameOk = (u) => /^[a-z0-9_]{3,24}$/.test(u);

function parseBirthDate(s) {
  const t = String(s || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const d = new Date(y, mo - 1, da, 12, 0, 0, 0);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

/** Ukończone 18 pełnych lat wg kalendarza względem bieżącej daty serwera (strefa lokalna). */
function birthDateAllowed(d) {
  const now = new Date();
  const y18 = now.getFullYear() - 18;
  const m = now.getMonth();
  const day = now.getDate();
  const cutoff18 = new Date(y18, m, day, 12, 0, 0, 0);
  if (d.getTime() > cutoff18.getTime()) return false;
  const y120 = now.getFullYear() - 120;
  const oldest = new Date(y120, m, day, 12, 0, 0, 0);
  if (d.getTime() < oldest.getTime()) return false;
  return true;
}

/** --- Klient: rejestracja / logowanie --- */

app.get("/api/auth/status", (req, res) => {
  const token = req.cookies[COOKIE_CUSTOMER];
  if (!token) return res.json({ logged_in: false });
  const row = db
    .prepare(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.username, u.first_name, u.city
       FROM customer_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(token);
  if (!row) {
    res.clearCookie(COOKIE_CUSTOMER, sessionCookieClearOpts());
    return res.json({ logged_in: false });
  }
  extendCustomerSession(res, row.session_id, token);
  res.json({
    logged_in: true,
    session_idle_minutes: CUSTOMER_SESSION_IDLE_MINUTES,
    user: {
      id: row.id,
      email: row.email,
      display_name: row.display_name || row.first_name,
      username: row.username,
      first_name: row.first_name,
      city: row.city || "",
    },
  });
});

app.post("/api/auth/register", registerJsonParser, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const username = String(req.body?.username || "").trim().toLowerCase();
  const first_name = String(req.body?.first_name || "").trim();
  const birth_date = String(req.body?.birth_date || "").trim();
  const city = String(req.body?.city || "").trim();
  const avatar_url = String(req.body?.avatar_url || "").trim() || null;
  if (!emailOk(email)) return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  if (password.length < 8) {
    return res.status(400).json({ error: "Hasło musi mieć co najmniej 8 znaków." });
  }
  if (!usernameOk(username)) {
    return res.status(400).json({
      error: "Nazwa użytkownika: 3–24 znaki, litery, cyfry i podkreślenie (_).",
    });
  }
  if (first_name.length < 2 || first_name.length > 60) {
    return res.status(400).json({ error: "Imię: 2–60 znaków." });
  }
  if (city.length < 2 || city.length > 80) {
    return res.status(400).json({ error: "Miasto: 2–80 znaków (wymagane)." });
  }
  const bd = parseBirthDate(birth_date);
  if (!bd) return res.status(400).json({ error: "Data urodzenia: format RRRR-MM-DD." });
  if (!birthDateAllowed(bd)) {
    return res.status(400).json({
      error: "Musisz mieć ukończone 18 lat — liczone od dzisiejszej daty i daty urodzenia (wymagane pełne 18 lat).",
    });
  }
  if (avatar_url) {
    if (avatar_url.startsWith("data:image/")) {
      if (avatar_url.length > 450000) {
        return res.status(400).json({ error: "Zdjęcie profilowe jest za duże (max ok. 400 KB po zakodowaniu)." });
      }
    } else if (avatar_url.length > 2000) {
      return res.status(400).json({ error: "Nieprawidłowy adres zdjęcia." });
    }
  }
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Ten adres e-mail jest już zarejestrowany." });
  if (db.prepare("SELECT id FROM users WHERE lower(username) = lower(?)").get(username)) {
    return res.status(409).json({ error: "Ta nazwa użytkownika jest już zajęta." });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  const display_name = first_name;
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, username, first_name, birth_date, city, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, email, hash, display_name, username, first_name, birth_date, city, avatar_url);
  setCustomerSession(res, id);
  res.status(201).json({
    user: {
      id,
      email,
      display_name,
      username,
      first_name,
      birth_date,
      city,
      avatar_url,
    },
    messages_remaining: messagesBalance(id),
    fake_purchase_enabled: ALLOW_FAKE_PURCHASE,
    packages_pln: pricingPackagesForClient(),
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const row = db
    .prepare(
      `SELECT id, email, display_name, password_hash, username, first_name, birth_date, city, avatar_url
       FROM users WHERE email = ?`
    )
    .get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Nieprawidłowy e-mail lub hasło." });
  }
  setCustomerSession(res, row.id);
  res.json({
    user: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      username: row.username,
      first_name: row.first_name,
      birth_date: row.birth_date,
      city: row.city || "",
      avatar_url: row.avatar_url,
    },
    messages_remaining: messagesBalance(row.id),
    fake_purchase_enabled: ALLOW_FAKE_PURCHASE,
    packages_pln: pricingPackagesForClient(),
  });
});

app.post("/api/auth/logout", (req, res) => {
  clearCustomerSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", requireCustomer, (req, res) => {
  res.json({
    user: {
      id: req.customer.id,
      email: req.customer.email,
      display_name: req.customer.display_name,
      username: req.customer.username,
      first_name: req.customer.first_name,
      birth_date: req.customer.birth_date,
      city: req.customer.city || "",
      avatar_url: req.customer.avatar_url,
    },
    messages_remaining: messagesBalance(req.customer.id),
    fake_purchase_enabled: ALLOW_FAKE_PURCHASE,
    packages_pln: pricingPackagesForClient(),
    session_idle_minutes: CUSTOMER_SESSION_IDLE_MINUTES,
  });
});

app.patch("/api/me", requireCustomer, (req, res) => {
  const city = String(req.body?.city ?? "").trim();
  if (city.length < 2 || city.length > 80) {
    return res.status(400).json({ error: "Miasto: 2–80 znaków." });
  }
  db.prepare(`UPDATE users SET city = ? WHERE id = ?`).run(city, req.customer.id);
  req.customer.city = city;
  res.json({
    user: {
      id: req.customer.id,
      email: req.customer.email,
      display_name: req.customer.display_name,
      username: req.customer.username,
      first_name: req.customer.first_name,
      birth_date: req.customer.birth_date,
      city,
      avatar_url: req.customer.avatar_url,
    },
  });
});

app.get("/api/public/pricing", (_req, res) => {
  res.json({ packages: pricingPackagesForClient(), currency: APP_CONFIG.pricing.currency });
});

app.get("/api/public/site-config", (_req, res) => {
  res.json({
    brandName: APP_CONFIG.brandName,
    domain: APP_CONFIG.domain,
    company: APP_CONFIG.company,
    pricing: {
      currency: APP_CONFIG.pricing.currency,
      paymentOperator: APP_CONFIG.pricing.paymentOperator,
      clientPackages: pricingPackagesForClient(),
    },
    legal: APP_CONFIG.legal,
    privacy: APP_CONFIG.privacy,
  });
});

app.post("/api/test/purchase", requireCustomer, (req, res) => {
  if (!ALLOW_FAKE_PURCHASE) {
    return res.status(403).json({ error: "Tryb testowego zakupu jest wyłączony." });
  }
  const amount = Number(req.body?.amount);
  if (!PKG_AMOUNTS.has(amount)) {
    return res.status(400).json({ error: "Dozwolone pakiety: 10, 20, 50 lub 100 wiadomości." });
  }
  const id = uuidv4();
  db.prepare(
    "INSERT INTO ledger (id, user_id, delta, reason) VALUES (?, ?, ?, ?)"
  ).run(id, req.customer.id, amount, `fake_purchase:${amount}`);
  res.json({
    ok: true,
    added: amount,
    messages_remaining: messagesBalance(req.customer.id),
  });
});

app.get("/api/characters", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, tagline, category, portrait_url, gender, skills, about,
              typical_hours_from, typical_hours_to
       FROM characters ORDER BY sort_order ASC, name ASC`
    )
    .all();
  res.json({ characters: rows });
});

app.get("/api/threads", requireCustomer, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.id AS thread_id, t.character_id, c.name AS character_name, c.category,
              datetime(t.created_at) AS thread_started_at,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.sender FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_sender,
              (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_at,
              t.client_hidden_at
       FROM threads t
       JOIN characters c ON c.id = t.character_id
       WHERE t.user_id = ?
       ORDER BY datetime(COALESCE(last_at, t.created_at)) DESC`
    )
    .all(req.customer.id);
  res.json({ threads: rows });
});

app.patch("/api/threads/:characterId/client-visibility", requireCustomer, (req, res) => {
  const characterId = req.params.characterId;
  const hidden = !!req.body?.hidden;
  const row = db
    .prepare(
      `SELECT t.id FROM threads t
       WHERE t.user_id = ? AND t.character_id = ?`
    )
    .get(req.customer.id, characterId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono rozmowy." });
  const ts = hidden ? new Date().toISOString() : null;
  db.prepare(`UPDATE threads SET client_hidden_at = ? WHERE id = ?`).run(ts, row.id);
  res.json({ ok: true, thread_id: row.id, client_hidden_at: ts });
});

function getOrCreateThread(userId, characterId) {
  const ch = db.prepare("SELECT id FROM characters WHERE id = ?").get(characterId);
  if (!ch) return null;
  let t = db
    .prepare("SELECT id FROM threads WHERE user_id = ? AND character_id = ?")
    .get(userId, characterId);
  if (!t) {
    const tid = uuidv4();
    db.prepare("INSERT INTO threads (id, user_id, character_id) VALUES (?, ?, ?)").run(
      tid,
      userId,
      characterId
    );
    t = { id: tid };
  }
  return t.id;
}

app.get("/api/threads/:characterId/messages", requireCustomer, (req, res) => {
  const characterId = req.params.characterId;
  const threadId = getOrCreateThread(req.customer.id, characterId);
  if (!threadId) return res.status(404).json({ error: "Nie znaleziono tej osoby w katalogu." });
  const msgs = db
    .prepare(
      `SELECT id, sender, body, created_at FROM messages WHERE thread_id = ? ORDER BY datetime(created_at) ASC`
    )
    .all(threadId);
  res.json({
    thread_id: threadId,
    character_id: characterId,
    messages: msgs,
    messages_remaining: messagesBalance(req.customer.id),
  });
});

app.post("/api/threads/:characterId/messages", requireCustomer, (req, res) => {
  const characterId = req.params.characterId;
  const body = String(req.body?.body || "").trim();
  if (body.length < 1 || body.length > 4000) {
    return res.status(400).json({ error: "Treść wiadomości: 1–4000 znaków." });
  }
  const bal = messagesBalance(req.customer.id);
  if (bal < 1) {
    return res.status(402).json({
      error: "Nie masz dostępnych wiadomości. Wybierz pakiet w panelu.",
      messages_remaining: bal,
    });
  }
  const threadId = getOrCreateThread(req.customer.id, characterId);
  if (!threadId) return res.status(404).json({ error: "Nie znaleziono tej osoby w katalogu." });

  const msgId = uuidv4();
  const ledId = uuidv4();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO messages (id, thread_id, sender, body) VALUES (?, ?, 'user', ?)"
    ).run(msgId, threadId, body);
    db.prepare(
      "INSERT INTO ledger (id, user_id, delta, reason) VALUES (?, ?, -1, ?)"
    ).run(ledId, req.customer.id, `user_message:${threadId}`);
  })();

  onClientMessage(db, threadId);

  res.json({
    ok: true,
    message: db.prepare("SELECT id, sender, body, created_at FROM messages WHERE id = ?").get(
      msgId
    ),
    messages_remaining: messagesBalance(req.customer.id),
  });
});

/** --- Operator: logowanie i praca na wątkach --- */

app.post("/api/op/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const row = db
    .prepare(
      `SELECT id, email, display_name, password_hash, COALESCE(role, 'staff') AS role, disabled_at
       FROM operators WHERE email = ?`
    )
    .get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Nieprawidłowy e-mail lub hasło." });
  }
  if (row.disabled_at) {
    return res.status(403).json({ error: "To konto zostało zablokowane. Skontaktuj się z administratorem." });
  }
  setOperatorSession(res, row.id);
  res.json({
    operator: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
    },
  });
});

app.post("/api/op/auth/logout", (req, res) => {
  clearOperatorSession(req, res);
  res.json({ ok: true });
});

app.get("/api/op/me", requireOperator, (req, res) => {
  const row = db
    .prepare(
      `SELECT id, email, display_name, role,
        payout_first_name, payout_last_name, payout_address_line, payout_city, payout_postal_code, payout_country,
        payout_iban, payout_frequency,
        COALESCE(kyc_status, 'unverified') AS kyc_status, kyc_provider_ref, kyc_updated_at
       FROM operators WHERE id = ?`
    )
    .get(req.operator.id);
  if (!row) {
    return res.status(401).json({ error: "Sesja nieważna — zaloguj się ponownie." });
  }
  const out = {
    operator: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
    },
  };
  if (row.role === "owner") {
    const openRep = db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get();
    out.open_message_reports = openRep?.c ?? 0;
  }
  if (row.role !== "owner") {
    out.reply_rules = {
      min_reply_chars: STAFF_REPLY_MIN_CHARS,
      banned_substrings: getStaffBannedSubstrings(),
      hint:
        "W odpowiedzi do klienta nie używaj słów sugerujących kontakt poza platformą ani „ujawnianie” pracy (np. telefon, e-mail, komunikatory). W notatkach wewnętrznych te ograniczenia nie obowiązują.",
    };
    out.payout = {
      first_name: row.payout_first_name || "",
      last_name: row.payout_last_name || "",
      address_line: row.payout_address_line || "",
      city: row.payout_city || "",
      postal_code: row.payout_postal_code || "",
      country: row.payout_country || "",
      iban: row.payout_iban || "",
      frequency: row.payout_frequency || "",
    };
    out.kyc = {
      status: row.kyc_status || "unverified",
      provider_ref: row.kyc_provider_ref || null,
      updated_at: row.kyc_updated_at || null,
    };
  }
  res.json(out);
});

app.patch("/api/op/me/payout", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({ error: "Ten formularz dotyczy tylko pracowników." });
  }
  const trim = (v, max) => String(v ?? "").trim().slice(0, max);
  const first_name = trim(req.body?.first_name, 80);
  const last_name = trim(req.body?.last_name, 80);
  const address_line = trim(req.body?.address_line, 200);
  const city = trim(req.body?.city, 80);
  const postal_code = trim(req.body?.postal_code, 20);
  const country = trim(req.body?.country, 80);
  const iban = trim(req.body?.iban, 42).replace(/\s+/g, " ");
  const frequency = String(req.body?.frequency || "").trim();
  const allowed = new Set(["weekly", "biweekly", "monthly", ""]);
  if (!allowed.has(frequency)) {
    return res.status(400).json({ error: "Częstotliwość wypłaty: weekly, biweekly, monthly lub pusto." });
  }
  db.prepare(
    `UPDATE operators SET
      payout_first_name = ?, payout_last_name = ?, payout_address_line = ?, payout_city = ?,
      payout_postal_code = ?, payout_country = ?, payout_iban = ?, payout_frequency = ?
     WHERE id = ?`
  ).run(first_name, last_name, address_line, city, postal_code, country, iban, frequency || null, req.operator.id);
  res.json({ ok: true });
});

app.get("/api/op/console/meta", requireOperator, requireOwner, (_req, res) => {
  res.json({
    kyc_vendor_hint: String(process.env.KYC_VENDOR_NAME || "").trim(),
    kyc_flow_hint: String(process.env.KYC_FLOW_DESCRIPTION || "").trim(),
    hr_pipeline_hint: String(process.env.HR_SUPPORT_PIPELINE_NOTES || "").trim(),
  });
});

function requireOwner(req, res, next) {
  if (req.operator.role !== "owner") {
    return res.status(403).json({ error: "Ta operacja jest dostępna tylko dla właściciela." });
  }
  next();
}

app.get("/api/op/staff", requireOperator, requireOwner, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, email, display_name, role, datetime(created_at) AS created_at, disabled_at,
        COALESCE(kyc_status, 'unverified') AS kyc_status
       FROM operators ORDER BY datetime(created_at)`
    )
    .all();
  res.json({ operators: rows });
});

app.patch("/api/op/operators/:operatorId", requireOperator, requireOwner, (req, res) => {
  const oid = req.params.operatorId;
  if (oid === req.operator.id) {
    return res.status(400).json({ error: "Nie możesz zablokować ani odblokować samego siebie." });
  }
  const target = db.prepare(`SELECT id, role FROM operators WHERE id = ?`).get(oid);
  if (!target) return res.status(404).json({ error: "Nie znaleziono konta." });
  if (target.role === "owner") {
    return res.status(403).json({ error: "Nie można blokować konta właściciela." });
  }
  const dis = !!req.body?.disabled;
  db.prepare(`UPDATE operators SET disabled_at = ? WHERE id = ?`).run(dis ? dtNowIso() : null, oid);
  if (dis) db.prepare(`DELETE FROM operator_sessions WHERE operator_id = ?`).run(oid);
  res.json({ ok: true, disabled: dis });
});

app.post("/api/op/operators/:operatorId/revoke-sessions", requireOperator, requireOwner, (req, res) => {
  const oid = req.params.operatorId;
  if (oid === req.operator.id) {
    return res.status(400).json({ error: "Nie możesz wylogować własnej sesji tą ścieżką — użyj „Wyloguj”." });
  }
  if (!db.prepare(`SELECT id FROM operators WHERE id = ?`).get(oid)) {
    return res.status(404).json({ error: "Nie znaleziono konta." });
  }
  const r = db.prepare(`DELETE FROM operator_sessions WHERE operator_id = ?`).run(oid);
  res.json({ ok: true, deleted_sessions: r.changes });
});

function dtNowIso() {
  return new Date().toISOString();
}

app.get("/api/op/monitor", requireOperator, requireOwner, (_req, res) => {
  sweepAssignments(db);
  res.json(getOperatorMonitorSnapshot(db));
});

app.get("/api/op/reports", requireOperator, requireOwner, (req, res) => {
  const st = String(req.query.status || "open").trim().toLowerCase();
  const where =
    st === "resolved" ? `r.status = 'resolved'`
    : st === "all" ? `1=1`
    : `r.status = 'open'`;
  const rows = db
    .prepare(
      `SELECT r.id, r.message_id, r.thread_id, r.reporter_operator_id, r.reason, r.status,
              r.owner_note, datetime(r.created_at) AS created_at, datetime(r.resolved_at) AS resolved_at,
              r.resolved_by_operator_id,
              rep.display_name AS reporter_display_name, rep.email AS reporter_email,
              rb.display_name AS resolver_display_name,
              m.body AS message_body, m.sender AS message_sender, datetime(m.created_at) AS message_created_at,
              u.display_name AS client_display_name, c.name AS character_name
       FROM message_reports r
       JOIN messages m ON m.id = r.message_id
       JOIN threads th ON th.id = r.thread_id
       JOIN users u ON u.id = th.user_id
       JOIN characters c ON c.id = th.character_id
       JOIN operators rep ON rep.id = r.reporter_operator_id
       LEFT JOIN operators rb ON rb.id = r.resolved_by_operator_id
       WHERE ${where}
       ORDER BY datetime(r.created_at) DESC
       LIMIT 200`
    )
    .all();
  const openCount = db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get().c;
  res.json({ reports: rows, open_count: openCount });
});

app.patch("/api/op/reports/:reportId", requireOperator, requireOwner, (req, res) => {
  const rid = req.params.reportId;
  const status = String(req.body?.status || "").trim().toLowerCase();
  const owner_note = String(req.body?.owner_note ?? "").trim().slice(0, 1000);
  if (status !== "open" && status !== "resolved") {
    return res.status(400).json({ error: "Pole status: open lub resolved." });
  }
  const row = db.prepare(`SELECT id, thread_id, message_id FROM message_reports WHERE id = ?`).get(rid);
  if (!row) return res.status(404).json({ error: "Nie znaleziono zgłoszenia." });
  if (status === "resolved") {
    db.prepare(
      `UPDATE message_reports SET status = 'resolved', owner_note = ?, resolved_at = datetime('now'),
       resolved_by_operator_id = ? WHERE id = ?`
    ).run(owner_note, req.operator.id, rid);
  } else {
    db.prepare(
      `UPDATE message_reports SET status = 'open', resolved_at = NULL, resolved_by_operator_id = NULL
       WHERE id = ?`
    ).run(rid);
    if (owner_note) {
      db.prepare(`UPDATE message_reports SET owner_note = ? WHERE id = ?`).run(owner_note, rid);
    }
  }
  const action = status === "resolved" ? "message_report_resolve" : "message_report_reopen";
  db.prepare(
    `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    req.operator.id,
    action,
    row.thread_id,
    JSON.stringify({ report_id: rid, message_id: row.message_id })
  );
  const openCount = db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get().c;
  res.json({ ok: true, open_count: openCount });
});

app.get("/api/op/owner/team-insights", requireOperator, requireOwner, (req, res) => {
  const raw = parseInt(String(req.query.feed_limit || "120"), 10);
  const feedLimit = Number.isFinite(raw) ? Math.min(400, Math.max(40, raw)) : 120;
  const feed = db
    .prepare(
      `SELECT m.id, m.body, datetime(m.created_at) AS created_at,
              m.thread_id, m.operator_id,
              o.display_name AS operator_display_name, o.email AS operator_email,
              c.name AS character_name, u.display_name AS client_display_name
       FROM messages m
       JOIN operators o ON o.id = m.operator_id
       JOIN threads t ON t.id = m.thread_id
       JOIN users u ON u.id = t.user_id
       JOIN characters c ON c.id = t.character_id
       WHERE m.sender = 'staff' AND COALESCE(o.role, 'staff') = 'staff'
       ORDER BY datetime(m.created_at) DESC
       LIMIT ?`
    )
    .all(feedLimit);
  const ranking = db
    .prepare(
      `SELECT o.id AS operator_id, o.display_name, o.email,
              COUNT(*) AS staff_messages_7d
       FROM messages m
       JOIN operators o ON o.id = m.operator_id
       WHERE m.sender = 'staff'
         AND COALESCE(o.role, 'staff') = 'staff'
         AND datetime(m.created_at) >= datetime('now', '-7 days')
       GROUP BY o.id
       ORDER BY staff_messages_7d DESC, o.display_name COLLATE NOCASE`
    )
    .all();
  res.json({
    feed,
    ranking,
    period: {
      label: "Ranking: ostatnie 7 dni od zegara serwera (SQLite UTC). Czasy w panelu: Europe/Warsaw.",
      days: 7,
    },
    bonus: {
      top1_pln: Number(process.env.STAFF_BONUS_TOP1_WEEK_PLN || 0) || 0,
      top2_pln: Number(process.env.STAFF_BONUS_TOP2_WEEK_PLN || 0) || 0,
      top3_pln: Number(process.env.STAFF_BONUS_TOP3_WEEK_PLN || 0) || 0,
    },
    spotlight_message: String(process.env.STAFF_SPOTLIGHT_WEEK_MESSAGE || "").trim(),
    recommendation_hint: String(process.env.STAFF_RECOMMENDATION_HINT || "").trim(),
  });
});

app.post("/api/op/staff", requireOperator, requireOwner, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const display_name = String(req.body?.display_name || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Niepoprawny e-mail." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Hasło: min. 8 znaków." });
  if (display_name.length < 2 || display_name.length > 60) {
    return res.status(400).json({ error: "Imię: 2–60 znaków." });
  }
  if (db.prepare("SELECT id FROM operators WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "Ten e-mail jest już w systemie." });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `INSERT INTO operators (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'staff')`
  ).run(id, email, hash, display_name);
  res.status(201).json({
    operator: { id, email, display_name, role: "staff" },
  });
});

function sanitizeFactsForOperator(facts, operator) {
  if (operator.role === "owner") return facts;
  return facts.map((f) => {
    const out = { ...f };
    delete out.created_operator_email;
    return out;
  });
}

app.get("/api/op/inbox", requireOperator, (req, res) => {
  sweepAssignments(db);
  const bucketParam = String(req.query.bucket || "").trim().toLowerCase();
  const bucket = bucketParam || (req.operator.role === "owner" ? "all" : "mine");
  const wh = inboxBucketClause(req.operator, bucket);
  const rows = db
    .prepare(
      `SELECT t.id AS thread_id,
              t.assigned_operator_id,
              u.email AS user_email,
              u.display_name AS user_display_name,
              c.id AS character_id,
              c.name AS character_name,
              c.category,
              datetime(t.created_at) AS thread_started_at,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.sender FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_sender,
              (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_preview,
              (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_at,
              t.client_hidden_at
       FROM threads t
       JOIN users u ON u.id = t.user_id
       JOIN characters c ON c.id = t.character_id
       WHERE ${wh.sql}
       ORDER BY datetime(COALESCE(last_at, t.created_at)) DESC
       LIMIT 300`
    )
    .all(...wh.params);
  if (req.operator.role !== "owner") {
    for (const r of rows) {
      delete r.message_count;
      delete r.user_email;
    }
  }
  res.json({ threads: rows, bucket });
});

app.get("/api/op/clients", requireOperator, requireOwner, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.username, u.first_name, u.display_name, u.birth_date, u.city,
              datetime(u.created_at) AS created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.user_id = u.id) AS thread_count,
              (SELECT COALESCE(SUM(delta), 0) FROM ledger l WHERE l.user_id = u.id) AS messages_balance
       FROM users u
       ORDER BY datetime(u.created_at) DESC`
    )
    .all();
  res.json({ clients: rows });
});

app.get("/api/op/facts-schema", requireOperator, (_req, res) => {
  res.json(flattenSchemaForApi());
});

app.get("/api/op/stats", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.json({ role: "owner", stats: null });
  }
  sweepAssignments(db);
  res.json({ role: "staff", stats: getOperatorStats(db, req.operator.id) });
});

app.get("/api/op/staff-dashboard", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({ error: "Ten widok jest tylko dla pracowników." });
  }
  sweepAssignments(db);
  res.json({ dashboard: getStaffDashboard(db, req.operator.id) });
});

app.get("/api/op/me/payout-ledger", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.json({ entries: [] });
  }
  const rows = db
    .prepare(
      `SELECT id, amount_pln, label, period_label, datetime(created_at) AS created_at
       FROM operator_payout_ledger WHERE operator_id = ?
       ORDER BY datetime(created_at) DESC LIMIT 80`
    )
    .all(req.operator.id);
  res.json({ entries: rows });
});

app.get("/api/op/me/contacts", requireOperator, (req, res) => {
  res.json({
    owner_contact_email: String(process.env.OWNER_CONTACT_EMAIL || "").trim(),
    staff_support_email: String(process.env.STAFF_SUPPORT_EMAIL || "").trim(),
    staff_support_teams_url: String(process.env.STAFF_SUPPORT_TEAMS_URL || "").trim(),
  });
});

app.get("/api/op/audit/:auditId", requireOperator, requireOwner, (req, res) => {
  const row = db
    .prepare(
      `SELECT a.id, a.operator_id, a.action, a.thread_id, a.detail, datetime(a.created_at) AS created_at,
              o.email AS operator_email
       FROM operator_audit a
       JOIN operators o ON o.id = a.operator_id
       WHERE a.id = ?`
    )
    .get(req.params.auditId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono wpisu dziennika." });
  res.json({ audit: row });
});

app.get("/api/op/queue", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({ error: "Pula anonimowa jest tylko dla pracowników." });
  }
  sweepAssignments(db);
  res.json({ slots: getStaffQueueSlots(db, req.operator.id) });
});

app.post("/api/op/inbox/:threadId/claim", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  const r = tryClaimThread(db, req.operator, threadId);
  if (!r.ok) return res.status(403).json({ error: r.error });
  res.json({ ok: true, assignment: getAssignmentPayload(db, threadId, req.operator) });
});

app.post("/api/op/inbox/:threadId/claim-stopped", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  const r = tryClaimStoppedThread(db, req.operator, threadId);
  if (!r.ok) return res.status(403).json({ error: r.error });
  res.json({ ok: true, assignment: getAssignmentPayload(db, threadId, req.operator) });
});

app.post("/api/op/inbox/:threadId/touch", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  bumpStaffActivity(db, threadId, req.operator.id);
  res.json({ ok: true });
});

app.get("/api/op/inbox/:threadId/messages", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Nie widzisz tego wątku na liście." });
  }
  bumpStaffActivity(db, threadId, req.operator.id);
  const rawLimit = parseInt(String(req.query.limit || "15"), 10);
  let limitTotal = Number.isFinite(rawLimit) ? rawLimit : 15;
  if (limitTotal < 15) limitTotal = 15;
  if (limitTotal > 500) limitTotal = 500;
  if (limitTotal > 15 && (limitTotal - 15) % 10 !== 0) {
    return res.status(400).json({
      error: "Parametr limit: dozwolone 15, potem 25, 35, 45… (co 10), maks. 500.",
    });
  }
  const raw = db
    .prepare(
      `SELECT t.id, u.email AS user_email, u.display_name AS user_display_name,
              u.username AS client_username, u.first_name AS client_first_name,
              u.birth_date AS client_birth_date, u.city AS client_city, u.avatar_url AS client_avatar_url,
              c.name AS character_name, c.id AS character_id,
              c.tagline AS character_tagline, c.portrait_url AS character_portrait_url,
              c.gender AS character_gender, c.skills AS character_skills, c.about AS character_about,
              COALESCE(t.internal_notes, '') AS internal_notes,
              datetime(t.created_at) AS thread_started_at,
              t.client_hidden_at,
              (SELECT COUNT(*) FROM messages m0 WHERE m0.thread_id = t.id) AS message_count
       FROM threads t
       JOIN users u ON u.id = t.user_id
       JOIN characters c ON c.id = t.character_id
       WHERE t.id = ?`
    )
    .get(threadId);
  if (!raw) return res.status(404).json({ error: "Nie znaleziono wątku." });
  const meta = {
    id: raw.id,
    user_email: raw.user_email,
    user_display_name: raw.user_display_name,
    character_name: raw.character_name,
    character_id: raw.character_id,
    character_tagline: raw.character_tagline,
    character_portrait_url: raw.character_portrait_url,
    internal_notes: raw.internal_notes,
    thread_started_at: raw.thread_started_at,
    client_hidden_at: raw.client_hidden_at,
    message_count: raw.message_count,
    client_profile: {
      username: raw.client_username,
      first_name: raw.client_first_name,
      birth_date: raw.client_birth_date,
      city: raw.client_city || "",
      avatar_url: raw.client_avatar_url,
    },
    medium_profile: {
      name: raw.character_name,
      tagline: raw.character_tagline,
      portrait_url: raw.character_portrait_url,
      gender: raw.character_gender,
      skills: raw.character_skills,
      about: raw.character_about,
    },
  };
  if (req.operator.role !== "owner") {
    delete meta.message_count;
    delete meta.user_email;
  }
  const factsRaw = db
    .prepare(
      `SELECT tf.id, tf.scope, tf.category, tf.field, tf.slot, tf.value, tf.updated_at,
              tf.created_operator_id, tf.updated_operator_id,
              oc.email AS created_operator_email
       FROM thread_facts tf
       LEFT JOIN operators oc ON oc.id = tf.created_operator_id
       WHERE tf.thread_id = ?
       ORDER BY tf.scope, tf.category, tf.field, tf.slot`
    )
    .all(threadId);
  const facts = sanitizeFactsForOperator(factsRaw, req.operator);
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?`)
    .get(threadId);
  const messageTotal = totalRow?.c ?? 0;
  const msgs = db
    .prepare(
      `SELECT m.id, m.sender, m.body, m.created_at, m.operator_id,
              op.display_name AS staff_join_display_name, op.email AS staff_join_email
       FROM messages m
       LEFT JOIN operators op ON op.id = m.operator_id
       WHERE m.thread_id = ? ORDER BY datetime(m.created_at) DESC LIMIT ?`
    )
    .all(threadId, limitTotal);
  const isOwner = req.operator.role === "owner";
  const opId = req.operator.id;
  const openRepRows = db
    .prepare(`SELECT message_id FROM message_reports WHERE thread_id = ? AND status = 'open'`)
    .all(threadId);
  const openReportMsgIds = new Set(openRepRows.map((r) => r.message_id));
  const mapped = msgs.map((m) => {
    let body = m.body;
    if (m.sender === "user") {
      body = maskClientNumbersForOperator(m.body);
    }
    const isOwnStaffReply = m.sender === "staff" && m.operator_id === opId;
    const out = {
      id: m.id,
      sender: m.sender,
      body,
      created_at: m.created_at,
      is_own_staff_reply: isOwnStaffReply,
      has_open_report: openReportMsgIds.has(m.id),
    };
    if (isOwner) {
      out.operator_id = m.operator_id;
      if (m.sender === "staff") {
        out.staff_display_name = m.staff_join_display_name || null;
        out.staff_email = m.staff_join_email || null;
      }
    }
    return out;
  });
  res.json({
    meta,
    facts,
    messages: mapped,
    message_total: messageTotal,
    messages_limit: limitTotal,
    has_more_messages: messageTotal > limitTotal,
    assignment: getAssignmentPayload(db, threadId, req.operator),
  });
});

app.post("/api/op/inbox/:threadId/messages/:messageId/report", requireOperator, (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({
      error: "Zgłoszenia zapisuje pracownik z czatu — Ty widzisz je w zakładce „Zgłoszenia”.",
    });
  }
  const threadId = req.params.threadId;
  const messageId = req.params.messageId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const msg = db
    .prepare(`SELECT id, thread_id, sender FROM messages WHERE id = ?`)
    .get(messageId);
  if (!msg || msg.thread_id !== threadId) {
    return res.status(404).json({ error: "Nie znaleziono wiadomości." });
  }
  const ex = db.prepare(`SELECT id FROM message_reports WHERE message_id = ? AND status = 'open'`).get(
    messageId
  );
  if (ex) {
    return res.status(409).json({ error: "Ta wiadomość ma już otwarte zgłoszenie." });
  }
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  const id = uuidv4();
  db.prepare(
    `INSERT INTO message_reports (id, message_id, thread_id, reporter_operator_id, reason, status)
     VALUES (?, ?, ?, ?, ?, 'open')`
  ).run(id, messageId, threadId, req.operator.id, reason);
  db.prepare(
    `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
     VALUES (?, ?, 'message_report', ?, ?)`
  ).run(
    uuidv4(),
    req.operator.id,
    threadId,
    JSON.stringify({
      report_id: id,
      message_id: messageId,
      message_sender: msg.sender,
      reason_preview: reason.slice(0, 200),
    })
  );
  res.status(201).json({ ok: true, report_id: id });
});

app.patch("/api/op/inbox/:threadId/facts", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const perm = assertStaffCanMutate(db, req.operator, threadId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const scope = String(req.body?.scope || "");
  const category = String(req.body?.category || "");
  const field = String(req.body?.field || "");
  const value = String(req.body?.value ?? "").trim();
  const factId = String(req.body?.fact_id ?? "").trim();
  if (scope !== "client" && scope !== "consultant") {
    return res.status(400).json({ error: "Nieprawidłowy zakres (scope)." });
  }
  if (!isValidFactKey(scope, category, field)) {
    return res.status(400).json({ error: "Nieprawidłowa kategoria lub pole." });
  }
  const th = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!th) return res.status(404).json({ error: "Nie znaleziono wątku." });
  if (value.length > FACT_VALUE_MAX_LEN) {
    return res.status(400).json({ error: `Wartość: maks. ${FACT_VALUE_MAX_LEN} znaków.` });
  }

  const loadFactOut = (id) =>
    db
      .prepare(
        `SELECT tf.id, tf.scope, tf.category, tf.field, tf.slot, tf.value, tf.updated_at,
              tf.created_operator_id, tf.updated_operator_id,
              oc.email AS created_operator_email
       FROM thread_facts tf
       LEFT JOIN operators oc ON oc.id = tf.created_operator_id
       WHERE tf.id = ?`
      )
      .get(id);

  if (!value) {
    if (!factId) {
      return res.status(400).json({ error: "Usuń wpis przyciskiem × przy konkretnej notatce." });
    }
    const delRow = db
      .prepare(
        `SELECT id, scope, category, field, value, created_operator_id FROM thread_facts WHERE id = ? AND thread_id = ?`
      )
      .get(factId, threadId);
    if (!delRow) {
      return res.status(404).json({ error: "Nie znaleziono notatki." });
    }
    if (req.operator.role !== "owner") {
      if (!delRow.created_operator_id) {
        return res.status(403).json({
          error: "Usunięcie starszej notatki (bez autora) — tylko właściciel.",
        });
      }
      if (delRow.created_operator_id !== req.operator.id) {
        return res.status(403).json({ error: "Możesz usunąć tylko własne notatki." });
      }
    }
    const priorVal = String(delRow.value ?? "");
    db.prepare(`DELETE FROM thread_facts WHERE id = ?`).run(factId);
    db.prepare(
      `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
       VALUES (?, ?, 'fact_delete', ?, ?)`
    ).run(
      uuidv4(),
      req.operator.id,
      threadId,
      JSON.stringify({
        scope: delRow.scope,
        category: delRow.category,
        field: delRow.field,
        fact_id: factId,
        prior_value: priorVal.slice(0, 8000),
      })
    );
    bumpStaffActivity(db, threadId, req.operator.id);
    return res.json({ ok: true, deleted: true });
  }

  if (factId) {
    return res.status(400).json({
      error: "Notatek się nie nadpisuje — usuń stary wpis (×) i dodaj nowy.",
    });
  }

  const slotRow = db
    .prepare(
      `SELECT COALESCE(MAX(slot), -1) + 1 AS s FROM thread_facts WHERE thread_id = ? AND scope = ? AND category = ? AND field = ?`
    )
    .get(threadId, scope, category, field);
  const slot = Number(slotRow?.s ?? 0);
  const newId = uuidv4();
  db.prepare(
    `INSERT INTO thread_facts (id, thread_id, scope, category, field, slot, value, updated_at, created_operator_id, updated_operator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
  ).run(newId, threadId, scope, category, field, slot, value, req.operator.id, req.operator.id);
  db.prepare(
    `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
     VALUES (?, ?, 'fact_save', ?, ?)`
  ).run(
    uuidv4(),
    req.operator.id,
    threadId,
    JSON.stringify({
      scope,
      category,
      field,
      kind: "create",
      slot,
      value_preview: value.slice(0, 800),
    })
  );
  bumpStaffActivity(db, threadId, req.operator.id);
  const outRow = loadFactOut(newId);
  const factOut = sanitizeFactsForOperator(outRow ? [outRow] : [], req.operator)[0] || outRow;
  res.json({ ok: true, fact: factOut });
});

app.patch("/api/op/inbox/:threadId/notes", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const perm = assertStaffCanMutate(db, req.operator, threadId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const notes = String(req.body?.notes ?? "");
  if (notes.length > 32000) {
    return res.status(400).json({ error: "Notatki: maks. 32 000 znaków." });
  }
  const info = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!info) return res.status(404).json({ error: "Nie znaleziono wątku." });
  db.prepare("UPDATE threads SET internal_notes = ? WHERE id = ?").run(notes, threadId);
  bumpStaffActivity(db, threadId, req.operator.id);
  res.json({ ok: true, internal_notes: notes });
});

app.post("/api/op/inbox/:threadId/reply", requireOperator, (req, res) => {
  const threadId = req.params.threadId;
  if (!threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role)) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const body = String(req.body?.body || "").trim();
  const minLen =
    req.operator.role === "owner" ? OWNER_REPLY_MIN_CHARS : STAFF_REPLY_MIN_CHARS;
  const maxLen = req.operator.role === "owner" ? OWNER_REPLY_MAX_CHARS : STAFF_REPLY_MAX_CHARS;
  if (body.length < minLen || body.length > maxLen) {
    const who = req.operator.role === "owner" ? "Właściciel" : "Pracownik";
    return res.status(400).json({
      error: `${who}: treść odpowiedzi musi mieć ${minLen}–${maxLen} znaków (masz ${body.length}).`,
    });
  }
  if (req.operator.role !== "owner") {
    const banned = findBannedStaffReplySubstring(body);
    if (banned) {
      return res.status(400).json({
        error: `W odpowiedzi do klienta nie możesz użyć wyrażenia sugerującego kontakt poza platformą lub „ujawnianie” pracy (wykryto fragment zawierający: „${banned}”). Użyj innych słów — w notatkach wewnętrznych to ograniczenie nie obowiązuje.`,
      });
    }
  }
  const th = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!th) return res.status(404).json({ error: "Nie znaleziono wątku." });
  const perm = ensureReplyPermission(db, req.operator, threadId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const msgId = uuidv4();
  db.prepare(
    "INSERT INTO messages (id, thread_id, sender, body, operator_id) VALUES (?, ?, 'staff', ?, ?)"
  ).run(msgId, threadId, body, req.operator.id);
  bumpStaffActivity(db, threadId, req.operator.id);
  onStaffReply(db, threadId, req.operator);
  const msg = db
    .prepare("SELECT id, sender, body, created_at, operator_id FROM messages WHERE id = ?")
    .get(msgId);
  const isOwner = req.operator.role === "owner";
  const isOwnStaffReply = msg.sender === "staff" && msg.operator_id === req.operator.id;
  const msgOut = {
    id: msg.id,
    sender: msg.sender,
    body: msg.body,
    created_at: msg.created_at,
    is_own_staff_reply: isOwnStaffReply,
  };
  if (isOwner) msgOut.operator_id = msg.operator_id;
  res.json({
    ok: true,
    message: msgOut,
    assignment: getAssignmentPayload(db, threadId, req.operator),
  });
});

app.use("/operator", express.static(path.join(__dirname, "public", "operator")));
app.use(express.static(path.join(__dirname, "public")));

ensureBootstrapOperator();

app.listen(PORT, () => {
  console.log(`Portal klienta:  http://localhost:${PORT}/`);
  console.log(`Panel pracy:     http://localhost:${PORT}/operator/`);
  console.log(`Testowy zakup:   ${ALLOW_FAKE_PURCHASE ? "włączony" : "wyłączony"}`);
});
