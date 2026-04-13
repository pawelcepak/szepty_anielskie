import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const root = document.getElementById("legal-pricing");
const note = document.getElementById("pricing-load-note");

if (root) {
  try {
    const { packages } = await api("/api/public/pricing");
    if (note) note.textContent = "Tabela ma charakter informacyjny — szczegóły przy zakupie w panelu.";
    root.innerHTML = (packages || [])
      .map(
        (p) =>
          `<div class="price-box"><strong>${esc(String(p.amount))}</strong><span>wiadomości</span><span class="price-pln">${esc(
            String(p.price_pln)
          )} zł</span></div>`
      )
      .join("");
  } catch {
    if (note) note.textContent = "";
    root.innerHTML =
      '<p class="landing-fallback">Nie udało się wczytać danych — sprawdź połączenie z serwerem lub spróbuj później.</p>';
  }
}
