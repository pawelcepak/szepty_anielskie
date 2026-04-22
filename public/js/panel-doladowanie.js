import { api } from "./api.js";
import { getSavedPromoCode, clearSavedPromoCode } from "./promo-popup.js";

const pkg = document.getElementById("pkg");
const pkgNote = document.getElementById("pkg-note");
const pkgErr = document.getElementById("pkg-err");
const whoEl = document.getElementById("who");
const balLine = document.getElementById("bal-line");
const promoInput = document.getElementById("promo-code-input");
const promoApplyBtn = document.getElementById("promo-apply-btn");
const promoStatus = document.getElementById("promo-status");
const gatewayNote = document.getElementById("payment-gateway-note");
const gatewayPicker = document.getElementById("gateway-picker");

const urlParams = new URLSearchParams(window.location.search);

let me = null;
let paymentsConfig = null;
let appliedPromo = null; // { code, discount_percent, label }
let selectedCheckoutGateway = "stripe";

document.getElementById("logout")?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/logowanie.html";
});

// Powrót z bramki płatności
if (pkgNote) {
  const st = urlParams.get("status");
  const gw = urlParams.get("gateway");
  if (st === "ok") {
    if (gw === "stripe") {
      pkgNote.textContent =
        "Płatność zakończona w Stripe — pakiet jest dopisywany automatycznie. Jeśli saldo nie rośnie, odśwież stronę za kilka sekund.";
    } else if (gw === "imoje" || !gw) {
      pkgNote.textContent =
        "Płatność przyjęta — wiadomości pojawią się na koncie po potwierdzeniu przez ING iMoje (zwykle kilka sekund).";
    } else {
      pkgNote.textContent =
        "Płatność przyjęta — wiadomości pojawią się na koncie po potwierdzeniu przez operatora płatności (zwykle kilka sekund).";
    }
    pkgNote.style.color = "#4caf50";
  } else if (st === "pending") {
    pkgNote.textContent =
      "Płatność w toku. Po zaksięgowaniu środków wiadomości pojawią się na koncie.";
    pkgNote.style.color = "#ff9800";
  } else if (st === "fail") {
    pkgNote.textContent = "Płatność nie została dokończona. Możesz wybrać pakiet ponownie.";
    pkgNote.style.color = "#e57373";
  }
}

function syncGatewayPicker() {
  const list = paymentsConfig?.checkout_gateways || [];
  if (!gatewayPicker) return;
  if (list.length <= 1) {
    gatewayPicker.hidden = true;
    gatewayPicker.innerHTML = "";
    selectedCheckoutGateway = list[0] || selectedCheckoutGateway;
    return;
  }
  gatewayPicker.hidden = false;
  const first = list[0];
  if (!list.includes(selectedCheckoutGateway)) {
    selectedCheckoutGateway = first;
  }
  const parts = [
    '<p class="gateway-picker-title">Sposób płatności</p>',
    ...list.map((g) => {
      const id = `gw-${g}`;
      const label = g === "stripe" ? "Stripe (karta, szybkie testy)" : "iMoje (ING)";
      return `<label class="gateway-opt" for="${id}"><input type="radio" name="checkout-gw" id="${id}" value="${g}" />${label}</label>`;
    }),
  ];
  gatewayPicker.innerHTML = parts.join("");
  gatewayPicker.querySelectorAll('input[name="checkout-gw"]').forEach((inp) => {
    inp.checked = inp.value === selectedCheckoutGateway;
    inp.addEventListener("change", () => {
      if (inp.checked) selectedCheckoutGateway = inp.value;
    });
  });
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
  const list = paymentsConfig?.checkout_gateways || [];
  const payOnline = list.length > 0;
  const fakeEnabled = me?.fake_purchase_enabled;

  if (!payOnline && !fakeEnabled) {
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
    if (lbl.html) {
      b.innerHTML = lbl.html;
    } else {
      b.textContent = lbl.text;
    }

    b.addEventListener("click", async () => {
      pkgErr.hidden = true;
      b.disabled = true;
      b.textContent = "Ładowanie…";
      try {
        if (payOnline) {
          const body = { amount: a };
          if (appliedPromo) body.promo_code = appliedPromo.code;
          const useGw = selectedCheckoutGateway || list[0];
          const r =
            useGw === "stripe"
              ? await api("/api/payments/stripe/create", {
                  method: "POST",
                  body: JSON.stringify(body),
                })
              : await api("/api/payments/imoje/create", {
                  method: "POST",
                  body: JSON.stringify(body),
                });
          if (r.redirectUri) {
            window.location.href = r.redirectUri;
          } else {
            throw new Error(useGw === "stripe" ? "Brak adresu przekierowania od Stripe." : "Brak adresu przekierowania od ING iMoje.");
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
          if (lbl3.html) {
            b.innerHTML = lbl3.html;
          } else {
            b.textContent = lbl3.text;
          }
        }
      } catch (e) {
        pkgErr.textContent = e.message;
        pkgErr.hidden = false;
        b.disabled = false;
        const lbl2 = buildLabel();
        if (lbl2.html) {
          b.innerHTML = lbl2.html;
        } else {
          b.textContent = lbl2.text;
        }
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
      if (promoApplyBtn) {
        promoApplyBtn.textContent = "Usuń kod";
        promoApplyBtn.disabled = false;
      }
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
    if (promoInput) {
      promoInput.disabled = false;
      promoInput.value = "";
    }
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

  const st = urlParams.get("status");
  const gw = urlParams.get("gateway");
  const sid = urlParams.get("session_id");
  if (st === "ok" && gw === "stripe" && sid) {
    try {
      const vr = await api(`/api/payments/stripe/verify-return?session_id=${encodeURIComponent(sid)}`);
      if (typeof vr.messages_remaining === "number") {
        me.messages_remaining = vr.messages_remaining;
        if (balLine) balLine.textContent = `Pozostało: ${me.messages_remaining} wiadomości`;
      }
    } catch {
      /* ignore */
    }
  }

  const note = paymentsConfig?.notices?.checkout;
  if (gatewayNote && note) {
    gatewayNote.textContent = note;
    gatewayNote.hidden = false;
  }
  syncGatewayPicker();
  renderPackages();

  // Auto-uzupełnij kod promocyjny z localStorage (zapisany przez popup)
  const savedCode = getSavedPromoCode();
  if (savedCode && promoInput && !appliedPromo) {
    promoInput.value = savedCode;
    await applyPromoCode();
    // Jeśli kod się zastosował poprawnie — wyczyść localStorage
    if (appliedPromo) clearSavedPromoCode();
  }
} catch {
  window.location.href = "/logowanie.html";
}
