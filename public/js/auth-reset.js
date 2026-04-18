import { api } from "./api.js";

const form = document.getElementById("form");
const errEl = document.getElementById("err");
const tokenErrEl = document.getElementById("token-err");
const successEl = document.getElementById("reset-success");
const submitBtn = document.getElementById("submit-btn");

const token = new URLSearchParams(window.location.search).get("token");

if (!token) {
  form.hidden = true;
  tokenErrEl.textContent = "Brak tokenu resetowania hasła. Skorzystaj z linku wysłanego na Twój e-mail.";
  tokenErrEl.hidden = false;
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  const password = document.getElementById("password")?.value;
  const password2 = document.getElementById("password2")?.value;
  if (!password || !password2) {
    errEl.textContent = "Wprowadź i potwierdź nowe hasło.";
    errEl.hidden = false;
    return;
  }
  if (password !== password2) {
    errEl.textContent = "Hasła nie są identyczne.";
    errEl.hidden = false;
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "Zapisuję…";
  try {
    await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    form.hidden = true;
    successEl.hidden = false;
  } catch (err) {
    errEl.textContent = err.message || "Coś poszło nie tak. Spróbuj ponownie lub poproś o nowy link.";
    errEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Ustaw nowe hasło";
  }
});
