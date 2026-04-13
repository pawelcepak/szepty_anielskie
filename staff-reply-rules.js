/**
 * Zakazane frazy w odpowiedziach pracownika do klienta (nie dotyczy notatek wewnętrznych).
 */

const DEFAULT_BANNED =
  "telefon,email,e-mail,mail,policja,agent czatu,whatsapp,telegram,signal,sms,messenger,facebook,instagram,numer konta";

export function getStaffBannedSubstrings() {
  const raw = String(process.env.STAFF_REPLY_BANNED_SUBSTRINGS || DEFAULT_BANNED);
  return raw
    .split(/[,;]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Zwraca pierwszą znalezioną frazę lub null. */
export function findBannedStaffReplySubstring(body) {
  const low = String(body || "").toLowerCase();
  for (const w of getStaffBannedSubstrings()) {
    if (w && low.includes(w)) return w;
  }
  return null;
}
