import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const COOKIE_PREFS_KEY = "szepty_cookies_v1";

function ensureCookieBannerStyles() {
  if (document.getElementById("cookies-banner-styles")) return;
  const style = document.createElement("style");
  style.id = "cookies-banner-styles";
  style.textContent = `
    .cookies-banner {
      position: fixed;
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
      z-index: 150;
      background: rgba(20, 12, 34, 0.96);
      color: #f8f2ff;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 18px;
      box-shadow: 0 16px 50px rgba(0,0,0,0.35);
      padding: 1rem;
      max-width: 64rem;
      margin: 0 auto;
    }
    .cookies-banner.hidden { display: none; }
    .cookies-banner h2 { margin: 0 0 0.45rem; font-size: 1rem; color: #fff; }
    .cookies-banner p { margin: 0 0 0.65rem; line-height: 1.55; color: rgba(245,236,255,0.92); }
    .cookies-banner-actions, .cookies-banner-toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-top: 0.7rem;
    }
    .cookies-banner button {
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.24);
      padding: 0.5rem 0.9rem;
      font: inherit;
      cursor: pointer;
    }
    .cookies-banner .cookies-accept { background: #d4b06b; color: #1a1206; border-color: #d4b06b; }
    .cookies-banner .cookies-necessary { background: transparent; color: #fff; }
    .cookies-banner .cookies-settings { background: rgba(255,255,255,0.08); color: #fff; }
    .cookies-banner label {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.45rem 0.7rem;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      color: #f8f2ff;
    }
    .cookies-banner a { color: #f1d896; }
    @media (max-width: 600px) {
      .cookies-banner { left: 0.7rem; right: 0.7rem; bottom: 0.7rem; padding: 0.85rem; }
      .cookies-banner button { width: 100%; }
      .cookies-banner-actions { flex-direction: column; }
    }
  `;
  document.head.appendChild(style);
}

function readCookiePrefs() {
  try {
    const raw = localStorage.getItem(COOKIE_PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCookiePrefs(prefs) {
  try {
    localStorage.setItem(COOKIE_PREFS_KEY, JSON.stringify({ ...prefs, saved_at: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}

function renderCookieBanner() {
  if (readCookiePrefs()) return;
  ensureCookieBannerStyles();
  const banner = document.createElement("section");
  banner.className = "cookies-banner";
  banner.id = "cookies-banner";
  banner.innerHTML = `
    <h2>Używamy cookies</h2>
    <p>
      Niezbędne pliki cookies zapewniają działanie serwisu i nie wymagają zgody. Analityczne i marketingowe cookies
      włączamy tylko za Twoją zgodą.
      <a href="/polityka-cookies.html">Polityka cookies</a> ·
      <a href="/polityka-prywatnosci.html">Polityka prywatności</a>
    </p>
    <div class="cookies-banner-toggles hidden" id="cookies-banner-toggles">
      <label><input type="checkbox" checked disabled /> Niezbędne</label>
      <label><input type="checkbox" id="cookies-analytics" /> Analityczne</label>
      <label><input type="checkbox" id="cookies-marketing" /> Marketingowe</label>
    </div>
    <div class="cookies-banner-actions">
      <button type="button" class="cookies-accept" id="cookies-accept-all">Akceptuję wszystkie</button>
      <button type="button" class="cookies-necessary" id="cookies-accept-necessary">Tylko niezbędne</button>
      <button type="button" class="cookies-settings" id="cookies-open-settings">Ustawienia</button>
    </div>
  `;
  document.body.appendChild(banner);
  const toggles = banner.querySelector("#cookies-banner-toggles");
  banner.querySelector("#cookies-open-settings")?.addEventListener("click", () => {
    toggles?.classList.toggle("hidden");
  });
  banner.querySelector("#cookies-accept-all")?.addEventListener("click", () => {
    saveCookiePrefs({ necessary: true, analytics: true, marketing: true });
    banner.remove();
  });
  banner.querySelector("#cookies-accept-necessary")?.addEventListener("click", () => {
    const analytics = banner.querySelector("#cookies-analytics")?.checked || false;
    const marketing = banner.querySelector("#cookies-marketing")?.checked || false;
    saveCookiePrefs({ necessary: true, analytics, marketing });
    banner.remove();
  });
}

async function refreshAuthBanners() {
  const slots = document.querySelectorAll("[data-auth-banner]");
  if (!slots.length) return;
  const guestOnly = document.querySelectorAll(".auth-only-guest");
  const userOnly = document.querySelectorAll(".auth-only-user");
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
    for (const el of guestOnly) el.classList.toggle("hidden", !!st.logged_in);
    for (const el of userOnly) el.classList.toggle("hidden", !st.logged_in);
  } catch {
    for (const el of slots) {
      el.innerHTML = `<span class="auth-badge auth-badge--guest">Stan sesji niedostępny</span>`;
    }
    for (const el of guestOnly) el.classList.remove("hidden");
    for (const el of userOnly) el.classList.add("hidden");
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
renderCookieBanner();
