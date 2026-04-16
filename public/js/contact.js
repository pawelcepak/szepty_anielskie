import { api } from "./api.js";

const form = document.getElementById("contact-form");
const errEl = document.getElementById("contact-form-error");
const okEl = document.getElementById("contact-form-ok");

function setError(msg) {
  if (!errEl) return;
  errEl.textContent = msg || "";
  errEl.hidden = !msg;
}

function setOk(show) {
  if (!okEl) return;
  okEl.hidden = !show;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  setOk(false);
  const fd = new FormData(form);
  const payload = {
    name: String(fd.get("name") || "").trim(),
    email: String(fd.get("email") || "").trim(),
    message: String(fd.get("message") || "").trim(),
    company: String(fd.get("company") || "").trim(),
  };
  try {
    await api("/api/public/contact", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    form.reset();
    setOk(true);
  } catch (err) {
    setError(err?.message || "Nie udało się wysłać wiadomości. Spróbuj ponownie.");
  }
});
