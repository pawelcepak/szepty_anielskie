import { api } from "./api.js";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const err = document.getElementById("err");
const avatarInput = document.getElementById("avatar");
const previewWrap = document.getElementById("avatar-preview-wrap");
const previewImg = document.getElementById("avatar-preview");

let avatarDataUrl = "";

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Nie udało się odczytać pliku."));
    r.readAsDataURL(file);
  });
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
    banner.innerHTML = `<p class="chosen-medium-text">Wybrałeś rozmowę z: <strong>${esc(c.name)}</strong>. Po rejestracji otworzymy od razu ten wątek w panelu.</p>`;
  } catch {
    /* ignore */
  }
})();

avatarInput?.addEventListener("change", async () => {
  err.hidden = true;
  avatarDataUrl = "";
  previewWrap?.classList.add("hidden");
  const f = avatarInput.files?.[0];
  if (!f) return;
  if (f.size > 420000) {
    err.textContent = "Zdjęcie jest za duże — wybierz plik do ok. 400 KB.";
    err.hidden = false;
    avatarInput.value = "";
    return;
  }
  try {
    const url = await readFileAsDataUrl(f);
    if (url.length > 450000) {
      err.textContent = "Po zakodowaniu zdjęcie jest za duże — użyj mniejszego pliku.";
      err.hidden = false;
      avatarInput.value = "";
      return;
    }
    avatarDataUrl = url;
    if (previewImg) previewImg.src = url;
    previewWrap?.classList.remove("hidden");
  } catch {
    err.textContent = "Nie udało się wczytać zdjęcia.";
    err.hidden = false;
    avatarInput.value = "";
  }
});

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
  const fd = new FormData(e.target);
  const username = String(fd.get("username") || "").trim().toLowerCase();
  const first_name = String(fd.get("first_name") || "").trim();
  const city = String(fd.get("city") || "").trim();
  const birth_date = String(fd.get("birth_date") || "").trim();
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  const acceptTerms = fd.get("accept_terms") === "on";
  const acceptPrivacy = fd.get("accept_privacy") === "on";
  if (!acceptTerms || !acceptPrivacy) {
    err.textContent = "Aby kontynuować, zaakceptuj regulamin i politykę prywatności.";
    err.hidden = false;
    return;
  }
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
        avatar_url: avatarDataUrl || null,
      }),
    });
    const med = new URLSearchParams(window.location.search).get("medium");
    window.location.href = med
      ? `/panel.html?open=${encodeURIComponent(med)}`
      : "/panel.html";
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  }
});
