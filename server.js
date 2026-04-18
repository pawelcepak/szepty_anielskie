import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, ensureBootstrapOperator } from "./db.js";
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
import {
  sendEmailChangeConfirmation,
  isMailConfigured,
  mailVerificationTtlMs,
  publicBaseUrl,
  sendOperatorEmailToUser,
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "./mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = await initDatabase();
await ensureBootstrapOperator(db);

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (process.env.NODE_ENV === "production" && !DATABASE_URL) {
  throw new Error(
    "Brak DATABASE_URL w produkcji. Skonfiguruj Railway Postgres i uruchom migracje: npm run pg:init && npm run pg:migrate-from-sqlite."
  );
}
const ALLOW_FAKE_PURCHASE =
  String(process.env.ALLOW_FAKE_PURCHASE || "true").toLowerCase() === "true";

/** Publiczny URL panelu operatora (ustaw w produkcji długi, losowy segment — nie używaj „/operator”). */
function operatorPanelBasePath() {
  let p = String(process.env.OPERATOR_PANEL_PATH || "").trim();
  if (!p) p = "/operator";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p || "/operator";
}
const OPERATOR_PANEL_PATH = operatorPanelBasePath();

const COOKIE_CUSTOMER = "customer_session";
const COOKIE_OPERATOR = "operator_session";
const PKG_AMOUNTS = new Set(APP_CONFIG.pricing.clientPackages.map((pkg) => Number(pkg.amount)));
const CUSTOMER_SESSION_IDLE_MINUTES = Math.min(
  24 * 60,
  Math.max(1, Number(process.env.CUSTOMER_SESSION_IDLE_MINUTES || 10))
);
const CUSTOMER_SESSION_IDLE_MS = CUSTOMER_SESSION_IDLE_MINUTES * 60 * 1000;
const PROMO_SYSTEM_ENABLED = ["1", "true", "yes"].includes(
  String(process.env.PROMO_SYSTEM_ENABLED || "false").toLowerCase()
);
const SEO_INDEXABLE = ["1", "true", "yes"].includes(String(process.env.SEO_INDEXABLE || "false").toLowerCase());
const P24_ENABLED = ["1", "true", "yes"].includes(String(process.env.P24_ENABLED || "false").toLowerCase());
const P24_SANDBOX = ["1", "true", "yes"].includes(String(process.env.P24_SANDBOX || "true").toLowerCase());

function isP24Configured() {
  const merchantId = String(process.env.P24_MERCHANT_ID || "").trim();
  const posId = String(process.env.P24_POS_ID || "").trim();
  const crc = String(process.env.P24_CRC || "").trim();
  return P24_ENABLED && !!merchantId && !!posId && !!crc;
}

function promoConfigPublic() {
  return {
    enabled: PROMO_SYSTEM_ENABLED,
    popup_enabled: ["1", "true", "yes"].includes(String(process.env.PROMO_POPUP_ENABLED || "false").toLowerCase()),
  };
}

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
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "512kb" }));
app.use(cookieParser());
const registerJsonParser = express.json({ limit: "1mb" });

if (!SEO_INDEXABLE) {
  app.use((req, res, next) => {
    if (req.method === "GET" && !String(req.path || "").startsWith("/api")) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
    next();
  });
}

function openAiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function anthropicKey() {
  return String(process.env.ANTHROPIC_API_KEY || "").trim();
}

function hasOpenAi() {
  return !!openAiKey();
}

function hasAnthropic() {
  return !!anthropicKey();
}

function pickAiProvider(requested) {
  const pref = String(requested || "auto").trim().toLowerCase();
  if (pref === "openai") return hasOpenAi() ? "openai" : null;
  if (pref === "anthropic") return hasAnthropic() ? "anthropic" : null;
  if (hasAnthropic()) return "anthropic";
  if (hasOpenAi()) return "openai";
  return null;
}

/** Odczyt komunikatu z JSON błędu OpenAI / Anthropic / podobnych. */
function extractApiErrorMessage(data, fallback) {
  if (data == null || typeof data !== "object") return fallback;
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  const e = data.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e === "object" && typeof e.message === "string" && e.message.trim()) return e.message.trim();
  if (Array.isArray(data.errors) && data.errors[0] && typeof data.errors[0].message === "string") {
    return data.errors[0].message;
  }
  return fallback;
}

async function generateDraftWithOpenAi({ prompt }) {
  const key = openAiKey();
  if (!key) throw new Error("Brak OPENAI_API_KEY.");
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "Jesteś asystentem operatora portalu ezoterycznego. Tworzysz empatyczne, konkretne odpowiedzi po polsku, bez obietnic gwarantowanego skutku i bez zachęt do kontaktu poza platformą.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw.slice(0, 800) };
  }
  if (!r.ok) {
    const msg = extractApiErrorMessage(data, `OpenAI HTTP ${r.status}`);
    console.error("[openai] chat/completions", r.status, raw.slice(0, 1500));
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  const txt = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!txt) throw new Error("OpenAI nie zwrócił treści odpowiedzi.");
  return { text: txt, model };
}

async function generateDraftWithAnthropic({ prompt }) {
  const key = anthropicKey();
  if (!key) throw new Error("Brak ANTHROPIC_API_KEY.");
  const model = String(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5").trim();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      temperature: 0.6,
      system:
        "Jesteś asystentem operatora portalu ezoterycznego. Tworzysz empatyczne, konkretne odpowiedzi po polsku, bez obietnic gwarantowanego skutku i bez zachęt do kontaktu poza platformą.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw.slice(0, 800) };
  }
  if (!r.ok) {
    const msg = extractApiErrorMessage(data, `Anthropic HTTP ${r.status}`);
    console.error("[anthropic] messages", r.status, raw.slice(0, 1500));
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  const txt = String(data?.content?.[0]?.text || "").trim();
  if (!txt) throw new Error("Anthropic nie zwrócił treści odpowiedzi.");
  return { text: txt, model };
}

async function generateImageWithOpenAi({ prompt, size = "1024x1024", apiKey }) {
  const key = String(apiKey || openAiKey() || "").trim();
  if (!key) throw new Error("Brak OPENAI_API_KEY dla generowania obrazów.");
  const model = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();
  const allowed = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  const imgSize = allowed.has(size) ? size : "1024x1024";
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: imgSize,
    }),
  });
  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw.slice(0, 800) };
  }
  if (!r.ok) {
    const msg = extractApiErrorMessage(data, `OpenAI Images HTTP ${r.status}`);
    console.error("[openai] images/generations", r.status, raw.slice(0, 1500));
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  const first = Array.isArray(data?.data) && data.data[0] ? data.data[0] : null;
  const imageUrl = String(first?.url || "").trim();
  const imageB64 = String(first?.b64_json || "").trim();
  if (!imageUrl && !imageB64) {
    throw new Error("OpenAI nie zwrócił obrazu.");
  }
  const finalUrl = imageUrl || `data:image/png;base64,${imageB64}`;
  return { model, url: finalUrl };
}

function safeJsonParse(input) {
  try {
    return JSON.parse(String(input || ""));
  } catch {
    return null;
  }
}

