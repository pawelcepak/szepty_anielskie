import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const err = document.getElementById("err");
const success = document.getElementById("register-success");

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
  const mediumParam = new URLSearchParams(window.location.search).get("medium");
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        first_name,
        city,
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
