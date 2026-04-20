import { api } from "./api.js";

const pkg = document.getElementById("pkg");
const pkgNote = document.getElementById("pkg-note");
const pkgErr = document.getElementById("pkg-err");
const whoEl = document.getElementById("who");
const balLine = document.getElementById("bal-line");
const promoInput = document.getElementById("promo-code-input");
const promoApplyBtn = document.getElementById("promo-apply-btn");
const promoStatus = document.getElementById("promo-status");

let me = null;
let paymentsConfig = null;
let appliedPromo = null; // { code, discount_percent, label }

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

function showPromoStatus(msg, ok = true) {
  if (!promoStatus) return;
  promoStatus.textContent = msg;
  promoStatus.style.color = ok ? "#81c784" : "#e57373";
  promoStatus.hidden = false;
}

function clearPromoStatus() {
  if (promoStatus) promoStatus.hidden = true;
}

function discountedPrice(pln, discountPercent) {
  const discounted = pln * (1 - discountPercent / 100);
  return Math.max(0.01, discounted);
}

function formatPln(n) {
  return n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    const hasPrice = pln != null && Number.isFinite(Number(pln));

    function buildLabel() {
      if (!hasPrice) return { text: `+${a} wiadomości`, html: null };
      if (appliedPromo && appliedPromo.discount_percent > 0) {
        const orig = Number(pln);
        const discounted = discountedPrice(orig, appliedPromo.discount_percent);
        return {
          text: null,
          html: `+${a} wiadomości &mdash; <s>${formatPln(orig)}&nbsp;zł</s> &rarr; <strong>${formatPln(discounted)}&nbsp;zł</strong> <span style="color:#81c784">(−${appliedPromo.discount_percent}%)</span>`,
        };
      }
      return { text: `+${a} wiadomości — ${pln} zł`, html: null };
    }

    const lbl = buildLabel();
    if (lbl.html) { b.innerHTML = lbl.html; } else { b.textContent = lbl.text; }

    b.addEventListener("click", async () => {
      pkgErr.hidden = true;
      b.disabled = true;
      b.textContent = "Ładowanie…";
      try {
        if (payuEnabled) {
          const body = { amount: a };
          if (appliedPromo) body.promo_code = appliedPromo.code;
          const r = await api("/api/payments/payu/create", {
            method: "POST",
            body: JSON.stringify(body),
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
          const lbl3 = buildLabel();
          if (lbl3.html) { b.innerHTML = lbl3.html; } else { b.textContent = lbl3.text; }
        }
      } catch (e) {
        pkgErr.textContent = e.message;
        pkgErr.hidden = false;
        b.disabled = false;
        const lbl2 = buildLabel();
        if (lbl2.html) { b.innerHTML = lbl2.html; } else { b.textContent = lbl2.text; }
      }
    });
    pkg.appendChild(b);
  }
}

async function applyPromoCode() {
  const code = promoInput?.value.trim().toUpperCase();
  if (!code) return;
  clearPromoStatus();
  if (promoApplyBtn) promoApplyBtn.disabled = true;
  try {
    const data = await api("/api/public/promo/validate", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (data.ok && data.discount_percent > 0) {
      appliedPromo = { code, discount_percent: data.discount_percent, label: data.label };
      showPromoStatus(`✓ Kod "${code}" zastosowany — ${data.discount_percent}% zniżki (${data.label})`);
      if (promoInput) promoInput.disabled = true;
      if (promoApplyBtn) { promoApplyBtn.textContent = "Usuń kod"; promoApplyBtn.disabled = false; }
      renderPackages();
    } else {
      showPromoStatus("Kod nie daje zniżki.", false);
      if (promoApplyBtn) promoApplyBtn.disabled = false;
    }
  } catch (e) {
    appliedPromo = null;
    showPromoStatus(e.message || "Nieprawidłowy kod promocyjny.", false);
    if (promoApplyBtn) promoApplyBtn.disabled = false;
  }
}

promoApplyBtn?.addEventListener("click", async () => {
  if (appliedPromo) {
    // Remove promo
    appliedPromo = null;
    if (promoInput) { promoInput.disabled = false; promoInput.value = ""; }
    if (promoApplyBtn) promoApplyBtn.textContent = "Zastosuj";
    clearPromoStatus();
    renderPackages();
    return;
  }
  await applyPromoCode();
});

promoInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyPromoCode();
});

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