function normalizeMarketingItem(item, fallbackChannel) {
  const channel = String(item?.channel || fallbackChannel || "").trim() || "general";
  const title = String(item?.title || "").trim();
  const description = String(item?.description || "").trim();
  const tagsRaw = Array.isArray(item?.tags)
    ? item.tags
    : String(item?.tags || "")
        .split(/[,\n#]+/)
        .map((x) => x.trim());
  const tags = tagsRaw.filter(Boolean).slice(0, 25);
  const visualPrompt = String(item?.visual_prompt || item?.image_prompt || "").trim();
  return { channel, title, description, tags, visual_prompt: visualPrompt };
}

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

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function extendCustomerSession(res, sessionId, token) {
  const exp = customerSessionExpiresAt();
  await db.prepare(`UPDATE customer_sessions SET expires_at = ? WHERE id = ?`).run(exp, sessionId);
  res.cookie(COOKIE_CUSTOMER, token, customerCookieOpts());
}

async function messagesBalance(userId) {
  const r = await db.prepare("SELECT COALESCE(SUM(delta), 0) AS bal FROM ledger WHERE user_id = ?").get(
    userId
  );
  return r.bal;
}

const requireCustomer = asyncRoute(async (req, res, next) => {
  const token = req.cookies[COOKIE_CUSTOMER];
  if (!token) {
    return res.status(401).json({ error: "Zaloguj się, aby kontynuować." });
  }
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.username, u.first_name, u.birth_date, u.city, u.gender, u.has_children, u.smokes, u.drinks_alcohol, u.has_car, u.avatar_url
              , u.blocked_at, u.email_verified_at
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
  if (row.blocked_at) {
    await clearCustomerSession(req, res);
    return res.status(403).json({ error: "Twoje konto zostało zablokowane. Skontaktuj się z obsługą." });
  }
  if (!row.email_verified_at) {
    await clearCustomerSession(req, res);
    return res.status(403).json({ error: "Potwierdź adres e-mail (link w wiadomości rejestracyjnej)." });
  }
  await extendCustomerSession(res, row.session_id, token);
  req.customer = {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    username: row.username,
    first_name: row.first_name,
    birth_date: row.birth_date,
    city: row.city || "",
    gender: row.gender || "",
    has_children: row.has_children || "unknown",
    smokes: row.smokes || "unknown",
    drinks_alcohol: row.drinks_alcohol || "unknown",
    has_car: row.has_car || "unknown",
    avatar_url: row.avatar_url,
  };
  next();
});

const requireOperator = asyncRoute(async (req, res, next) => {
  const token = req.cookies[COOKIE_OPERATOR];
  if (!token) {
    return res.status(401).json({ error: "Zaloguj się do panelu pracy." });
  }
  const row = await db
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
});

async function setCustomerSession(res, userId) {
  const token = tokenBytes();
  const id = uuidv4();
  const exp = customerSessionExpiresAt();
  await db
    .prepare(
      `INSERT INTO customer_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`
    )
    .run(id, userId, token, exp);
  res.cookie(COOKIE_CUSTOMER, token, customerCookieOpts());
  return token;
}

async function clearCustomerSession(req, res) {
  const token = req.cookies[COOKIE_CUSTOMER];
  if (token) await db.prepare("DELETE FROM customer_sessions WHERE token = ?").run(token);
  res.clearCookie(COOKIE_CUSTOMER, sessionCookieClearOpts());
}

async function setOperatorSession(res, operatorId) {
  const token = tokenBytes();
  const id = uuidv4();
  const exp = sessionExpires(14);
  await db
    .prepare(
      `INSERT INTO operator_sessions (id, operator_id, token, expires_at) VALUES (?, ?, ?, ?)`
    )
    .run(id, operatorId, token, exp);
  res.cookie(COOKIE_OPERATOR, token, operatorCookieOpts());
}

async function clearOperatorSession(req, res) {
  const token = req.cookies[COOKIE_OPERATOR];
  if (token) await db.prepare("DELETE FROM operator_sessions WHERE token = ?").run(token);
  res.clearCookie(COOKIE_OPERATOR, sessionCookieClearOpts());
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const usernameOk = (u) => /^[a-z0-9_]{3,24}$/.test(u);
const passwordStrongOk = (p) =>
  /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);

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

function normalizeTriState(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "yes" || s === "no" || s === "unknown") return s;
  return "unknown";
}

function promoIsActiveNow(campaign) {
  if (!campaign || Number(campaign.is_active || 0) !== 1) return false;
  const now = Date.now();
  const startAt = String(campaign.start_at || "").trim();
  const endAt = String(campaign.end_at || "").trim();
  const startOk = !startAt || (Number.isFinite(new Date(startAt).getTime()) && new Date(startAt).getTime() <= now);
  const endOk = !endAt || (Number.isFinite(new Date(endAt).getTime()) && new Date(endAt).getTime() >= now);
  return startOk && endOk;
}

function normalizePromoKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildPromoCode(prefix) {
  const cleanPrefix = String(prefix || "SZEPT")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10) || "SZEPT";
  const body = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${cleanPrefix}-${body}`;
}

/** --- Klient: rejestracja / logowanie --- */

app.get(
  "/api/auth/status",
  asyncRoute(async (req, res) => {
    const token = req.cookies[COOKIE_CUSTOMER];
    if (!token) return res.json({ logged_in: false });
    const row = await db
      .prepare(
        `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.username, u.first_name, u.city, u.gender, u.has_children, u.smokes, u.drinks_alcohol, u.has_car
              , u.blocked_at, u.email_verified_at
       FROM customer_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`
      )
      .get(token);
    if (!row) {
      res.clearCookie(COOKIE_CUSTOMER, sessionCookieClearOpts());
      return res.json({ logged_in: false });
    }
    if (row.blocked_at) {
      await clearCustomerSession(req, res);
      return res.json({ logged_in: false });
    }
    if (!row.email_verified_at) {
      await clearCustomerSession(req, res);
      return res.json({ logged_in: false, email_verification_pending: true });
    }
    await extendCustomerSession(res, row.session_id, token);
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
        gender: row.gender || "",
        has_children: row.has_children || "unknown",
        smokes: row.smokes || "unknown",
        drinks_alcohol: row.drinks_alcohol || "unknown",
        has_car: row.has_car || "unknown",
      },
    });
  })
);

app.post("/api/auth/register", registerJsonParser, async (req, res, next) => {
  try {
  const acceptTerms = req.body?.accept_terms === true || req.body?.accept_terms === "true";
  const acceptPrivacy = req.body?.accept_privacy === true || req.body?.accept_privacy === "true";
  const acceptAge = req.body?.accept_age === true || req.body?.accept_age === "true";
  if (!acceptTerms || !acceptPrivacy || !acceptAge) {
    return res.status(400).json({ error: "Zaakceptuj regulamin, politykę prywatności i potwierdź pełnoletność." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const username = String(req.body?.username || "").trim().toLowerCase();
  const first_name = String(req.body?.first_name || "").trim();
  const city = String(req.body?.city || "").trim();
  const gender = "";
  const has_children = "unknown";
  const smokes = "unknown";
  const drinks_alcohol = "unknown";
  const has_car = "unknown";
  const avatar_url = null;
  let pending_open_character_id = String(req.body?.medium || "").trim() || null;
  if (pending_open_character_id) {
    const ch = await db.prepare("SELECT id FROM characters WHERE id = ?").get(pending_open_character_id);
    if (!ch) pending_open_character_id = null;
  }
  if (!emailOk(email)) return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  if (password.length < 8) {
    return res.status(400).json({ error: "Hasło musi mieć co najmniej 8 znaków." });
  }
  if (!passwordStrongOk(password)) {
    return res.status(400).json({
      error: "Hasło musi zawierać co najmniej jedną wielką literę, jedną cyfrę i jeden znak specjalny.",
    });
  }
  if (!usernameOk(username)) {
    return res.status(400).json({
      error: "Nazwa użytkownika: 3–24 znaki, litery, cyfry i podkreślenie (_).",
    });
  }
  if (first_name.length < 2 || first_name.length > 60) {
    return res.status(400).json({ error: "Imię: 2–60 znaków." });
  }
  if (city.length > 0 && (city.length < 2 || city.length > 80)) {
    return res.status(400).json({ error: "Miasto: opcjonalne; jeśli podasz — 2–80 znaków." });
  }
  const exists = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Ten adres e-mail jest już zarejestrowany." });
  if (await db.prepare("SELECT id FROM users WHERE lower(username) = lower(?)").get(username)) {
    return res.status(409).json({ error: "Ta nazwa użytkownika jest już zajęta." });
  }
  if (!isMailConfigured()) {
    return res.status(503).json({
      error:
        "Rejestracja wymaga skonfigurowanej wysyłki e-mail (SMTP). Ustaw SMTP_USER i SMTP_PASS w środowisku serwera.",
    });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  const display_name = first_name;
  const verifyToken = tokenBytes();
  const verifyExpires = new Date(Date.now() + mailVerificationTtlMs()).toISOString();
  await db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, username, first_name, birth_date, city, gender, has_children, smokes, drinks_alcohol, has_car, avatar_url,
        email_verified_at, email_verification_token, email_verification_expires_at, pending_open_character_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  ).run(
    id,
    email,
    hash,
    display_name,
    username,
    first_name,
    null,
    city || null,
    gender,
    has_children,
    smokes,
    drinks_alcohol,
    has_car,
    avatar_url,
    verifyToken,
    verifyExpires,
    pending_open_character_id
  );
  const verifyUrl = `${publicBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
  try {
    const mailInfo = await sendVerificationEmail({ to: email, verifyUrl, displayName: display_name });
    console.log("[mail][verify][register]", {
      to: email,
      message_id: mailInfo.messageId,
      accepted: mailInfo.accepted,
      rejected: mailInfo.rejected,
    });
  } catch (err) {
    await db.prepare("DELETE FROM users WHERE id = ?").run(id);
    console.error("[mail] verification send failed:", err?.message || err);
    return res.status(502).json({
      error: "Nie udało się wysłać wiadomości z linkiem potwierdzającym. Spróbuj ponownie za chwilę.",
    });
  }
  res.status(201).json({
    ok: true,
    email_verification_sent: true,
    email,
  });
  } catch (e) {
    next(e);
  }
});

app.get(
  "/api/auth/verify-email",
  asyncRoute(async (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.redirect(302, "/logowanie.html?verify_error=missing_token");
    }
    const row = await db
      .prepare(
        `SELECT id, email_verification_expires_at, pending_open_character_id FROM users WHERE email_verification_token = ?`
      )
      .get(token);
    if (!row) {
      return res.redirect(302, "/logowanie.html?verify_error=invalid");
    }
    const exp = row.email_verification_expires_at ? new Date(row.email_verification_expires_at).getTime() : 0;
    if (!exp || Number.isNaN(exp) || exp < Date.now()) {
      return res.redirect(302, "/logowanie.html?verify_error=expired");
    }
    const openId = row.pending_open_character_id ? String(row.pending_open_character_id) : "";
    await db
      .prepare(
        `UPDATE users SET email_verified_at = datetime('now'), email_verification_token = NULL,
        email_verification_expires_at = NULL, pending_open_character_id = NULL WHERE id = ?`
      )
      .run(row.id);
    await setCustomerSession(res, row.id);
    const q = openId ? `verified=1&open=${encodeURIComponent(openId)}` : "verified=1";
    res.redirect(302, `/panel.html?${q}`);
  })
);

app.get(
  "/api/auth/confirm-email-change",
  asyncRoute(async (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token) return res.redirect(302, "/panel.html?email_change=missing_token");
    const row = await db
      .prepare(
        `SELECT id, pending_email_change, email_verification_expires_at
         FROM users WHERE email_verification_token = ?`
      )
      .get(token);
    if (!row || !row.pending_email_change) return res.redirect(302, "/panel.html?email_change=invalid");
    const exp = row.email_verification_expires_at ? new Date(row.email_verification_expires_at).getTime() : 0;
    if (!exp || Number.isNaN(exp) || exp < Date.now()) return res.redirect(302, "/panel.html?email_change=expired");
    const newEmail = String(row.pending_email_change || "").trim().toLowerCase();
    const exists = await db.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?").get(newEmail, row.id);
    if (exists) return res.redirect(302, "/panel.html?email_change=taken");
    await db
      .prepare(
        `UPDATE users
         SET email = ?, pending_email_change = NULL, email_verification_token = NULL, email_verification_expires_at = NULL
         WHERE id = ?`
      )
      .run(newEmail, row.id);
    await setCustomerSession(res, row.id);
    res.redirect(302, "/panel.html?email_change=ok");
  })
);

app.post("/api/auth/resend-verification", registerJsonParser, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!emailOk(email)) return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  if (!isMailConfigured()) {
    return res.status(503).json({
      error: "Brak konfiguracji SMTP na serwerze. Ustaw SMTP_USER i SMTP_PASS.",
    });
  }
  const row = await db.prepare(
      `SELECT id, email, display_name, email_verified_at
       FROM users WHERE lower(email) = lower(?)`
    )
    .get(email);
  if (!row) {
    return res.json({ ok: true, sent: false });
  }
  if (row.email_verified_at) {
    return res.json({ ok: true, sent: false, already_verified: true });
  }
  const verifyToken = tokenBytes();
  const verifyExpires = new Date(Date.now() + mailVerificationTtlMs()).toISOString();
  await db.prepare(
    `UPDATE users
     SET email_verification_token = ?, email_verification_expires_at = ?
     WHERE id = ?`
  ).run(verifyToken, verifyExpires, row.id);
  const verifyUrl = `${publicBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
  try {
    const mailInfo = await sendVerificationEmail({
      to: row.email,
      verifyUrl,
      displayName: row.display_name || "użytkowniku",
    });
    console.log("[mail][verify][resend]", {
      to: row.email,
      message_id: mailInfo.messageId,
      accepted: mailInfo.accepted,
      rejected: mailInfo.rejected,
    });
  } catch (e) {
    console.error("[mail][verify][resend] failed:", e?.message || e);
    return res.status(502).json({ error: "Nie udało się ponownie wysłać linku aktywacyjnego." });
  }
  res.json({ ok: true, sent: true });
});

const RESET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

app.post("/api/auth/request-password-reset", registerJsonParser, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!emailOk(email)) return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  // Always return success to prevent email enumeration
  const row = await db.prepare(`SELECT id, display_name, first_name FROM users WHERE email = ?`).get(email);
  if (!row) return res.json({ ok: true });
  if (!isMailConfigured()) return res.status(503).json({ error: "Serwis wysyłki e-mail nie jest skonfigurowany. Skontaktuj się z obsługą." });
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`).run(row.id);
  await db.prepare(`INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`).run(uuidv4(), row.id, token, expiresAt);
  const resetUrl = `${publicBaseUrl()}/zmien-haslo.html?token=${encodeURIComponent(token)}`;
  try {
    await sendPasswordResetEmail({ to: email, resetUrl, displayName: row.first_name || row.display_name || "użytkowniku" });
  } catch (e) {
    console.error("[mail][password-reset] failed:", e?.message || e);
    return res.status(502).json({ error: "Nie udało się wysłać e-maila. Spróbuj ponownie później lub skontaktuj się z obsługą." });
  }
  res.json({ ok: true });
}));

