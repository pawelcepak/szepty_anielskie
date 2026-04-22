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

/** Ważność linków w mailach (weryfikacja konta, zmiana e-mail) — spójna z tokenami w bazie (MAIL_LINK_EXPIRY_HOURS). */
export function mailLinkExpiryHours() {
  const h = Number(process.env.MAIL_LINK_EXPIRY_HOURS || 48);
  return Number.isFinite(h) && h > 0 && h <= 720 ? Math.floor(h) : 48;
}

export function mailVerificationTtlMs() {
  return mailLinkExpiryHours() * 60 * 60 * 1000;
}

function mailTpl(raw, vars) {
  return String(raw || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null && vars[key] !== undefined ? String(vars[key]) : ""
  );
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
  return f || "no-reply@szeptyonline.pl";
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
  const hours = mailLinkExpiryHours();
  const subject =
    String(process.env.MAIL_SUBJECT_EMAIL_VERIFICATION || "").trim() ||
    "Jesteś o krok od rozmowy — potwierdź e-mail | Szepty Anielskie";
  const vars = {
    name,
    nameHtml: escapeHtml(name),
    verifyUrl,
    hours: String(hours),
  };
  const textTpl =
    String(process.env.MAIL_TEXT_EMAIL_VERIFICATION || "").trim() ||
    `Cześć {{name}},\n\nWitaj w Szeptach Anielskich — miejscu, gdzie rozmowa z medium dzieje się na żywo, w swoim tempie, bez pośpiechu.\n\nJeszcze jeden krok: potwierdź adres e-mail, żebyśmy mogli bezpiecznie otworzyć Twój panel i pierwszą rozmowę:\n{{verifyUrl}}\n\nJeśli powyższy link nie otwiera się z wiadomości, skopiuj go w całości do paska adresu przeglądarki.\n\nPo potwierdzeniu możesz od razu wybrać konsultanta, napisać pierwszą wiadomość i — gdy będziesz gotowa/gotowy — doładować konto pakietem wiadomości (w panelu zobaczysz aktualne pakiety i cennik). Im szybciej potwierdzisz, tym szybciej zostawiasz za sobą formalności i zaczynasz to, po co tu przyszłaś/przyszedłeś.\n\nLink jest ważny {{hours}} godzin. Jeśli nie Ty zakładałeś tego konta — zignoruj tę wiadomość.\n\nDo zobaczenia po drugiej stronie czatu,\nZespół Szeptów Anielskich\n`;
  const htmlTpl = String(process.env.MAIL_HTML_EMAIL_VERIFICATION || "").trim();
  const text = mailTpl(textTpl, vars);
  const html =
    htmlTpl !== ""
      ? mailTpl(htmlTpl, vars)
      : `<div style="font-family:Georgia,'Times New Roman',serif;max-width:560px;margin:0 auto;line-height:1.6;color:#1f1408;">
  <p style="font-size:17px;">Cześć <strong>${escapeHtml(name)}</strong>,</p>
  <p>Witaj w <strong>Szeptach Anielskich</strong> — tam, gdzie rozmowa z medium ma swój rytm: bez pośpiechu, na żywo, po ludzku.</p>
  <p>Jeszcze <strong>jeden klik</strong> dzieli Cię od panelu i pierwszej wiadomości do wybranego konsultanta. Potwierdź adres e-mail — wtedy odblokujemy konto i możesz od razu wejść w rozmowę.</p>
  <p style="margin:28px 0;text-align:center;">
    <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:linear-gradient(160deg,#1f6b4a,#145236);color:#fff;font-weight:700;text-decoration:none;font-size:16px;">Potwierdź e-mail i przejdź do panelu</a>
  </p>
  <p style="font-size:14px;color:#4a4036;line-height:1.5;">Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki (cały, jednym ciągiem):<br /><a href="${verifyUrl}" style="color:#145236;word-break:break-all;">${escapeHtml(verifyUrl)}</a></p>
  <p>Po zalogowaniu zobaczysz <strong>aktualne pakiety wiadomości</strong> i cennik — doładujesz konto, gdy poczujesz, że chcesz pójść dalej w rozmowie. Nie musisz decydować od razu; ważne, że już tu jesteś.</p>
  <p style="font-size:14px;color:#4a4036;">Link jest ważny <strong>${hours} godzin</strong>. Jeśli nie Ty zakładałeś tego konta — spokojnie zignoruj tę wiadomość.</p>
  <p style="margin-top:24px;">Ciepło pozdrawiamy,<br/><span style="color:#5c3d1a;">Zespół Szeptów Anielskich</span></p>
</div>`;
  return sendMailMessage({
    to: String(to || "").trim(),
    subject: mailTpl(subject, vars),
    text,
    html,
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
  const hours = mailLinkExpiryHours();
  const subject =
    String(process.env.MAIL_SUBJECT_EMAIL_CHANGE || "").trim() || "Potwierdź zmianę adresu e-mail — Szepty Anielskie";
  const vars = {
    name,
    nameHtml: escapeHtml(name),
    confirmUrl,
    hours: String(hours),
  };
  const textTpl =
    String(process.env.MAIL_TEXT_EMAIL_CHANGE || "").trim() ||
    `Cześć {{name}},\n\nPotwierdź zmianę adresu e-mail klikając link:\n{{confirmUrl}}\n\nJeśli link nie otwiera się z wiadomości, skopiuj go w całości do paska adresu przeglądarki.\n\nLink jest ważny {{hours}} godzin.\n`;
  const htmlTpl = String(process.env.MAIL_HTML_EMAIL_CHANGE || "").trim();
  const text = mailTpl(textTpl, vars);
  const html =
    htmlTpl !== ""
      ? mailTpl(htmlTpl, vars)
      : `<p>Cześć ${escapeHtml(name)},</p><p><a href="${confirmUrl}">Potwierdź zmianę adresu e-mail</a></p><p style="font-size:14px;color:#444;line-height:1.5">Jeśli przycisk lub link powyżej nie działa, skopiuj ten adres do przeglądarki:<br /><a href="${confirmUrl}" style="word-break:break-all">${escapeHtml(confirmUrl)}</a></p><p>Link jest ważny ${hours} godzin.</p>`;
  return sendMailMessage({
    to: String(to || "").trim(),
    subject: mailTpl(subject, vars),
    text,
    html,
  });
}

export async function sendPasswordResetEmail({ to, resetUrl, displayName }) {
  const name = displayName || "użytkowniku";
  const subject = "Zmiana hasła — Szepty Anielskie";
  const text = `Cześć ${name},\n\nOtrzymaliśmy prośbę o zmianę hasła do Twojego konta.\n\nKliknij poniższy link, aby ustawić nowe hasło (ważny 2 godziny):\n${resetUrl}\n\nJeśli link nie otwiera się z wiadomości, skopiuj go w całości do paska adresu przeglądarki.\n\nJeśli to nie Ty wysłałeś(aś) tę prośbę — zignoruj tę wiadomość. Twoje hasło pozostaje bez zmian.\n\nPozdrawiamy,\nZespół Szepty Anielskie`;
  const html = `<p>Cześć ${escapeHtml(name)},</p>
<p>Otrzymaliśmy prośbę o zmianę hasła do Twojego konta w serwisie Szepty Anielskie.</p>
<p><a href="${resetUrl}" style="display:inline-block;padding:0.6rem 1.4rem;background:#c9a84c;color:#1a1206;border-radius:8px;text-decoration:none;font-weight:700">Ustaw nowe hasło</a></p>
<p style="font-size:13px;color:#555;line-height:1.5;margin:14px 0 0">Jeśli przycisk nie działa, otwórz ten link w przeglądarce (skopiuj w całości):<br /><a href="${resetUrl}" style="word-break:break-all;color:#6b5a2a">${escapeHtml(resetUrl)}</a></p>
<p style="font-size:0.85em;color:#888">Link jest ważny przez <strong>2 godziny</strong>. Jeśli to nie Ty wysłałeś(aś) tę prośbę — zignoruj tę wiadomość.</p>`;
  return sendMailMessage({ to: String(to || "").trim(), subject, text, html });
}
