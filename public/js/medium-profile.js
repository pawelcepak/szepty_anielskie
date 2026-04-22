import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseTimeHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function genderLabel(g) {
  if (g === "female") return "Kobieta";
  if (g === "male") return "Mężczyzna";
  if (g === "other") return "Inne";
  return g || "";
}

function getTodaySchedule(c) {
  const dow = new Date().getDay(); // 0=niedz, 1=pon, ..., 6=sob
  if (dow === 0 || dow === 6) {
    // Weekend
    if (c.hours_weekend_from && c.hours_weekend_to)
      return { from: c.hours_weekend_from, to: c.hours_weekend_to, label: "Weekendy" };
  } else if (dow === 5) {
    // Piątek
    if (c.hours_fri_from && c.hours_fri_to)
      return { from: c.hours_fri_from, to: c.hours_fri_to, label: "Piątki" };
  } else {
    // Pon-Czw
    if (c.hours_mon_thu_from && c.hours_mon_thu_to)
      return { from: c.hours_mon_thu_from, to: c.hours_mon_thu_to, label: "Pon–Czw" };
  }
  // fallback do ogólnych
  if (c.typical_hours_from && c.typical_hours_to)
    return { from: c.typical_hours_from, to: c.typical_hours_to, label: "Ogólne" };
  return null;
}

function scheduleDescription(c) {
  const parts = [];
  if (c.hours_mon_thu_from && c.hours_mon_thu_to)
    parts.push(`pon–czw: ${c.hours_mon_thu_from}–${c.hours_mon_thu_to}`);
  if (c.hours_fri_from && c.hours_fri_to)
    parts.push(`pt: ${c.hours_fri_from}–${c.hours_fri_to}`);
  if (c.hours_weekend_from && c.hours_weekend_to)
    parts.push(`weekend: ${c.hours_weekend_from}–${c.hours_weekend_to}`);
  if (!parts.length && c.typical_hours_from && c.typical_hours_to)
    parts.push(`${c.typical_hours_from}–${c.typical_hours_to}`);
  return parts.join(", ");
}

function availabilityForCharacter(c) {
  const sched = getTodaySchedule(c);
  if (!sched) {
    return {
      badgeClass: "avail-badge avail-badge--unknown",
      badgeText: "Status: do potwierdzenia",
      line: "Godziny orientacyjne nie zostały ustawione.",
    };
  }
  const from = parseTimeHM(sched.from);
  const to = parseTimeHM(sched.to);
  if (from == null || to == null) {
    return {
      badgeClass: "avail-badge avail-badge--unknown",
      badgeText: "Status: do potwierdzenia",
      line: "Godziny orientacyjne nie zostały ustawione.",
    };
  }
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const inWin = from <= to ? mins >= from && mins <= to : mins >= from || mins <= to;
  const descAll = scheduleDescription(c);
  return {
    badgeClass: inWin ? "avail-badge avail-badge--on" : "avail-badge avail-badge--off",
    badgeText: inWin ? "Status: online" : "Status: offline",
    line: descAll
      ? `Najczęściej online: ${descAll}. Odpowiedź może przyjść również poza tymi godzinami.`
      : `Najczęściej online: ${sched.from}–${sched.to}.`,
  };
}

const root = document.getElementById("medium-profile-card");
const id = new URLSearchParams(window.location.search).get("id");

if (!id) {
  root.innerHTML = `<p class="form-error">Brak identyfikatora medium.</p>`;
} else {
  try {
    let isLoggedIn = false;
    try {
      const st = await api("/api/auth/status");
      isLoggedIn = !!st?.logged_in;
    } catch {
      isLoggedIn = false;
    }
    const { character: c } = await api(`/api/characters/${encodeURIComponent(id)}`);
    const av = availabilityForCharacter(c);
    const regHref = isLoggedIn
      ? `/panel.html?open=${encodeURIComponent(c.id)}`
      : `/rejestracja.html?medium=${encodeURIComponent(c.id)}`;
    const panelHref = `/panel.html?open=${encodeURIComponent(c.id)}`;
    root.innerHTML = `
      <div class="medium-profile-top">
        <img src="${esc(c.portrait_url || "")}" alt="${esc(c.name)}" width="240" height="280" />
        <div class="medium-profile-meta">
          <h1>${esc(c.name)}</h1>
          <p class="sub">${esc(c.tagline || "")}</p>
          <p class="sub"><strong>Kategoria:</strong> ${esc(c.category || "—")}</p>
          ${c.gender ? `<p class="sub"><strong>Płeć:</strong> ${esc(genderLabel(c.gender))}</p>` : ""}
          <p class="sub"><span class="${esc(av.badgeClass)}">${esc(av.badgeText)}</span></p>
          <p class="sub">${esc(av.line)}</p>
        </div>
      </div>
      ${c.skills ? `<h2 class="legal-h2 medium-profile-block-title">Talenty i styl pracy</h2><p class="sub medium-profile-block-text">${esc(c.skills)}</p>` : ""}
      ${c.about ? `<h2 class="legal-h2 medium-profile-block-title">Jak się opisuje</h2><p class="sub medium-profile-block-text">${esc(c.about)}</p>` : ""}
      <div class="medium-profile-actions">
        <a class="btn btn-gold" href="${regHref}">Konsultacja z tym medium</a>
        <a class="btn btn-medium-profile-panel" href="${panelHref}">Otwórz rozmowę w panelu</a>
      </div>
    `;
  } catch (e) {
    root.innerHTML = `<p class="form-error">${esc(e.message || "Nie udało się załadować profilu medium.")}</p>`;
  }
}