app.post("/api/auth/reset-password", registerJsonParser, asyncRoute(async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");
  if (!token) return res.status(400).json({ error: "Brak tokenu resetowania hasła." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Hasło musi mieć co najmniej 8 znaków." });
  if (!/[A-Z]/.test(password)) return res.status(400).json({ error: "Hasło musi zawierać co najmniej 1 wielką literę." });
  if (!/[0-9]/.test(password)) return res.status(400).json({ error: "Hasło musi zawierać co najmniej 1 cyfrę." });
  if (!/[^A-Za-z0-9]/.test(password)) return res.status(400).json({ error: "Hasło musi zawierać co najmniej 1 znak specjalny." });
  const row = await db.prepare(`SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token = ?`).get(token);
  if (!row) return res.status(400).json({ error: "Link resetowania jest nieprawidłowy lub wygasł. Poproś o nowy link." });
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare(`DELETE FROM password_reset_tokens WHERE id = ?`).run(row.id);
    return res.status(400).json({ error: "Link resetowania wygasł. Poproś o nowy." });
  }
  const hash = bcrypt.hashSync(password, 12);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id);
  await db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`).run(row.user_id);
  res.json({ ok: true });
}));

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const row = await db
      .prepare(
        `SELECT id, email, display_name, password_hash, username, first_name, birth_date, city, gender, has_children, smokes, drinks_alcohol, has_car, avatar_url, blocked_at, email_verified_at
       FROM users WHERE email = ?`
      )
      .get(email);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ error: "Nieprawidłowy e-mail lub hasło." });
    }
    if (row.blocked_at) {
      return res.status(403).json({ error: "To konto jest zablokowane. Napisz do obsługi serwisu." });
    }
    if (!row.email_verified_at) {
      return res.status(403).json({ error: "Potwierdź adres e-mail — otwórz link w wiadomości wysłanej po rejestracji." });
    }
    await setCustomerSession(res, row.id);
    res.json({
      user: {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        username: row.username,
        first_name: row.first_name,
        birth_date: row.birth_date,
        city: row.city || "",
        gender: row.gender || "",
        has_children: row.has_children || "unknown",
        smokes: row.smokes || "unknown",
        drinks_alcohol: row.drinks_alcohol || "unknown",
        has_car: row.has_car || "unknown",
        avatar_url: row.avatar_url,
      },
      messages_remaining: await messagesBalance(row.id),
      fake_purchase_enabled: ALLOW_FAKE_PURCHASE,
      packages_pln: pricingPackagesForClient(),
    });
  })
);

app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    await clearCustomerSession(req, res);
    res.json({ ok: true });
  })
);

app.get(
  "/api/me",
  requireCustomer,
  asyncRoute(async (req, res) => {
    res.json({
      user: {
        id: req.customer.id,
        email: req.customer.email,
        display_name: req.customer.display_name,
        username: req.customer.username,
        first_name: req.customer.first_name,
        birth_date: req.customer.birth_date,
        city: req.customer.city || "",
        gender: req.customer.gender || "",
        has_children: req.customer.has_children || "unknown",
        smokes: req.customer.smokes || "unknown",
        drinks_alcohol: req.customer.drinks_alcohol || "unknown",
        has_car: req.customer.has_car || "unknown",
        avatar_url: req.customer.avatar_url,
      },
      messages_remaining: await messagesBalance(req.customer.id),
      fake_purchase_enabled: ALLOW_FAKE_PURCHASE,
      packages_pln: pricingPackagesForClient(),
      session_idle_minutes: CUSTOMER_SESSION_IDLE_MINUTES,
    });
  })
);

app.patch(
  "/api/me",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const city = String(req.body?.city ?? req.customer.city ?? "").trim();
    const has_children = normalizeTriState(req.body?.has_children ?? req.customer.has_children);
    const smokes = normalizeTriState(req.body?.smokes ?? req.customer.smokes);
    const drinks_alcohol = normalizeTriState(req.body?.drinks_alcohol ?? req.customer.drinks_alcohol);
    const has_car = normalizeTriState(req.body?.has_car ?? req.customer.has_car);
    const avatar_url = String(req.body?.avatar_url ?? "").trim() || req.customer.avatar_url || null;
    if (city.length > 0 && (city.length < 2 || city.length > 80)) {
      return res.status(400).json({ error: "Miasto: opcjonalne; jeśli podasz — 2–80 znaków." });
    }
    if (avatar_url) {
      if (avatar_url.startsWith("data:image/")) {
        if (avatar_url.length > 450000) {
          return res.status(400).json({ error: "Zdjęcie profilowe jest za duże (max ok. 400 KB)." });
        }
      } else if (avatar_url.length > 2000) {
        return res.status(400).json({ error: "Nieprawidłowy adres zdjęcia." });
      }
    }
    await db
      .prepare(`UPDATE users SET city = ?, has_children = ?, smokes = ?, drinks_alcohol = ?, has_car = ?, avatar_url = ? WHERE id = ?`)
      .run(city, has_children, smokes, drinks_alcohol, has_car, avatar_url, req.customer.id);
    req.customer.city = city;
    req.customer.has_children = has_children;
    req.customer.smokes = smokes;
    req.customer.drinks_alcohol = drinks_alcohol;
    req.customer.has_car = has_car;
    req.customer.avatar_url = avatar_url;
    res.json({
      user: {
        id: req.customer.id,
        email: req.customer.email,
        display_name: req.customer.display_name,
        username: req.customer.username,
        first_name: req.customer.first_name,
        birth_date: req.customer.birth_date,
        city,
        gender: req.customer.gender || "",
        has_children,
        smokes,
        drinks_alcohol,
        has_car,
        avatar_url,
      },
    });
  })
);

app.post(
  "/api/me/change-password",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const current_password = String(req.body?.current_password || "");
    const new_password = String(req.body?.new_password || "");
    if (new_password.length < 8) {
      return res.status(400).json({ error: "Nowe hasło musi mieć co najmniej 8 znaków." });
    }
    if (!passwordStrongOk(new_password)) {
      return res.status(400).json({
        error: "Nowe hasło musi zawierać co najmniej jedną wielką literę, jedną cyfrę i jeden znak specjalny.",
      });
    }
    const row = await db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.customer.id);
    const ok = row?.password_hash ? bcrypt.compareSync(current_password, row.password_hash) : false;
    if (!ok) return res.status(400).json({ error: "Aktualne hasło jest nieprawidłowe." });
    const nextHash = bcrypt.hashSync(new_password, 12);
    await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(nextHash, req.customer.id);
    res.json({ ok: true });
  })
);

app.post(
  "/api/me/request-email-change",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const newEmail = String(req.body?.new_email || "").trim().toLowerCase();
    if (!emailOk(newEmail)) return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
    if (newEmail === String(req.customer.email || "").toLowerCase()) {
      return res.status(400).json({ error: "Nowy e-mail musi być inny od obecnego." });
    }
    const exists = await db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(newEmail);
    if (exists) return res.status(409).json({ error: "Ten adres e-mail jest już zajęty." });
    if (!isMailConfigured()) {
      return res.status(503).json({ error: "Brak konfiguracji wysyłki e-mail na serwerze." });
    }
    const token = tokenBytes();
    const exp = new Date(Date.now() + mailVerificationTtlMs()).toISOString();
    await db
      .prepare(
        `UPDATE users
         SET pending_email_change = ?, email_verification_token = ?, email_verification_expires_at = ?
         WHERE id = ?`
      )
      .run(newEmail, token, exp, req.customer.id);
    const confirmUrl = `${publicBaseUrl()}/api/auth/confirm-email-change?token=${encodeURIComponent(token)}`;
    await sendEmailChangeConfirmation({
      to: newEmail,
      confirmUrl,
      displayName: req.customer.first_name || req.customer.display_name || "użytkowniku",
    });
    res.json({ ok: true, sent: true });
  })
);

app.get("/api/public/pricing", (_req, res) => {
  res.json({ packages: pricingPackagesForClient(), currency: APP_CONFIG.pricing.currency });
});

app.get("/api/public/site-config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    operator_panel_path: OPERATOR_PANEL_PATH,
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

app.post("/api/public/contact", asyncRoute(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const message = String(req.body?.message || "").trim();
  const company = String(req.body?.company || "").trim(); // honeypot
  if (company) return res.status(400).json({ error: "Nieprawidłowe dane formularza." });
  if (!name || name.length < 2 || name.length > 120) {
    return res.status(400).json({ error: "Podaj poprawne imię lub nazwę (2-120 znaków)." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  }
  if (!message || message.length < 10 || message.length > 3000) {
    return res.status(400).json({ error: "Wiadomość powinna mieć od 10 do 3000 znaków." });
  }
  const to = String(process.env.CONTACT_FORM_TO || "noreply@localhost").trim() || "noreply@localhost";
  const subject = `Formularz kontaktowy: ${name}`;
  const text =
    `Nowe zgłoszenie z formularza kontaktowego.\n\n` +
    `Nadawca: ${name}\n` +
    `E-mail: ${email}\n\n` +
    `Wiadomość:\n${message}\n`;
  if (isMailConfigured()) {
    await sendOperatorEmailToUser({ to, subject, text });
    return res.json({ ok: true, delivered: true });
  }
  console.warn("[contact-form] Mail nie jest skonfigurowany. Zgłoszenie nie zostało wysłane.", {
    to,
    name,
    email,
    preview: message.slice(0, 140),
  });
  res.json({ ok: true, delivered: false });
}));

app.get("/api/public/payments-config", (_req, res) => {
  res.json({
    p24: {
      enabled: isP24Configured(),
      sandbox: P24_SANDBOX,
      currency: APP_CONFIG.pricing.currency,
    },
  });
});

app.get("/api/public/promo/bootstrap", asyncRoute(async (req, res) => {
  const cfg = promoConfigPublic();
  if (!cfg.enabled) {
    return res.json({ enabled: false, popup_enabled: false, campaign: null });
  }
  const key = normalizePromoKey(req.query.campaign || req.query.camp || req.query.ref || "");
  if (!key) {
    return res.json({ enabled: true, popup_enabled: cfg.popup_enabled, campaign: null });
  }
  const row = await db
    .prepare(
      `SELECT id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email,
              code_prefix, max_codes, total_claimed
       FROM promo_campaigns WHERE campaign_key = ?`
    )
    .get(key);
  if (!row || !promoIsActiveNow(row)) {
    return res.json({ enabled: true, popup_enabled: cfg.popup_enabled, campaign: null });
  }
  res.json({
    enabled: true,
    popup_enabled: cfg.popup_enabled,
    campaign: {
      key: row.campaign_key,
      label: row.label,
      discount_percent: Number(row.discount_percent || 0),
      capture_email: Number(row.capture_email || 0) === 1,
      end_at: row.end_at || null,
    },
  });
}));

app.post("/api/public/promo/claim-code", asyncRoute(async (req, res) => {
  if (!PROMO_SYSTEM_ENABLED) {
    return res.status(404).json({ error: "Promocje są obecnie wyłączone." });
  }
  const key = normalizePromoKey(req.body?.campaign_key || req.body?.campaign || "");
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!key) return res.status(400).json({ error: "Brak kampanii promocyjnej." });
  let result = null;
  await db.transaction(async (tx) => {
    const campaign = await tx
      .prepare(
        `SELECT id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email,
                code_prefix, max_codes, total_claimed
         FROM promo_campaigns WHERE campaign_key = ?`
      )
      .get(key);
    if (!campaign || !promoIsActiveNow(campaign)) {
      throw Object.assign(new Error("Ta promocja nie jest aktywna."), { status: 404 });
    }
    if (Number(campaign.capture_email || 0) === 1 && !emailOk(email)) {
      throw Object.assign(new Error("Podaj poprawny e-mail, aby odebrać kod."), { status: 400 });
    }
    const maxCodes = Number(campaign.max_codes || 0);
    const totalClaimed = Number(campaign.total_claimed || 0);
    if (maxCodes > 0 && totalClaimed >= maxCodes) {
      throw Object.assign(new Error("Limit kodów dla tej kampanii został wyczerpany."), { status: 409 });
    }
    let code = "";
    for (let i = 0; i < 6; i++) {
      const candidate = buildPromoCode(campaign.code_prefix);
      const exists = await tx.prepare(`SELECT id FROM promo_codes WHERE code = ?`).get(candidate);
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) throw Object.assign(new Error("Nie udało się wygenerować kodu rabatowego."), { status: 500 });
    const cid = uuidv4();
    const expiresAt = campaign.end_at ? String(campaign.end_at) : null;
    await tx
      .prepare(
        `INSERT INTO promo_codes (id, campaign_id, email, code, status, claimed_at, expires_at, meta_json)
         VALUES (?, ?, ?, ?, 'claimed', datetime('now'), ?, ?)`
      )
      .run(
        cid,
        campaign.id,
        email || null,
        code,
        expiresAt,
        JSON.stringify({ source: "public_popup" })
      );
    await tx
      .prepare(`UPDATE promo_campaigns SET total_claimed = COALESCE(total_claimed, 0) + 1 WHERE id = ?`)
      .run(campaign.id);
    result = {
      code,
      campaign: campaign.campaign_key,
      discount_percent: Number(campaign.discount_percent || 0),
      expires_at: expiresAt,
    };
  }).catch((e) => {
    throw e;
  });
  res.json({ ok: true, ...result });
}));

app.post(
  "/api/test/purchase",
  requireCustomer,
  asyncRoute(async (req, res) => {
    if (!ALLOW_FAKE_PURCHASE) {
      return res.status(403).json({ error: "Tryb testowego zakupu jest wyłączony." });
    }
    const amount = Number(req.body?.amount);
    if (!PKG_AMOUNTS.has(amount)) {
      return res.status(400).json({ error: "Dozwolone pakiety: 10, 20, 50 lub 100 wiadomości." });
    }
    const id = uuidv4();
    await db
      .prepare(
        "INSERT INTO ledger (id, user_id, delta, reason) VALUES (?, ?, ?, ?)"
      )
      .run(id, req.customer.id, amount, `fake_purchase:${amount}`);
    res.json({
      ok: true,
      added: amount,
      messages_remaining: await messagesBalance(req.customer.id),
    });
  })
);

app.post(
  "/api/payments/p24/create",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!PKG_AMOUNTS.has(amount)) {
      return res.status(400).json({ error: "Dozwolone pakiety: 10, 20, 50 lub 100 wiadomości." });
    }
    if (!isP24Configured()) {
      return res.status(503).json({
        error:
          "Płatności Przelewy24 nie są jeszcze skonfigurowane. Uzupełnij zmienne P24_* i włącz P24_ENABLED=true.",
      });
    }
    const txId = uuidv4();
    const txSession = `p24-${Date.now()}-${txId.slice(0, 8)}`;
    const pkg = pricingPackagesForClient().find((p) => Number(p.amount) === amount);
    const pricePln = Number(pkg?.price_pln || 0);
    const amountGro = Math.round(pricePln * 100);
    await db
      .prepare(
        `INSERT INTO payment_transactions (
          id, user_id, gateway, external_id, amount, currency, status, package_amount, payload_json
        ) VALUES (?, ?, 'p24', ?, ?, ?, 'created', ?, ?)`
      )
      .run(
        txId,
        req.customer.id,
        txSession,
        amountGro,
        APP_CONFIG.pricing.currency,
        amount,
        JSON.stringify({
          amount_messages: amount,
          amount_pln: pricePln,
          sandbox: P24_SANDBOX,
          not_implemented: true,
        })
      );
    return res.status(501).json({
      error:
        "Szkielet P24 jest gotowy, ale finalna rejestracja transakcji i callback nie są jeszcze podpięte. Wdrożymy to po utworzeniu konta P24.",
      tx_id: txId,
      session_id: txSession,
      amount_messages: amount,
      amount_grosze: amountGro,
    });
  })
);

app.post(
  "/api/payments/p24/webhook",
  asyncRoute(async (req, res) => {
    if (!isP24Configured()) {
      return res.status(503).json({ error: "P24 nie jest skonfigurowane." });
    }
    const sessionId = String(req.body?.p24_session_id || req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "Brak p24_session_id." });
    const tx = await db
      .prepare(`SELECT id, status FROM payment_transactions WHERE gateway = 'p24' AND external_id = ?`)
      .get(sessionId);
    if (!tx) return res.status(404).json({ error: "Nie znaleziono transakcji." });
    await db
      .prepare(
        `UPDATE payment_transactions
         SET status = ?, updated_at = datetime('now'),
             payload_json = ?
         WHERE id = ?`
      )
      .run("webhook_received", JSON.stringify(req.body || {}), tx.id);
    res.json({ ok: true, status: "webhook_received", tx_id: tx.id });
  })
);

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8");
  if (!SEO_INDEXABLE) {
    return res.send("User-agent: *\nDisallow: /\n");
  }
  const base = publicBaseUrl();
  const sitemapUrl = `${base}/sitemap.xml`;
  res.send(`User-agent: *\nAllow: /\nSitemap: ${sitemapUrl}\n`);
});

app.get("/sitemap.xml", (_req, res) => {
  if (!SEO_INDEXABLE) {
    return res.status(404).type("application/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset/>");
  }
  const base = publicBaseUrl();
  const urls = [
    "/",
    "/o-nas.html",
    "/kontakt.html",
    "/nota-prawna.html",
    "/informacje-ceny.html",
    "/regulamin.html",
    "/polityka-prywatnosci.html",
    "/polityka-cookies.html",
    "/rekrutacja.html",
    "/logowanie.html",
    "/rejestracja.html",
    "/panel-doladowanie.html",
  ];
  const now = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      (u) =>
        `  <url><loc>${base}${u}</loc><lastmod>${now}</lastmod><changefreq>weekly</changefreq><priority>${
          u === "/" ? "1.0" : "0.6"
        }</priority></url>`
    )
    .join("\n")}\n</urlset>`;
  res.type("application/xml").send(xml);
});

