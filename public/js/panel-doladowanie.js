import { api } from "./api.js";

const pkg = document.getElementById("pkg");
const pkgNote = document.getElementById("pkg-note");
const pkgErr = document.getElementById("pkg-err");
const whoEl = document.getElementById("who");
const balLine = document.getElementById("bal-line");

let me = null;
let paymentsConfig = null;

document.getElementById("logout")?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/logowanie.html";
});

// Handle return from PayU
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("status") === "ok") {
  if (pkgNote) {
    pkgNote.textContent = "Płatność przyjęta — wiadomości pojawią się na koncie po potwierdzeniu przez PayU (zwykle kilka sekund).";
    pkgNote.style.color = "#4caf50";
  }
}

function renderPackages() {
  if (!pkg) return;
  pkg.innerHTML = "";
  if (pkgNote && !urlParams.get("status")) pkgNote.textContent = "";
  const priceMap = new Map((me?.packages_pln || []).map((x) => [x.amount, x.price_pln]));
  const amounts = [10, 20, 50, 100];
  const payuEnabled = paymentsConfig?.payu?.enabled;
  const fakeEnabled = me?.fake_purchase_enabled;

  if (!payuEnabled && !fakeEnabled) {
    if (pkgNote) pkgNote.textContent = "Płatności są tymczasowo niedostępne.";
    return;
  }

  for (const a of amounts) {
    const b = document.createElement("button");
    b.type = "button";
    const pln = priceMap.get(a);
    b.textContent =
      pln != null && Number.isFinite(Number(pln))
        ? `+${a} wiadomości — ${pln} zł`
        : `+${a} wiadomości`;

    b.addEventListener("click", async () => {
      pkgErr.hidden = true;
      b.disabled = true;
      b.textContent = "Ładowanie…";
      try {
        if (payuEnabled) {
          const r = await api("/api/payments/payu/create", {
            method: "POST",
            body: JSON.stringify({ amount: a }),
          });
          if (r.redirectUri) {
            window.location.href = r.redirectUri;
          } else {
            throw new Error("Brak adresu przekierowania od PayU.");
          }
        } else {
          const r = await api("/api/test/purchase", {
            method: "POST",
            body: JSON.stringify({ amount: a }),
          });
          me.messages_remaining = r.messages_remaining;
          if (balLine) balLine.textContent = `Pozostało: ${me.messages_remaining} wiadomości`;
          b.disabled = false;
          const pln2 = priceMap.get(a);
          b.textContent = pln2 != null ? `+${a} wiadomości — ${pln2} zł` : `+${a} wiadomości`;
        }
      } catch (e) {
        pkgErr.textContent = e.message;
        pkgErr.hidden = false;
        b.disabled = false;
        const pln2 = priceMap.get(a);
        b.textContent = pln2 != null ? `+${a} wiadomości — ${pln2} zł` : `+${a} wiadomości`;
      }
    });
    pkg.appendChild(b);
  }
}

try {
  [me, paymentsConfig] = await Promise.all([
    api("/api/me"),
    api("/api/public/payments-config").catch(() => ({})),
  ]);
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
