import { api } from "./api.js";

const pkg = document.getElementById("pkg");
const pkgNote = document.getElementById("pkg-note");
const pkgErr = document.getElementById("pkg-err");
const whoEl = document.getElementById("who");
const balLine = document.getElementById("bal-line");

let me = null;

document.getElementById("logout")?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/logowanie.html";
});

function renderPackages() {
  if (!pkg) return;
  pkg.innerHTML = "";
  const amounts = [10, 20, 50, 100];
  const enabled = me?.fake_purchase_enabled;
  if (pkgNote) pkgNote.textContent = "";
  const priceMap = new Map((me?.packages_pln || []).map((x) => [x.amount, x.price_pln]));
  for (const a of amounts) {
    const b = document.createElement("button");
    b.type = "button";
    const pln = priceMap.get(a);
    b.textContent =
      pln != null && Number.isFinite(Number(pln))
        ? `+${a} wiadomości — ${pln} zł`
        : `+${a} wiadomości`;
    b.disabled = !enabled;
    b.addEventListener("click", async () => {
      pkgErr.hidden = true;
      try {
        const r = await api("/api/test/purchase", {
          method: "POST",
          body: JSON.stringify({ amount: a }),
        });
        me.messages_remaining = r.messages_remaining;
        if (balLine) balLine.textContent = `Pozostało: ${me.messages_remaining} wiadomości`;
      } catch (e) {
        pkgErr.textContent = e.message;
        pkgErr.hidden = false;
      }
    });
    pkg.appendChild(b);
  }
}

try {
  me = await api("/api/me");
  const u = me.user;
  if (whoEl) {
    whoEl.textContent = `${u.first_name || u.display_name || "?"} (@${u.username || "?"})`;
  }
  if (balLine) {
    balLine.textContent = `Pozostało: ${me.messages_remaining} wiadomości`;
  }
  renderPackages();
} catch {
  window.location.href = "/logowanie.html";
}
