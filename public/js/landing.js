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

try {
  const { characters } = await api("/api/characters");
  root.innerHTML = "";
  for (const c of characters) {
    const url = c.portrait_url || "";
    const regHref = `/rejestracja.html?medium=${encodeURIComponent(c.id)}`;
    const profileHref = `/medium.html?id=${encodeURIComponent(c.id)}`;
    const card = document.createElement("article");
    card.className = "tarot-card";
    card.innerHTML = `
      <div class="tarot-card-photo">
        <img src="${esc(url)}" alt="${esc(`Portret: ${c.name}`)}" width="280" height="350" loading="lazy" decoding="async" />
      </div>
      <div class="tarot-card-body">
        <p class="tarot-card-title">${esc(c.name)}</p>
        <p class="tarot-card-sub">${esc(c.category || c.tagline || "Tarot i horoskop")}</p>
        <div class="tarot-card-actions">
          <a class="btn btn-gold" href="${regHref}">Konsultacja</a>
          <a class="btn btn-outline btn--on-dark" href="${profileHref}">Zobacz profil</a>
        </div>
      </div>
    `;
    root.appendChild(card);
  }
} catch {
  root.innerHTML =
    '<p class="landing-fallback">Nie udało się załadować katalogu. Uruchom serwer i odśwież stronę.</p>';
}