app.get(
  "/api/characters",
  asyncRoute(async (_req, res) => {
    const rows = await db
      .prepare(
        `SELECT id, name, tagline, category, portrait_url, gender, skills, about,
              typical_hours_from, typical_hours_to
       FROM characters ORDER BY sort_order ASC, name ASC`
      )
      .all();
    res.json({ characters: rows });
  })
);

app.get(
  "/api/characters/:id",
  asyncRoute(async (req, res) => {
    const id = String(req.params.id || "").trim();
    const row = await db
      .prepare(
        `SELECT id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to
       FROM characters WHERE id = ?`
      )
      .get(id);
    if (!row) return res.status(404).json({ error: "Nie znaleziono konsultanta." });
    res.json({ character: row });
  })
);

app.get(
  "/api/threads",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT t.id AS thread_id, t.character_id, c.name AS character_name, c.category,
              t.created_at AS thread_started_at,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.sender FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              t.client_hidden_at
       FROM threads t
       JOIN characters c ON c.id = t.character_id
       WHERE t.user_id = ?
       ORDER BY COALESCE(
         (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1),
         t.created_at
       ) DESC`
      )
      .all(req.customer.id);
    res.json({ threads: rows });
  })
);

app.patch(
  "/api/threads/:characterId/client-visibility",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const characterId = req.params.characterId;
    const hidden = !!req.body?.hidden;
    const row = await db
      .prepare(
        `SELECT t.id FROM threads t
       WHERE t.user_id = ? AND t.character_id = ?`
      )
      .get(req.customer.id, characterId);
    if (!row) return res.status(404).json({ error: "Nie znaleziono rozmowy." });
    const ts = hidden ? new Date().toISOString() : null;
    await db.prepare(`UPDATE threads SET client_hidden_at = ? WHERE id = ?`).run(ts, row.id);
    res.json({ ok: true, thread_id: row.id, client_hidden_at: ts });
  })
);

async function getOrCreateThread(userId, characterId) {
  const ch = await db.prepare("SELECT id FROM characters WHERE id = ?").get(characterId);
  if (!ch) return null;
  let t = await db
    .prepare("SELECT id FROM threads WHERE user_id = ? AND character_id = ?")
    .get(userId, characterId);
  if (!t) {
    const tid = uuidv4();
    await db.prepare("INSERT INTO threads (id, user_id, character_id) VALUES (?, ?, ?)").run(
      tid,
      userId,
      characterId
    );
    t = { id: tid };
  }
  return t.id;
}

app.get(
  "/api/threads/:characterId/messages",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const characterId = req.params.characterId;
    const threadId = await getOrCreateThread(req.customer.id, characterId);
    if (!threadId) return res.status(404).json({ error: "Nie znaleziono tej osoby w katalogu." });
    const msgs = await db
      .prepare(
        `SELECT id, sender, body, created_at FROM messages WHERE thread_id = ? ORDER BY datetime(created_at) ASC`
      )
      .all(threadId);
    res.json({
      thread_id: threadId,
      character_id: characterId,
      messages: msgs,
      messages_remaining: await messagesBalance(req.customer.id),
    });
  })
);

app.post(
  "/api/threads/:characterId/messages",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const characterId = req.params.characterId;
    const body = String(req.body?.body || "").trim();
    if (body.length < 1 || body.length > 4000) {
      return res.status(400).json({ error: "Treść wiadomości: 1–4000 znaków." });
    }
    const bal = await messagesBalance(req.customer.id);
    if (bal < 1) {
      return res.status(402).json({
        error: "Nie masz dostępnych wiadomości. Wybierz pakiet w panelu.",
        messages_remaining: bal,
      });
    }
    const threadId = await getOrCreateThread(req.customer.id, characterId);
    if (!threadId) return res.status(404).json({ error: "Nie znaleziono tej osoby w katalogu." });

    const msgId = uuidv4();
    const ledId = uuidv4();
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          "INSERT INTO messages (id, thread_id, sender, body) VALUES (?, ?, 'user', ?)"
        )
        .run(msgId, threadId, body);
      await tx
        .prepare(
          "INSERT INTO ledger (id, user_id, delta, reason) VALUES (?, ?, -1, ?)"
        )
        .run(ledId, req.customer.id, `user_message:${threadId}`);
    });

    await onClientMessage(db, threadId);

    res.json({
      ok: true,
      message: await db
        .prepare("SELECT id, sender, body, created_at FROM messages WHERE id = ?")
        .get(msgId),
      messages_remaining: await messagesBalance(req.customer.id),
    });
  })
);

/** --- Operator: logowanie i praca na wątkach --- */

app.post(
  "/api/op/auth/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const row = await db
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
    await setOperatorSession(res, row.id);
    res.json({
      operator: {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        role: row.role,
      },
    });
  })
);

app.post(
  "/api/op/auth/logout",
  asyncRoute(async (req, res) => {
    await clearOperatorSession(req, res);
    res.json({ ok: true });
  })
);

app.get(
  "/api/op/me",
  requireOperator,
  asyncRoute(async (req, res) => {
    const row = await db
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
    const openRep = await db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get();
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
  })
);

app.patch(
  "/api/op/me/password",
  requireOperator,
  asyncRoute(async (req, res) => {
    const current_password = String(req.body?.current_password || "");
    const new_password = String(req.body?.new_password || "");
    if (new_password.length < 8) {
      return res.status(400).json({ error: "Nowe hasło musi mieć co najmniej 8 znaków." });
    }
    const row = await db.prepare("SELECT id, password_hash FROM operators WHERE id = ?").get(req.operator.id);
    if (!row) {
      return res.status(404).json({ error: "Nie znaleziono konta operatora." });
    }
    if (!bcrypt.compareSync(current_password, row.password_hash)) {
      return res.status(401).json({ error: "Aktualne hasło jest nieprawidłowe." });
    }
    if (bcrypt.compareSync(new_password, row.password_hash)) {
      return res.status(400).json({ error: "Nowe hasło musi różnić się od obecnego." });
    }
    const nextHash = bcrypt.hashSync(new_password, 12);
    await db.prepare("UPDATE operators SET password_hash = ? WHERE id = ?").run(nextHash, req.operator.id);
    await db.prepare("DELETE FROM operator_sessions WHERE operator_id = ? AND token <> ?").run(
      req.operator.id,
      String(req.cookies[COOKIE_OPERATOR] || "")
    );
    res.json({ ok: true });
  })
);

app.patch(
  "/api/op/me/payout",
  requireOperator,
  asyncRoute(async (req, res) => {
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
    await db
      .prepare(
        `UPDATE operators SET
      payout_first_name = ?, payout_last_name = ?, payout_address_line = ?, payout_city = ?,
      payout_postal_code = ?, payout_country = ?, payout_iban = ?, payout_frequency = ?
     WHERE id = ?`
      )
      .run(first_name, last_name, address_line, city, postal_code, country, iban, frequency || null, req.operator.id);
    res.json({ ok: true });
  })
);

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

app.get(
  "/api/op/promo/campaigns",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    if (!PROMO_SYSTEM_ENABLED) {
      return res.status(404).json({ error: "Moduł promocji jest wyłączony (PROMO_SYSTEM_ENABLED=false)." });
    }
    const rows = await db
      .prepare(
        `SELECT id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email,
                code_prefix, max_codes, total_claimed, created_at
         FROM promo_campaigns ORDER BY datetime(created_at) DESC`
      )
      .all();
    res.json({ campaigns: rows, popup_enabled: promoConfigPublic().popup_enabled });
  })
);

app.post(
  "/api/op/promo/campaigns",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    if (!PROMO_SYSTEM_ENABLED) {
      return res.status(404).json({ error: "Moduł promocji jest wyłączony (PROMO_SYSTEM_ENABLED=false)." });
    }
    const campaign_key = normalizePromoKey(req.body?.campaign_key || req.body?.key || "");
    const label = String(req.body?.label || "").trim();
    const discount_percent = Math.max(0, Math.min(100, Number(req.body?.discount_percent || 0) || 0));
    const start_at = String(req.body?.start_at || "").trim() || null;
    const end_at = String(req.body?.end_at || "").trim() || null;
    const is_active = req.body?.is_active ? 1 : 0;
    const capture_email = req.body?.capture_email ? 1 : 0;
    const code_prefix =
      String(req.body?.code_prefix || "SZEPT")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 10) || "SZEPT";
    const max_codes = Math.max(0, Math.floor(Number(req.body?.max_codes || 0) || 0));
    if (!campaign_key || !label) {
      return res.status(400).json({ error: "Podaj campaign_key i label." });
    }
    if (start_at && Number.isNaN(new Date(start_at).getTime())) {
      return res.status(400).json({ error: "Nieprawidłowe start_at (ISO date/time)." });
    }
    if (end_at && Number.isNaN(new Date(end_at).getTime())) {
      return res.status(400).json({ error: "Nieprawidłowe end_at (ISO date/time)." });
    }
    const id = uuidv4();
    await db
      .prepare(
        `INSERT INTO promo_campaigns (
          id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email, code_prefix, max_codes, total_claimed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email, code_prefix, max_codes);
    const row = await db
      .prepare(
        `SELECT id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email,
                code_prefix, max_codes, total_claimed, created_at
         FROM promo_campaigns WHERE id = ?`
      )
      .get(id);
    res.status(201).json({ ok: true, campaign: row });
  })
);

