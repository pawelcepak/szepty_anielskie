import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refreshAuthBanners() {
  const slots = document.querySelectorAll("[data-auth-banner]");
  if (!slots.length) return;
  try {
    const st = await api("/api/auth/status");
    const idle = st.session_idle_minutes ?? 10;
    for (const el of slots) {
      if (!st.logged_in) {
        el.innerHTML = `<span class="auth-badge auth-badge--guest">Nie jesteś zalogowany(a)</span>
          <span class="auth-badge-hint"><a href="/logowanie.html">Zaloguj się</a> · <a href="/rejestracja.html">Załóż konto</a></span>`;
        continue;
      }
      const u = st.user || {};
      const lab = esc(u.first_name || u.display_name || u.username || "Konto");
      const nick = u.username ? ` @${esc(u.username)}` : "";
      el.innerHTML = `<span class="auth-badge auth-badge--in">Zalogowano: <strong>${lab}</strong>${nick}</span>
        <span class="auth-badge-hint">Sesja wygasa po ok. <strong>${idle} min</strong> bezczynności · <a href="/panel.html">Panel</a> · <a href="#" data-auth-logout>Wyloguj</a></span>`;
    }
  } catch {
    for (const el of slots) {
      el.innerHTML = `<span class="auth-badge auth-badge--guest">Stan sesji niedostępny</span>`;
    }
  }
}

document.body.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-auth-logout]");
  if (!a) return;
  e.preventDefault();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  window.location.href = "/logowanie.html";
});

refreshAuthBanners();
