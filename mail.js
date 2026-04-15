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

function brevoApiKey() {
  return String(process.env.BREVO_API_KEY || "").trim();
}

function hasBrevoApi() {
  return !!brevoApiKey();
}

export function isMailConfigured() {
  return hasBrevoApi() || !!(String(process.env.SMTP_USER || "").trim() && String(process.env.SMTP_PASS || "").trim());
}

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function createMailTransporter() {
  const hasSmtpCreds = !!(String(process.env.SMTP_USER || "").trim() && String(process.env.SMTP_PASS || "").trim());
  if (!hasSmtpCreds) return null;
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

function parseSender(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(.*)<\s*([^>]+)\s*>$/);
  if (m) {
    const name = m[1].trim().replace(/^"|"$/g, "");
    const email = m[2].trim();
    return {
      email,
      ...(name ? { name } : {}),
    };
  }
  return { email: raw };
}

async function sendViaBrevoApi({ to, subject, text, html }) {
  const key = brevoApiKey();
  if (!key) throw new Error("Brak BREVO_API_KEY.");
  const sender = parseSender(mailFrom());
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": key,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: String(to || "").trim() }],
      subject: String(subject || "").trim(),
      ...(text ? { textContent: String(text) } : {}),
      ...(html ? { htmlContent: String(html) } : {}),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      String(data?.message || "").trim() || String(data?.code || "").trim() || `Brevo API error ${r.status}`;
    throw new Error(msg);
  }
  const messageId =
    String(data?.messageId || "").trim() ||
    (Array.isArray(data?.messageIds) && data.messageIds[0] ? String(data.messageIds[0]) : "");
  return {
    messageId,
    accepted: [String(to || "").trim()],
    rejected: [],
  };
}

async function sendViaSmtp({ to, subject, text, html }) {
  const t = createMailTransporter();
  if (!t) throw new Error("Brak konfiguracji SMTP (SMTP_USER / SMTP_PASS).");
  const info = await t.sendMail({
    from: mailFrom(),
    to: String(to || "").trim(),
    subject: String(subject || "").trim(),
    text: String(text || ""),
    ...(html != null && String(html).trim() !== "" ? { html: String(html) } : {}),
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

async function sendMailMessage({ to, subject, text, html }) {
  if (hasBrevoApi()) {
    return sendViaBrevoApi({ to, subject, text, html });
  }
  return sendViaSmtp({ to, subject, text, html });
}

export async function sendVerificationEmail({ to, verifyUrl, displayName }) {
  const name = displayName || "użytkowniku";
  return sendMailMessage({
    to: String(to || "").trim(),
    subject: "Potwierdź adres e-mail — Szepty Anielskie",
    text: `Cześć ${name},\n\nOtwórz link, aby potwierdzić konto:\n${verifyUrl}\n\nLink jest ważny 48 godzin.\n`,
    html: `<p>Cześć ${escapeHtml(name)},</p><p><a href="${verifyUrl}">Potwierdź adres e-mail</a></p><p>Link jest ważny 48 godzin.</p>`,
  });
}

export async function sendOperatorEmailToUser({ to, subject, text, html }) {
  const subj = String(subject || "").trim();
  const bodyText = String(text || "").trim();
  const bodyHtml = html != null && String(html).trim() !== "" ? String(html) : undefined;
  return sendMailMessage({
    to: String(to || "").trim(),
    subject: subj,
    text: bodyText,
    html: bodyHtml,
  });
}

export async function sendEmailChangeConfirmation({ to, confirmUrl, displayName }) {
  const name = displayName || "użytkowniku";
  return sendMailMessage({
    to: String(to || "").trim(),
    subject: "Potwierdź zmianę adresu e-mail — Szepty Anielskie",
    text: `Cześć ${name},\n\nPotwierdź zmianę adresu e-mail klikając link:\n${confirmUrl}\n\nLink jest ważny 48 godzin.\n`,
    html: `<p>Cześć ${escapeHtml(name)},</p><p><a href="${confirmUrl}">Potwierdź zmianę adresu e-mail</a></p><p>Link jest ważny 48 godzin.</p>`,
  });
}