app.get(
  "/api/op/promo/stats",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    if (!PROMO_SYSTEM_ENABLED) {
      return res.status(404).json({ error: "Moduł promocji jest wyłączony (PROMO_SYSTEM_ENABLED=false)." });
    }
    const campaigns = await db
      .prepare(
        `SELECT id, campaign_key, label, discount_percent, start_at, end_at, is_active, capture_email,
                code_prefix, max_codes, total_claimed, created_at
         FROM promo_campaigns ORDER BY datetime(created_at) DESC`
      )
      .all();
    const out = [];
    for (const c of campaigns) {
      const agg = await db
        .prepare(
          `SELECT COUNT(*) AS generated,
                  SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used,
                  SUM(CASE WHEN email IS NOT NULL AND trim(email) <> '' THEN 1 ELSE 0 END) AS with_email
           FROM promo_codes WHERE campaign_id = ?`
        )
        .get(c.id);
      out.push({
        ...c,
        generated: Number(agg?.generated || 0),
        used: Number(agg?.used || 0),
        with_email: Number(agg?.with_email || 0),
      });
    }
    res.json({ campaigns: out });
  })
);

function validateImageLikeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("data:image/")) {
    if (value.length > 900000) throw new Error("Obraz jest za duży do zapisania.");
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    if (value.length > 2000) throw new Error("Adres obrazu jest zbyt długi.");
    return value;
  }
  throw new Error("Podaj poprawny adres obrazu lub data URL.");
}

app.get(
  "/api/op/assets",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    const assets = await db
      .prepare(
        `SELECT id, kind, label, image_url, notes, datetime(created_at) AS created_at, datetime(updated_at) AS updated_at
         FROM marketing_assets ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`
      )
      .all();
    res.json({ assets });
  })
);

