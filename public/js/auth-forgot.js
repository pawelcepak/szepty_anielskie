import { api } from "./api.js";

const form = document.getElementById("form");
const errEl = document.getElementById("err");
const successEl = document.getElementById("reset-success");
const submitBtn = document.getElementById("submit-btn");

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  const email = document.getElementById("email")?.value?.trim();
  if (!email) {
    errEl.textContent = "Podaj adres e-mail.";
    errEl.hidden = false;
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "Wysyłam…";
  try {
    await api("/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    form.hidden = true;
    successEl.hidden = false;
  } catch (err) {
    errEl.textContent = err.message || "Coś poszło nie tak. Spróbuj ponownie.";
    errEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Wyślij link";
  }
});
