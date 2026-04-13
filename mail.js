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

export function createMailTransporter() {
  if (!isMailConfigured()) return null;
  const host = String(process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    String(process.env.SMTP_SECURE || "").toLowerCase() === "1" ||
    port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
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
  await t.sendMail({
    from: mailFrom(),
    to,
    subject: "Potwierdź adres e-mail — Szept Kart",
    text: `Cześć ${name},\n\nOtwórz link, aby potwierdzić konto:\n${verifyUrl}\n\nLink jest ważny 48 godzin.\n`,
    html: `<p>Cześć ${escapeHtml(name)},</p><p><a href="${verifyUrl}">Potwierdź adres e-mail</a></p><p>Link jest ważny 48 godzin.</p>`,
  });
}

export async function sendOperatorEmailToUser({ to, subject, text, html }) {
  const t = createMailTransporter();
  if (!t) throw new Error("Brak konfiguracji SMTP (SMTP_USER / SMTP_PASS).");
  const subj = String(subject || "").trim();
  const bodyText = String(text || "").trim();
  const bodyHtml = html != null && String(html).trim() !== "" ? String(html) : undefined;
  await t.sendMail({
    from: mailFrom(),
    to,
    subject: subj,
    text: bodyText,
    ...(bodyHtml ? { html: bodyHtml } : {}),
  });
}
