import { api } from "./api.js";

const err = document.getElementById("err");

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const fd = new FormData(e.target);
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
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