app.post(
  "/api/op/assets",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const label = String(req.body?.label || "").trim();
    const kind = String(req.body?.kind || "ad").trim().toLowerCase();
    const notes = String(req.body?.notes || "").trim().slice(0, 1000);
    if (!label || label.length > 120) {
      return res.status(400).json({ error: "Etykieta assetu jest wymagana (1-120 znaków)." });
    }
    if (!new Set(["ad", "medium", "other"]).has(kind)) {
      return res.status(400).json({ error: "Kind assetu: ad, medium albo other." });
    }
    let image_url = "";
    try {
      image_url = validateImageLikeUrl(req.body?.image_url);
    } catch (e) {
      return res.status(400).json({ error: e.message || "Nieprawidłowy obraz." });
    }
    const id = uuidv4();
    await db
      .prepare(
        `INSERT INTO marketing_assets (id, kind, label, image_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(id, kind, label, image_url, notes || null);
    const asset = await db
      .prepare(
        `SELECT id, kind, label, image_url, notes, datetime(created_at) AS created_at, datetime(updated_at) AS updated_at
         FROM marketing_assets WHERE id = ?`
      )
      .get(id);
    res.status(201).json({ ok: true, asset });
  })
);

app.delete(
  "/api/op/assets/:assetId",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const assetId = String(req.params.assetId || "").trim();
    const existing = await db.prepare(`SELECT id FROM marketing_assets WHERE id = ?`).get(assetId);
    if (!existing) return res.status(404).json({ error: "Nie znaleziono assetu." });
    await db.prepare(`DELETE FROM marketing_assets WHERE id = ?`).run(assetId);
    res.json({ ok: true });
  })
);

app.get(
  "/api/op/characters",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    const characters = await db
      .prepare(
        `SELECT id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to
         FROM characters ORDER BY sort_order ASC, name ASC`
      )
      .all();
    res.json({ characters });
  })
);

app.patch(
  "/api/op/characters/:characterId",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const characterId = String(req.params.characterId || "").trim();
    const current = await db
      .prepare(
        `SELECT id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to
         FROM characters WHERE id = ?`
      )
      .get(characterId);
    if (!current) return res.status(404).json({ error: "Nie znaleziono medium." });
    const name = String(req.body?.name ?? current.name).trim();
    const tagline = String(req.body?.tagline ?? current.tagline).trim();
    const category = String(req.body?.category ?? current.category).trim();
    const gender = String(req.body?.gender ?? current.gender ?? "").trim();
    const skills = String(req.body?.skills ?? current.skills ?? "").trim();
    const about = String(req.body?.about ?? current.about ?? "").trim();
    const typical_hours_from = String(req.body?.typical_hours_from ?? current.typical_hours_from ?? "").trim() || null;
    const typical_hours_to = String(req.body?.typical_hours_to ?? current.typical_hours_to ?? "").trim() || null;
    if (!name || name.length > 120) return res.status(400).json({ error: "Nazwa medium: 1-120 znaków." });
    if (!tagline || tagline.length > 220) return res.status(400).json({ error: "Krótki opis: 1-220 znaków." });
    if (!category || category.length > 40) return res.status(400).json({ error: "Kategoria medium jest wymagana." });
    let portrait_url = String(current.portrait_url || "").trim() || null;
    try {
      if (req.body?.portrait_url != null) portrait_url = validateImageLikeUrl(req.body?.portrait_url) || null;
    } catch (e) {
      return res.status(400).json({ error: e.message || "Nieprawidłowy obraz medium." });
    }
    await db
      .prepare(
        `UPDATE characters
         SET name = ?, tagline = ?, category = ?, portrait_url = ?, gender = ?, skills = ?, about = ?,
             typical_hours_from = ?, typical_hours_to = ?
         WHERE id = ?`
      )
      .run(name, tagline, category, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to, characterId);
    const character = await db
      .prepare(
        `SELECT id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to
         FROM characters WHERE id = ?`
      )
      .get(characterId);
    res.json({ ok: true, character });
  })
);

app.get(
  "/api/op/staff",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    const rows = await db
      .prepare(
        `SELECT id, email, display_name, role, datetime(created_at) AS created_at, disabled_at,
        COALESCE(kyc_status, 'unverified') AS kyc_status
       FROM operators ORDER BY datetime(created_at)`
      )
      .all();
    res.json({ operators: rows });
  })
);

app.patch(
  "/api/op/operators/:operatorId",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const oid = req.params.operatorId;
    if (oid === req.operator.id) {
      return res.status(400).json({ error: "Nie możesz zablokować ani odblokować samego siebie." });
    }
    const target = await db.prepare(`SELECT id, role FROM operators WHERE id = ?`).get(oid);
    if (!target) return res.status(404).json({ error: "Nie znaleziono konta." });
    if (target.role === "owner") {
      return res.status(403).json({ error: "Nie można blokować konta właściciela." });
    }
    const dis = !!req.body?.disabled;
    await db.prepare(`UPDATE operators SET disabled_at = ? WHERE id = ?`).run(dis ? dtNowIso() : null, oid);
    if (dis) await db.prepare(`DELETE FROM operator_sessions WHERE operator_id = ?`).run(oid);
    res.json({ ok: true, disabled: dis });
  })
);

app.post(
  "/api/op/operators/:operatorId/revoke-sessions",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const oid = req.params.operatorId;
    if (oid === req.operator.id) {
      return res.status(400).json({ error: "Nie możesz wylogować własnej sesji tą ścieżką — użyj „Wyloguj”." });
    }
    if (!(await db.prepare(`SELECT id FROM operators WHERE id = ?`).get(oid))) {
      return res.status(404).json({ error: "Nie znaleziono konta." });
    }
    const r = await db.prepare(`DELETE FROM operator_sessions WHERE operator_id = ?`).run(oid);
    res.json({ ok: true, deleted_sessions: r.changes });
  })
);

function dtNowIso() {
  return new Date().toISOString();
}

app.get(
  "/api/op/monitor",
  requireOperator,
  requireOwner,
  asyncRoute(async (_req, res) => {
    await sweepAssignments(db);
    res.json(await getOperatorMonitorSnapshot(db));
  })
);

app.get(
  "/api/op/reports",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const st = String(req.query.status || "open").trim().toLowerCase();
    const where =
      st === "resolved"
        ? `r.status = 'resolved'`
        : st === "all"
          ? `1=1`
          : `r.status = 'open'`;
    const rows = await db
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
    const openCount = (await db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get())
      .c;
    res.json({ reports: rows, open_count: openCount });
  })
);

app.patch(
  "/api/op/reports/:reportId",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const rid = req.params.reportId;
    const status = String(req.body?.status || "").trim().toLowerCase();
    const owner_note = String(req.body?.owner_note ?? "").trim().slice(0, 1000);
    if (status !== "open" && status !== "resolved") {
      return res.status(400).json({ error: "Pole status: open lub resolved." });
    }
    const row = await db.prepare(`SELECT id, thread_id, message_id FROM message_reports WHERE id = ?`).get(rid);
    if (!row) return res.status(404).json({ error: "Nie znaleziono zgłoszenia." });
    if (status === "resolved") {
      await db
        .prepare(
          `UPDATE message_reports SET status = 'resolved', owner_note = ?, resolved_at = datetime('now'),
       resolved_by_operator_id = ? WHERE id = ?`
        )
        .run(owner_note, req.operator.id, rid);
    } else {
      await db
        .prepare(
          `UPDATE message_reports SET status = 'open', resolved_at = NULL, resolved_by_operator_id = NULL
       WHERE id = ?`
        )
        .run(rid);
      if (owner_note) {
        await db.prepare(`UPDATE message_reports SET owner_note = ? WHERE id = ?`).run(owner_note, rid);
      }
    }
    const action = status === "resolved" ? "message_report_resolve" : "message_report_reopen";
    await db
      .prepare(
        `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
     VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        uuidv4(),
        req.operator.id,
        action,
        row.thread_id,
        JSON.stringify({ report_id: rid, message_id: row.message_id })
      );
    const openCount = (await db.prepare(`SELECT COUNT(*) AS c FROM message_reports WHERE status = 'open'`).get())
      .c;
    res.json({ ok: true, open_count: openCount });
  })
);

app.get(
  "/api/op/owner/team-insights",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
    const raw = parseInt(String(req.query.feed_limit || "120"), 10);
    const feedLimit = Number.isFinite(raw) ? Math.min(400, Math.max(40, raw)) : 120;
    const feed = await db
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
    const ranking = await db
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
  })
);

app.post(
  "/api/op/staff",
  requireOperator,
  requireOwner,
  asyncRoute(async (req, res) => {
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
    if (await db.prepare("SELECT id FROM operators WHERE email = ?").get(email)) {
      return res.status(409).json({ error: "Ten e-mail jest już w systemie." });
    }
    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 12);
    await db
      .prepare(
        `INSERT INTO operators (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'staff')`
      )
      .run(id, email, hash, display_name);
    res.status(201).json({
      operator: { id, email, display_name, role: "staff" },
    });
  })
);

function sanitizeFactsForOperator(facts, operator) {
  if (operator.role === "owner") return facts;
  return facts.map((f) => {
    const out = { ...f };
    delete out.created_operator_email;
    return out;
  });
}

app.get("/api/op/inbox", requireOperator, asyncRoute(async (req, res) => {
  await sweepAssignments(db);
  const bucketParam = String(req.query.bucket || "").trim().toLowerCase();
  const bucket = bucketParam || (req.operator.role === "owner" ? "all" : "mine");
  const wh = inboxBucketClause(req.operator, bucket);
  const rows = await db.prepare(
      `SELECT t.id AS thread_id,
              t.assigned_operator_id,
              u.email AS user_email,
              u.display_name AS user_display_name,
              c.id AS character_id,
              c.name AS character_name,
              c.category,
              t.created_at AS thread_started_at,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.sender FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_preview,
              (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              t.client_hidden_at
       FROM threads t
       JOIN users u ON u.id = t.user_id
       JOIN characters c ON c.id = t.character_id
       WHERE ${wh.sql}
       ORDER BY COALESCE(
         (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1),
         t.created_at
       ) DESC
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
}));

app.get("/api/op/clients", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const g = String(req.query.gender || "").trim().toLowerCase();
  const genderFilter = new Set(["female", "male", "other"]);
  if (g && !genderFilter.has(g)) {
    return res.status(400).json({ error: "Filtr płci: female, male, other lub pusty (wszyscy)." });
  }
  let sql = `SELECT u.id, u.email, u.username, u.first_name, u.display_name, u.birth_date, u.city, u.gender, u.has_children, u.smokes, u.drinks_alcohol, u.has_car, u.blocked_at,
              u.email_verified_at,
              u.email_verification_token,
              datetime(u.created_at) AS created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.user_id = u.id) AS thread_count,
              (SELECT COALESCE(SUM(delta), 0) FROM ledger l WHERE l.user_id = u.id) AS messages_balance
       FROM users u`;
  const params = [];
  if (g) {
    sql += ` WHERE u.gender = ?`;
    params.push(g);
  }
  sql += ` ORDER BY datetime(u.created_at) DESC`;
  const rows = await db.prepare(sql).all(...params);
  res.json({ clients: rows });
}));

app.post("/api/op/clients/:clientId/verification-link", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const clientId = String(req.params.clientId || "").trim();
  const regenerate = !!req.body?.regenerate;
  const row = await db.prepare(
      `SELECT id, email, email_verified_at, email_verification_token, email_verification_expires_at
       FROM users WHERE id = ?`
    )
    .get(clientId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono klienta." });
  if (row.email_verified_at) {
    return res.status(400).json({ error: "To konto jest już zweryfikowane." });
  }
  let token = row.email_verification_token;
  let expiresAt = row.email_verification_expires_at;
  if (!token || regenerate) {
    token = tokenBytes();
    expiresAt = new Date(Date.now() + mailVerificationTtlMs()).toISOString();
    await db.prepare(
      `UPDATE users SET email_verification_token = ?, email_verification_expires_at = ? WHERE id = ?`
    ).run(token, expiresAt, clientId);
  }
  const verifyUrl = `${publicBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  res.json({
    ok: true,
    email: row.email,
    verify_url: verifyUrl,
    expires_at: expiresAt || null,
  });
}));

app.patch("/api/op/clients/:clientId/block", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const clientId = String(req.params.clientId || "").trim();
  const blocked = !!req.body?.blocked;
  const row = await db.prepare("SELECT id, email, blocked_at FROM users WHERE id = ?").get(clientId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono klienta." });
  const value = blocked ? dtNowIso() : null;
  await db.prepare("UPDATE users SET blocked_at = ? WHERE id = ?").run(value, clientId);
  if (blocked) {
    await db.prepare("DELETE FROM customer_sessions WHERE user_id = ?").run(clientId);
  }
  res.json({ ok: true, client_id: clientId, blocked_at: value, email: row.email });
}));

