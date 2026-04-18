import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const root = document.getElementById("landing-team");
if (!root) throw new Error("landing-team missing");
const filterWrap = document.getElementById("catalog-filters");

let isLoggedIn = false;
let activeFilter = "Wszystko";
let allCharacters = [];
try {
  const st = await api("/api/auth/status");
  isLoggedIn = !!st?.logged_in;
} catch {
  isLoggedIn = false;
}

for (const link of document.querySelectorAll('a[href="/rejestracja.html"]')) {
  if (isLoggedIn) link.setAttribute("href", "/panel.html");
}

try {
  const { characters } = await api("/api/characters");
  allCharacters = Array.isArray(characters) ? characters : [];
  render();
  filterWrap?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    activeFilter = String(btn.dataset.filter || "Wszystko");
    for (const el of filterWrap.querySelectorAll("[data-filter]")) {
      el.classList.toggle("active", el === btn);
    }
    render();
  });
} catch {
  root.innerHTML =
    '<p class="landing-fallback">Nie udało się załadować katalogu. Uruchom serwer i odśwież stronę.</p>';
}

function normalizedCategory(c) {
  const raw = String(c?.category || "").toLowerCase();
  if (raw.includes("tarot")) return "Tarot";
  if (raw.includes("astrologia")) return "Astrologia";
  if (raw.includes("jasnowid")) return "Jasnowidzenie";
  if (raw.includes("wróż") || raw.includes("wroz")) return "Wróżby";
  return "Wróżby";
}

function render() {
  root.innerHTML = "";
  const visible =
    activeFilter === "Wszystko"
      ? allCharacters
      : allCharacters.filter((c) => normalizedCategory(c) === activeFilter);
  for (const c of visible) {
    const url = c.portrait_url || "";
    const regHref = isLoggedIn
      ? `/panel.html?open=${encodeURIComponent(c.id)}`
      : `/rejestracja.html?medium=${encodeURIComponent(c.id)}`;
    const profileHref = `/medium.html?id=${encodeURIComponent(c.id)}`;
    const card = document.createElement("article");
    card.className = "tarot-card";
    card.innerHTML = `
      <div class="tarot-card-photo">
        <img src="${esc(url)}" alt="${esc(`Portret: ${c.name}`)}" width="280" height="350" loading="lazy" decoding="async" />
      </div>
      <div class="tarot-card-body">
        <p class="tarot-card-title">${esc(c.name)}</p>
        <p class="tarot-card-tagline">${c.tagline ? esc(c.tagline) : ""}</p>
        <div class="tarot-card-footer">
          <p class="tarot-card-cat">${esc(normalizedCategory(c))}</p>
          <div class="tarot-card-actions">
            <a class="btn btn-gold" href="${regHref}">Konsultacja</a>
            <a class="btn btn-outline btn--on-dark" href="${profileHref}">Zobacz profil</a>
          </div>
        </div>
      </div>
    `;
    root.appendChild(card);
  }
}
