import nodemailer from "nodemailer";

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function publicBaseUrl() {
  const raw =
    process.env.PUBLIC_BASE_URL || process.env.APP_URL || `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
  return String(raw).replace(/\/$/, "");
}

export function isMailConfigured() {
  return !!(String(process.env.SMTP_USER || "").trim() && String(process.env.SMTP_PASS || "").trim());
}

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function createMailTransporter() {
  if (!isMailConfigured()) return null;
  const provider = String(process.env.SMTP_PROVIDER || "").trim().toLowerCase();
  const defaults = provider === "brevo"
    ? { host: "smtp-relay.brevo.com", port: 587 }
    : { host: "smtp.gmail.com", port: 465 };
  const host = String(process.env.SMTP_HOST || defaults.host).trim();
  const port = Number(process.env.SMTP_PORT || defaults.port);
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    String(process.env.SMTP_SECURE || "").toLowerCase() === "1" ||
    port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    connectionTimeout: envMs("SMTP_CONNECTION_TIMEOUT_MS", 10000),
    greetingTimeout: envMs("SMTP_GREETING_TIMEOUT_MS", 10000),
    socketTimeout: envMs("SMTP_SOCKET_TIMEOUT_MS", 15000),
    auth: {
      user: String(process.env.SMTP_USER || "").trim(),
      pass: String(process.env.SMTP_PASS || "").trim(),
    },
  });
}

function mailFrom() {
  const f = String(process.env.MAIL_FROM || process.env.SMTP_USER || "").trim();
  return f || "noreply@localhost";
}

export async function sendVerificationEmail({ to, verifyUrl, displayName }) {
  const t = createMailTransporter();
  if (!t) throw new Error("Brak konfiguracji SMTP (SMTP_USER / SMTP_PASS).");
  const name = displayName || "użytkowniku";
  const info = await t.sendMail({
    from: mailFrom(),
    to,
    subject: "Potwierdź adres e-mail — Szept Kart",
    text: `Cześć ${name},\n\nOtwórz link, aby potwierdzić konto:\n${verifyUrl}\n\nLink jest ważny 48 godzin.\n`,
    html: `<p>Cześć ${escapeHtml(name)},</p><p><a href="${verifyUrl}">Potwierdź adres e-mail</a></p><p>Link jest ważny 48 godzin.</p>`,
  });
  const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
  if (accepted.length === 0) {
    const rejected = Array.isArray(info?.rejected) ? info.rejected.join(", ") : "";
    throw new Error(`SMTP nie potwierdził odbiorcy. Rejected: ${rejected || "brak danych"}`);
  }
  return {
    messageId: String(info?.messageId || ""),
    accepted,
    rejected: Array.isArray(info?.rejected) ? info.rejected : [],
  };
}

export async function sendOperatorEmailToUser({ to, subject, text, html }) {
  const t = createMailTransporter();
  if (!t) throw new Error("Brak konfiguracji SMTP (SMTP_USER / SMTP_PASS).");
  const subj = String(subject || "").trim();
  const bodyText = String(text || "").trim();
  const bodyHtml = html != null && String(html).trim() !== "" ? String(html) : undefined;
  const info = await t.sendMail({
    from: mailFrom(),
    to,
    subject: subj,
    text: bodyText,
    ...(bodyHtml ? { html: bodyHtml } : {}),
  });
  const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
  if (accepted.length === 0) {
    const rejected = Array.isArray(info?.rejected) ? info.rejected.join(", ") : "";
    throw new Error(`SMTP nie potwierdził odbiorcy. Rejected: ${rejected || "brak danych"}`);
  }
  return {
    messageId: String(info?.messageId || ""),
    accepted,
    rejected: Array.isArray(info?.rejected) ? info.rejected : [],
  };
}