app.post("/api/op/clients/:clientId/delete", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const clientId = String(req.params.clientId || "").trim();
  const confirmPhrase = String(req.body?.confirm_phrase || "").trim();
  const ownerPassword = String(req.body?.owner_password || "");
  if (confirmPhrase !== "USUN_KONTO") {
    return res.status(400).json({ error: "Wpisz dokładnie frazę USUN_KONTO, aby potwierdzić usunięcie." });
  }
  if (!ownerPassword) {
    return res.status(400).json({ error: "Podaj hasło właściciela, aby usunąć konto klienta." });
  }
  const op = await db
    .prepare("SELECT id, password_hash FROM operators WHERE id = ?")
    .get(req.operator.id);
  const passOk = op?.password_hash ? bcrypt.compareSync(ownerPassword, op.password_hash) : false;
  if (!passOk) {
    return res.status(403).json({ error: "Nieprawidłowe hasło właściciela." });
  }
  const row = await db
    .prepare("SELECT id, email, username, first_name, display_name FROM users WHERE id = ?")
    .get(clientId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono klienta." });
  await db.prepare("DELETE FROM users WHERE id = ?").run(clientId);
  await db
    .prepare(
      `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      uuidv4(),
      req.operator.id,
      "client_account_delete",
      null,
      JSON.stringify({ client_id: clientId, email: row.email, username: row.username || null })
    );
  res.json({
    ok: true,
    deleted: true,
    client_id: clientId,
    email: row.email,
    display_name: row.first_name || row.display_name || "",
  });
}));

app.post("/api/op/clients/:clientId/email", requireOperator, requireOwner, async (req, res) => {
  if (!isMailConfigured()) {
    return res.status(503).json({
      error: "Brak konfiguracji SMTP (SMTP_USER / SMTP_PASS). Skonfiguruj serwer pocztowy.",
    });
  }
  const clientId = String(req.params.clientId || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const text = String(req.body?.text || "").trim();
  if (subject.length < 1 || subject.length > 200) {
    return res.status(400).json({ error: "Temat: 1–200 znaków." });
  }
  if (text.length < 1 || text.length > 12000) {
    return res.status(400).json({ error: "Treść wiadomości: 1–12 000 znaków." });
  }
  const row = await db.prepare("SELECT id, email FROM users WHERE id = ?").get(clientId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono klienta." });
  try {
    const mailInfo = await sendOperatorEmailToUser({ to: row.email, subject, text });
    console.log("[mail][operator]", {
      to: row.email,
      message_id: mailInfo.messageId,
      accepted: mailInfo.accepted,
      rejected: mailInfo.rejected,
    });
  } catch (e) {
    console.error("[mail] operator to client:", e?.message || e);
    return res.status(502).json({ error: "Nie udało się wysłać wiadomości e-mail." });
  }
  res.json({ ok: true });
});

app.get("/api/op/facts-schema", requireOperator, (_req, res) => {
  res.json(flattenSchemaForApi());
});

app.get("/api/op/stats", requireOperator, asyncRoute(async (req, res) => {
  if (req.operator.role === "owner") {
    return res.json({ role: "owner", stats: null });
  }
  await sweepAssignments(db);
  res.json({ role: "staff", stats: await getOperatorStats(db, req.operator.id) });
}));

app.get("/api/op/staff-dashboard", requireOperator, asyncRoute(async (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({ error: "Ten widok jest tylko dla pracowników." });
  }
  await sweepAssignments(db);
  res.json({ dashboard: await getStaffDashboard(db, req.operator.id) });
}));

app.get("/api/op/me/payout-ledger", requireOperator, asyncRoute(async (req, res) => {
  if (req.operator.role === "owner") {
    return res.json({ entries: [] });
  }
  const rows = await db.prepare(
      `SELECT id, amount_pln, label, period_label, datetime(created_at) AS created_at
       FROM operator_payout_ledger WHERE operator_id = ?
       ORDER BY datetime(created_at) DESC LIMIT 80`
    )
    .all(req.operator.id);
  res.json({ entries: rows });
}));

app.get("/api/op/me/contacts", requireOperator, (req, res) => {
  res.json({
    owner_contact_email: String(process.env.OWNER_CONTACT_EMAIL || "").trim(),
    staff_support_email: String(process.env.STAFF_SUPPORT_EMAIL || "").trim(),
    staff_support_teams_url: String(process.env.STAFF_SUPPORT_TEAMS_URL || "").trim(),
  });
});

app.get("/api/op/audit/:auditId", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const row = await db.prepare(
      `SELECT a.id, a.operator_id, a.action, a.thread_id, a.detail, datetime(a.created_at) AS created_at,
              o.email AS operator_email
       FROM operator_audit a
       JOIN operators o ON o.id = a.operator_id
       WHERE a.id = ?`
    )
    .get(req.params.auditId);
  if (!row) return res.status(404).json({ error: "Nie znaleziono wpisu dziennika." });
  res.json({ audit: row });
}));

app.get("/api/op/queue", requireOperator, asyncRoute(async (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({ error: "Pula anonimowa jest tylko dla pracowników." });
  }
  await sweepAssignments(db);
  res.json({ slots: await getStaffQueueSlots(db, req.operator.id) });
}));

app.post("/api/op/inbox/:threadId/claim", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  const r = await tryClaimThread(db, req.operator, threadId);
  if (!r.ok) return res.status(403).json({ error: r.error });
  res.json({ ok: true, assignment: await getAssignmentPayload(db, threadId, req.operator) });
}));

app.post("/api/op/inbox/:threadId/claim-stopped", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  const r = await tryClaimStoppedThread(db, req.operator, threadId);
  if (!r.ok) return res.status(403).json({ error: r.error });
  res.json({ ok: true, assignment: await getAssignmentPayload(db, threadId, req.operator) });
}));

app.get("/api/op/teaser/targets", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const limRaw = Number(req.query.limit || 80);
  const limit = Number.isFinite(limRaw) ? Math.max(10, Math.min(300, Math.floor(limRaw))) : 80;
  const rows = await db.prepare(
      `SELECT u.id AS user_id, u.first_name, u.display_name, u.username, u.city,
              c.id AS character_id, c.name AS character_name, c.category
       FROM users u
       CROSS JOIN characters c
       WHERE u.blocked_at IS NULL
         AND u.email_verified_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM threads t
           WHERE t.user_id = u.id AND t.character_id = c.id
         )
       ORDER BY datetime(u.created_at) DESC, c.sort_order ASC, c.name ASC
       LIMIT ?`
    )
    .all(limit);
  res.json({
    targets: rows.map((r) => ({
      user_id: r.user_id,
      user_name: r.first_name || r.display_name || r.username || "Klient",
      username: r.username || "",
      city: r.city || "",
      character_id: r.character_id,
      character_name: r.character_name,
      category: r.category || "",
    })),
  });
}));

app.post("/api/op/teaser/send", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const userId = String(req.body?.user_id || "").trim();
  const characterId = String(req.body?.character_id || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!userId || !characterId) {
    return res.status(400).json({ error: "Wybierz klienta i medium." });
  }
  if (body.length < 8 || body.length > 1200) {
    return res.status(400).json({ error: "Treść zaczepki: 8-1200 znaków." });
  }
  const userRow = await db
    .prepare("SELECT id, blocked_at, email_verified_at FROM users WHERE id = ?")
    .get(userId);
  if (!userRow || userRow.blocked_at || !userRow.email_verified_at) {
    return res.status(404).json({ error: "Nie znaleziono aktywnego klienta." });
  }
  const chRow = await db.prepare("SELECT id FROM characters WHERE id = ?").get(characterId);
  if (!chRow) return res.status(404).json({ error: "Nie znaleziono medium." });
  let thread = await db
    .prepare("SELECT id FROM threads WHERE user_id = ? AND character_id = ?")
    .get(userId, characterId);
  if (!thread) {
    const tid = uuidv4();
    await db.prepare("INSERT INTO threads (id, user_id, character_id) VALUES (?, ?, ?)").run(tid, userId, characterId);
    thread = { id: tid };
  }
  const msgId = uuidv4();
  await db
    .prepare("INSERT INTO messages (id, thread_id, sender, body, operator_id) VALUES (?, ?, 'staff', ?, ?)")
    .run(msgId, thread.id, body, req.operator.id);
  await db
    .prepare(
      `INSERT INTO operator_audit (id, operator_id, action, thread_id, detail)
       VALUES (?, ?, 'teaser_send', ?, ?)`
    )
    .run(
      uuidv4(),
      req.operator.id,
      thread.id,
      JSON.stringify({ user_id: userId, character_id: characterId, message_id: msgId })
    );
  res.json({ ok: true, thread_id: thread.id, message_id: msgId });
}));

app.post("/api/op/inbox/:threadId/ai-draft", requireOperator, asyncRoute(async (req, res) => {
  const threadId = String(req.params.threadId || "").trim();
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const provider = pickAiProvider(req.body?.provider);
  if (!provider) {
    return res.status(503).json({
      error: "Brak klucza AI. Ustaw OPENAI_API_KEY i/lub ANTHROPIC_API_KEY w zmiennych środowiskowych.",
    });
  }
  const messageIds = Array.isArray(req.body?.message_ids)
    ? [...new Set(req.body.message_ids.map((x) => String(x || "").trim()).filter(Boolean))]
    : [];
  if (messageIds.length < 1) {
    return res.status(400).json({ error: "Wybierz co najmniej jedną wiadomość do kontekstu." });
  }
  if (messageIds.length > 40) {
    return res.status(400).json({ error: "Maksymalnie 40 wiadomości do jednego szkicu." });
  }
  const promptUser = String(req.body?.prompt || "").trim();
  if (!promptUser) return res.status(400).json({ error: "Podaj własny prompt dla asystenta AI." });
  if (promptUser.length > 5000) {
    return res.status(400).json({ error: "Prompt jest za długi (max 5000 znaków)." });
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const msgs = await db.prepare(
      `SELECT id, sender, body, created_at
       FROM messages
       WHERE thread_id = ? AND id IN (${placeholders})
       ORDER BY datetime(created_at) ASC`
    )
    .all(threadId, ...messageIds);
  if (!msgs.length) {
    return res.status(404).json({ error: "Nie znaleziono wybranych wiadomości w tym wątku." });
  }
  const lines = msgs.map((m) => {
    const who = m.sender === "staff" ? "Konsultant" : "Klient";
    const body = m.sender === "user" ? maskClientNumbersForOperator(m.body) : m.body;
    return `- [${who}] ${String(body || "").trim()}`;
  });
  const finalPrompt = [
    "Na podstawie wybranych wiadomości przygotuj jedną propozycję odpowiedzi do klienta.",
    "Styl: ciepły, konkretny, ludzki. Nie podawaj telefonu/e-maila, nie odsyłaj poza portal.",
    "Zwróć samą gotową odpowiedź, bez nagłówków i bez komentarza meta.",
    "",
    "Wybrane wiadomości:",
    lines.join("\n"),
    "",
    "Własna instrukcja operatora:",
    promptUser,
  ].join("\n");
  const out =
    provider === "anthropic"
      ? await generateDraftWithAnthropic({ prompt: finalPrompt })
      : await generateDraftWithOpenAi({ prompt: finalPrompt });
  res.json({
    ok: true,
    provider,
    model: out.model,
    draft: out.text,
    used_messages: msgs.length,
  });
}));

app.post("/api/op/marketing/generate", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const provider = pickAiProvider(req.body?.provider);
  if (!provider) {
    return res.status(503).json({
      error: "Brak klucza AI. Ustaw OPENAI_API_KEY i/lub ANTHROPIC_API_KEY.",
    });
  }
  const topic = String(req.body?.topic || "").trim();
  const offer = String(req.body?.offer || "").trim();
  const audience = String(req.body?.audience || "").trim();
  const customPrompt = String(req.body?.custom_prompt || "").trim();
  const channels = Array.isArray(req.body?.channels)
    ? [...new Set(req.body.channels.map((x) => String(x || "").trim()).filter(Boolean))]
    : [];
  if (!topic) return res.status(400).json({ error: "Podaj temat kampanii." });
  if (!channels.length) return res.status(400).json({ error: "Wybierz co najmniej jeden kanał reklamowy." });
  const instruction = [
    "Zwróć WYŁĄCZNIE JSON (bez markdown).",
    "Klucz główny: items (tablica).",
    "Każdy element items: channel, title, description, tags (tablica string), visual_prompt.",
    "Język: polski. Styl: marketing ezoteryczny, ale bez obiecywania gwarantowanych rezultatów.",
    "Dla każdego kanału podaj oddzielny wpis.",
    "Tagi bez znaku #, krótkie, praktyczne.",
  ].join(" ");
  const userPrompt = [
    `Kanały: ${channels.join(", ")}`,
    `Temat: ${topic}`,
    `Oferta/CTA: ${offer || "brak dodatkowej oferty"}`,
    `Grupa docelowa: ${audience || "ogólna"}`,
    `Dodatkowy prompt operatora: ${customPrompt || "brak"}`,
  ].join("\n");
  const fullPrompt = `${instruction}\n\n${userPrompt}`;
  const aiOut =
    provider === "anthropic"
      ? await generateDraftWithAnthropic({ prompt: fullPrompt })
      : await generateDraftWithOpenAi({ prompt: fullPrompt });
  const parsed = safeJsonParse(aiOut.text);
  let items = [];
  if (parsed && Array.isArray(parsed.items)) {
    items = parsed.items.map((it, idx) => normalizeMarketingItem(it, channels[idx] || channels[0]));
  } else {
    items = channels.map((ch) =>
      normalizeMarketingItem(
        {
          channel: ch,
          title: `Post reklamowy: ${topic}`,
          description: aiOut.text,
          tags: [],
          visual_prompt: `Grafika promująca temat: ${topic}`,
        },
        ch
      )
    );
  }
  res.json({
    ok: true,
    provider,
    model: aiOut.model,
    items,
  });
}));

app.post("/api/op/marketing/generate-image", requireOperator, requireOwner, asyncRoute(async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const provider = String(req.body?.provider || "free").trim().toLowerCase();
  const size = String(req.body?.size || "1024x1024").trim();
  const apiKey = String(req.body?.api_key || "").trim();
  if (prompt.length < 8 || prompt.length > 4000) {
    return res.status(400).json({ error: "Prompt obrazu: 8-4000 znaków." });
  }
  if (provider === "free") {
    const seed = Math.floor(Date.now() / 1000);
    const [wRaw, hRaw] = size.split("x");
    const w = Math.max(512, Math.min(1536, Number(wRaw) || 1024));
    const h = Math.max(512, Math.min(1536, Number(hRaw) || 1024));
    const freeUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&nologo=true`;
    return res.json({
      ok: true,
      provider: "free",
      model: "pollinations",
      images: [{ url: freeUrl }],
    });
  }
  if (provider !== "openai") {
    return res.status(400).json({ error: "Nieznany provider obrazów. Użyj: free lub openai." });
  }
  const img = await generateImageWithOpenAi({
    prompt,
    size,
    apiKey: apiKey || undefined,
  });
  res.json({
    ok: true,
    provider: "openai",
    model: img.model,
    images: [{ url: img.url }],
  });
}));

