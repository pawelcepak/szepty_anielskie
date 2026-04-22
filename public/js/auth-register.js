import { api } from "./api.js";

function parseBirthDateClient(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  const d = new Date(y, mo, da, 12, 0, 0, 0);
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
  return d;
}

function birthDateAllowedClient(d) {
  const now = new Date();
  const cutoff18 = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (d.getTime() > cutoff18.getTime()) return false;
  const oldest = new Date(now.getFullYear() - 120, now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (d.getTime() < oldest.getTime()) return false;
  return true;
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const err = document.getElementById("err");
const success = document.getElementById("register-success");
function toIsoDateLocal(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

const birthInput = document.getElementById("birth_date");
if (birthInput) {
  const now = new Date();
  const maxD = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate());
  const minD = new Date(now.getFullYear() - 120, now.getMonth(), now.getDate());
  birthInput.setAttribute("max", toIsoDateLocal(maxD));
  birthInput.setAttribute("min", toIsoDateLocal(minD));
}

const params = new URLSearchParams(window.location.search);
const mediumId = params.get("medium");
const banner = document.getElementById("chosen-medium-banner");
const loginLink = document.getElementById("register-login-link");
if (mediumId && loginLink) {
  loginLink.href = `/logowanie.html?open=${encodeURIComponent(mediumId)}`;
}

(async () => {
  if (!mediumId || !banner) return;
  try {
    const { characters } = await api("/api/characters");
    const c = characters.find((x) => x.id === mediumId);
    if (!c) return;
    banner.hidden = false;
    banner.innerHTML = `<p class="chosen-medium-text">Wybrałeś rozmowę z: <strong>${esc(c.name)}</strong>. Po potwierdzeniu adresu e-mail otworzymy ten wątek w panelu.</p>`;
  } catch {
    /* ignore */
  }
})();

for (const link of document.querySelectorAll(".legal-open-btn")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const href = link.getAttribute("href");
    if (!href) return;
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    opened?.focus();
  });
}

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  if (success) success.hidden = true;
  const submitBtn = document.getElementById("register-submit");
  if (submitBtn) submitBtn.disabled = true;
  const fd = new FormData(e.target);
  const username = String(fd.get("username") || "").trim().toLowerCase();
  const first_name = String(fd.get("first_name") || "").trim();
  const city = String(fd.get("city") || "").trim();
  const birth_date = String(fd.get("birth_date") || "").trim() || null;
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  const acceptTerms = fd.get("accept_terms") === "on";
  const acceptPrivacy = fd.get("accept_privacy") === "on";
  const acceptAge = fd.get("accept_age") === "on";
  if (!acceptTerms || !acceptPrivacy || !acceptAge) {
    err.textContent = "Aby kontynuować, zaakceptuj regulamin, politykę prywatności i potwierdź pełnoletność.";
    err.hidden = false;
    if (submitBtn) submitBtn.disabled = false;
    return;
  }
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    err.textContent = "Hasło musi zawierać co najmniej jedną wielką literę, jedną cyfrę i jeden znak specjalny.";
    err.hidden = false;
    if (submitBtn) submitBtn.disabled = false;
    return;
  }
  if (birth_date) {
    const bd = parseBirthDateClient(birth_date);
    if (!bd) {
      err.textContent = "Podaj prawidłową datę urodzenia (format rrrr-mm-dd).";
      err.hidden = false;
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    if (!birthDateAllowedClient(bd)) {
      err.textContent =
        "Z podanej daty wynika, że nie masz ukończonych 18 lat (albo data jest zbyt odległa). Usługa jest przeznaczona dla osób pełnoletnich.";
      err.hidden = false;
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
  }
  const mediumParam = new URLSearchParams(window.location.search).get("medium");
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        first_name,
        city,
        birth_date,
        email,
        password,
        accept_terms: acceptTerms,
        accept_privacy: acceptPrivacy,
        accept_age: acceptAge,
        medium: mediumParam || null,
      }),
    });
    if (success) {
      success.textContent =
        "Konto utworzone. Wysłaliśmy link aktywacyjny na podany e-mail. Za chwilę przeniesiemy Cię do logowania.";
      success.hidden = false;
    }
    setTimeout(() => {
      window.location.href = "/logowanie.html?registered=1";
    }, 1200);
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
    if (submitBtn) submitBtn.disabled = false;
    return;
  }
  if (submitBtn) submitBtn.disabled = false;
});
