import { api } from "./api.js";

const err = document.getElementById("err");
const info = document.getElementById("auth-info");
const qp = new URLSearchParams(window.location.search);
const btnResend = document.getElementById("btn-resend-verification");
if (info) {
  if (qp.get("registered") === "1") {
    info.className = "form-info form-info--ok";
    info.textContent =
      "Konto zostało utworzone. Sprawdź skrzynkę pocztową i kliknij link potwierdzający — dopiero potem możesz się zalogować.";
    info.hidden = false;
  } else if (qp.get("verify_error") === "expired") {
    info.className = "form-info form-info--warn";
    info.textContent = "Link potwierdzający wygasł. Zarejestruj się ponownie lub skontaktuj się z obsługą.";
    info.hidden = false;
  } else if (qp.get("verify_error")) {
    info.className = "form-info form-info--warn";
    info.textContent = "Nie udało się potwierdzić adresu (nieprawidłowy lub już użyty link).";
    info.hidden = false;
  }
}

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const fd = new FormData(e.target);
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  const remember_me = document.getElementById("remember-me")?.checked ?? false;
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember_me }),
    });
    const open = new URLSearchParams(window.location.search).get("open");
    window.location.href = open
      ? `/panel.html?open=${encodeURIComponent(open)}`
      : "/panel.html";
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  }
});

btnResend?.addEventListener("click", async () => {
  err.hidden = true;
  if (info) {
    info.hidden = true;
  }
  const emailInput = document.getElementById("email");
  const email = String(emailInput?.value || "").trim();
  if (!email) {
    err.textContent = "Wpisz e-mail w polu powyżej, a potem kliknij ponownie.";
    err.hidden = false;
    return;
  }
  try {
    const data = await api("/api/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    if (info) {
      info.className = "form-info form-info--ok";
      if (data.already_verified) {
        info.textContent = "To konto jest już zweryfikowane. Możesz się zalogować.";
      } else if (data.sent) {
        info.textContent = "Wysłano nowy link aktywacyjny. Sprawdź skrzynkę i spam.";
      } else {
        info.textContent = "Jeśli konto istnieje i nie jest zweryfikowane, link został ponownie wysłany.";
      }
      info.hidden = false;
    }
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  }
});