app.post("/api/op/inbox/:threadId/touch", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  await bumpStaffActivity(db, threadId, req.operator.id);
  res.json({ ok: true });
}));

app.get("/api/op/inbox/:threadId/messages", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Nie widzisz tego wątku na liście." });
  }
  await bumpStaffActivity(db, threadId, req.operator.id);
  const rawLimit = parseInt(String(req.query.limit || "15"), 10);
  let limitTotal = Number.isFinite(rawLimit) ? rawLimit : 15;
  if (limitTotal < 15) limitTotal = 15;
  if (limitTotal > 500) limitTotal = 500;
  if (limitTotal > 15 && (limitTotal - 15) % 10 !== 0) {
    return res.status(400).json({
      error: "Parametr limit: dozwolone 15, potem 25, 35, 45… (co 10), maks. 500.",
    });
  }
  const raw = await db.prepare(
      `SELECT t.id, u.id AS user_id, u.email AS user_email, u.display_name AS user_display_name,
              u.username AS client_username, u.first_name AS client_first_name,
              u.birth_date AS client_birth_date, u.city AS client_city, u.gender AS client_gender,
              u.has_children AS client_has_children, u.smokes AS client_smokes, u.drinks_alcohol AS client_drinks_alcohol, u.has_car AS client_has_car,
              u.avatar_url AS client_avatar_url, u.blocked_at AS client_blocked_at,
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
    user_id: raw.user_id,
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
      id: raw.user_id,
      username: raw.client_username,
      first_name: raw.client_first_name,
      birth_date: raw.client_birth_date,
      city: raw.client_city || "",
      gender: raw.client_gender || "",
      has_children: raw.client_has_children || "unknown",
      smokes: raw.client_smokes || "unknown",
      drinks_alcohol: raw.client_drinks_alcohol || "unknown",
      has_car: raw.client_has_car || "unknown",
      avatar_url: raw.client_avatar_url,
      blocked_at: raw.client_blocked_at,
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
  const factsRaw = await db.prepare(
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
  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?`)
    .get(threadId);
  const messageTotal = totalRow?.c ?? 0;
  const msgs = await db.prepare(
      `SELECT m.id, m.sender, m.body, m.created_at, m.operator_id,
              op.display_name AS staff_join_display_name, op.email AS staff_join_email
       FROM messages m
       LEFT JOIN operators op ON op.id = m.operator_id
       WHERE m.thread_id = ? ORDER BY datetime(m.created_at) DESC LIMIT ?`
    )
    .all(threadId, limitTotal);
  const isOwner = req.operator.role === "owner";
  const opId = req.operator.id;
  const openRepRows = await db.prepare(`SELECT message_id FROM message_reports WHERE thread_id = ? AND status = 'open'`)
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
    assignment: await getAssignmentPayload(db, threadId, req.operator),
  });
}));

app.post("/api/op/inbox/:threadId/messages/:messageId/report", requireOperator, asyncRoute(async (req, res) => {
  if (req.operator.role === "owner") {
    return res.status(403).json({
      error: "Zgłoszenia zapisuje pracownik z czatu — Ty widzisz je w zakładce „Zgłoszenia”.",
    });
  }
  const threadId = req.params.threadId;
  const messageId = req.params.messageId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const msg = await db.prepare(`SELECT id, thread_id, sender FROM messages WHERE id = ?`)
    .get(messageId);
  if (!msg || msg.thread_id !== threadId) {
    return res.status(404).json({ error: "Nie znaleziono wiadomości." });
  }
  const ex = await db.prepare(`SELECT id FROM message_reports WHERE message_id = ? AND status = 'open'`).get(
    messageId
  );
  if (ex) {
    return res.status(409).json({ error: "Ta wiadomość ma już otwarte zgłoszenie." });
  }
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  const id = uuidv4();
  await db.prepare(
    `INSERT INTO message_reports (id, message_id, thread_id, reporter_operator_id, reason, status)
     VALUES (?, ?, ?, ?, ?, 'open')`
  ).run(id, messageId, threadId, req.operator.id, reason);
  await db.prepare(
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
}));

app.patch("/api/op/inbox/:threadId/facts", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const perm = await assertStaffCanMutate(db, req.operator, threadId);
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
  const th = await db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!th) return res.status(404).json({ error: "Nie znaleziono wątku." });
  if (value.length > FACT_VALUE_MAX_LEN) {
    return res.status(400).json({ error: `Wartość: maks. ${FACT_VALUE_MAX_LEN} znaków.` });
  }

  const loadFactOut = async (id) =>
    await db.prepare(
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
    const delRow = await db.prepare(
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
    await db.prepare(`DELETE FROM thread_facts WHERE id = ?`).run(factId);
    await db.prepare(
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
    await bumpStaffActivity(db, threadId, req.operator.id);
    return res.json({ ok: true, deleted: true });
  }

  if (factId) {
    return res.status(400).json({
      error: "Notatek się nie nadpisuje — usuń stary wpis (×) i dodaj nowy.",
    });
  }

  const slotRow = await db.prepare(
      `SELECT COALESCE(MAX(slot), -1) + 1 AS s FROM thread_facts WHERE thread_id = ? AND scope = ? AND category = ? AND field = ?`
    )
    .get(threadId, scope, category, field);
  const slot = Number(slotRow?.s ?? 0);
  const newId = uuidv4();
  await db.prepare(
    `INSERT INTO thread_facts (id, thread_id, scope, category, field, slot, value, updated_at, created_operator_id, updated_operator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
  ).run(newId, threadId, scope, category, field, slot, value, req.operator.id, req.operator.id);
  await db.prepare(
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
  await bumpStaffActivity(db, threadId, req.operator.id);
  const outRow = await loadFactOut(newId);
  const factOut = sanitizeFactsForOperator(outRow ? [outRow] : [], req.operator)[0] || outRow;
  res.json({ ok: true, fact: factOut });
}));

app.patch("/api/op/inbox/:threadId/notes", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
    return res.status(403).json({ error: "Brak dostępu do tego wątku." });
  }
  const perm = await assertStaffCanMutate(db, req.operator, threadId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const notes = String(req.body?.notes ?? "");
  if (notes.length > 32000) {
    return res.status(400).json({ error: "Notatki: maks. 32 000 znaków." });
  }
  const info = await db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!info) return res.status(404).json({ error: "Nie znaleziono wątku." });
  await db.prepare("UPDATE threads SET internal_notes = ? WHERE id = ?").run(notes, threadId);
  await bumpStaffActivity(db, threadId, req.operator.id);
  res.json({ ok: true, internal_notes: notes });
}));

app.post("/api/op/inbox/:threadId/reply", requireOperator, asyncRoute(async (req, res) => {
  const threadId = req.params.threadId;
  if (!(await threadVisibleToOperator(db, threadId, req.operator.id, req.operator.role))) {
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
  const th = await db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!th) return res.status(404).json({ error: "Nie znaleziono wątku." });
  const perm = await ensureReplyPermission(db, req.operator, threadId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const msgId = uuidv4();
  await db.prepare(
    "INSERT INTO messages (id, thread_id, sender, body, operator_id) VALUES (?, ?, 'staff', ?, ?)"
  ).run(msgId, threadId, body, req.operator.id);
  await bumpStaffActivity(db, threadId, req.operator.id);
  await onStaffReply(db, threadId, req.operator);
  const msg = await db.prepare("SELECT id, sender, body, created_at, operator_id FROM messages WHERE id = ?")
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
    assignment: await getAssignmentPayload(db, threadId, req.operator),
  });
}));

app.use(OPERATOR_PANEL_PATH, express.static(path.join(__dirname, "public", "op-panel")));
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const st =
    typeof err.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (String(req.path || "").startsWith("/api")) {
    return res.status(st).json({ error: err.message || "Błąd serwera." });
  }
  res.status(st).send("Internal Server Error");
});

app.listen(PORT, () => {
  console.log(`Portal klienta:  http://localhost:${PORT}/`);
  console.log(`Panel pracy:     http://localhost:${PORT}${OPERATOR_PANEL_PATH}/`);
  console.log(`Testowy zakup:   ${ALLOW_FAKE_PURCHASE ? "włączony" : "wyłączony"}`);
});
