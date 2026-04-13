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
    const aboutSnip =
      c.about && c.about.length > 220 ? `${c.about.slice(0, 220)}…` : c.about || "";
    const regHref = `/rejestracja.html?medium=${encodeURIComponent(c.id)}`;
    const loginHref = `/logowanie.html?open=${encodeURIComponent(c.id)}`;
    const card = document.createElement("article");
    card.className = "team-card";
    card.innerHTML = `
      <div class="team-card-photo">
        <img src="${esc(url)}" alt="${esc(`Portret: ${c.name}`)}" width="280" height="350" loading="lazy" decoding="async" />
      </div>
      <div class="team-card-body">
        <span class="team-card-cat">${esc(c.category)}</span>
        <h3>${esc(c.name)}</h3>
        ${c.gender ? `<p class="team-card-gender">${esc(c.gender)}</p>` : ""}
        <p class="team-card-tagline">${esc(c.tagline)}</p>
        ${c.skills ? `<p class="team-card-skills">${esc(c.skills)}</p>` : ""}
        ${aboutSnip ? `<p class="team-card-about">${esc(aboutSnip)}</p>` : ""}
        <div class="team-card-actions">
          <a class="btn btn-gold team-card-cta-primary" href="${regHref}">Rozmawiaj</a>
          <a class="btn btn-outline team-card-cta-secondary" href="${loginHref}">Mam już konto</a>
        </div>
      </div>
    `;
    root.appendChild(card);
  }
} catch {
  root.innerHTML =
    '<p class="landing-fallback">Nie udało się załadować katalogu. Uruchom serwer i odśwież stronę.</p>';
}
