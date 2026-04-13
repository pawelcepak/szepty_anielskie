/**
 * Maskowanie długich ciągów cyfr w wiadomościach klienta (widok operatora).
 * Godziny typu 12:00, 12.00, 12 00 pozostają; 5+ cyfr (z separatorami lub bez) → *.
 */

const TIME_RE =
  /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b|\b([01]?\d|2[0-3])\s+([0-5]\d)\b|\b([01]?\d|2[0-3])[-–—]([0-5]\d)\b/g;

const DIGIT_RUN =
  /\d(?:[-–—.\s\u00A0\u2009\u202F]*\d){4,}|\d{5,}/g;

function maskMatch(raw) {
  return "*".repeat(raw.length);
}

export function maskClientNumbersForOperator(text) {
  if (text == null || text === "") return text;
  let s = String(text);
  const holders = [];
  let i = 0;
  s = s.replace(TIME_RE, (m) => {
    const key = `\uE000${i++}\uE001`;
    holders.push({ key, val: m });
    return key;
  });
  s = s.replace(DIGIT_RUN, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 5) return m;
    return maskMatch(m);
  });
  for (const { key, val } of holders) {
    s = s.split(key).join(val);
  }
  return s;
}
