/**
 * promo-popup.js
 * Dołącz na każdej stronie klienckiej (landing, logowanie, rejestracja).
 * Wykrywa ?ref= / ?camp= / ?campaign= w URL, pobiera kampanię, pokazuje modal.
 * Kod vouchera zapisywany w localStorage → auto-uzupełniany przy doładowaniu.
 */

const STORAGE_KEY = "promo_voucher_code";
const STORAGE_SHOWN_KEY = "promo_popup_shown";

function getRefFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return p.get("ref") || p.get("campaign") || p.get("camp") || "";
}

function saveVoucherCode(code) {
  try { localStorage.setItem(STORAGE_KEY, code); } catch {}
}

function markShown(campaignKey) {
  try { sessionStorage.setItem(STORAGE_SHOWN_KEY, campaignKey); } catch {}
}

function wasShown(campaignKey) {
  try { return sessionStorage.getItem(STORAGE_SHOWN_KEY) === campaignKey; } catch { return false; }
}

function buildModal(campaign, code) {
  const discount = Number(campaign.discount_percent || 0);
  const content = campaign.popup_content || `Odbierz ${discount}% zniżki na pakiet wiadomości!`;

  const overlay = document.createElement("div");
  overlay.id = "promo-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Oferta specjalna");

  overlay.innerHTML = `
    <div class="promo-modal" id="promo-modal">
      <div class="promo-modal-badge">−${discount}%</div>
      <h2 class="promo-modal-title">${escHtml(campaign.label)}</h2>
      <p class="promo-modal-body">${escHtml(content)}</p>
      <div class="promo-modal-code-wrap">
        <span class="promo-modal-code-label">Twój kod rabatowy:</span>
        <div class="promo-modal-code-row">
          <span class="promo-modal-code" id="promo-modal-code-val">${escHtml(code)}</span>
          <button type="button" class="promo-modal-copy-btn" id="promo-copy-btn" title="Skopiuj kod">Kopiuj</button>
        </div>
        <p class="promo-modal-code-hint">Wpisz ten kod przy zakupie pakietu — zniżka naliczy się automatycznie.</p>
      </div>
      <a href="/panel-doladowanie.html" class="promo-modal-cta" id="promo-cta-btn">Kup pakiet z rabatem →</a>
      ${campaign.end_at ? `<p class="promo-modal-expires">Oferta ważna do: ${formatExpiry(campaign.end_at)}</p>` : ""}
      <button type="button" class="promo-modal-close" id="promo-close-btn" aria-label="Zamknij">✕</button>
    </div>
  `;

  return overlay;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatExpiry(iso) {
  try {
    return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return iso; }
}

function injectStyles() {
  if (document.getElementById("promo-popup-styles")) return;
  const style = document.createElement("style");
  style.id = "promo-popup-styles";
  style.textContent = `
    #promo-overlay {
      position: fixed;
      inset: 0;
      background: rgba(16,12,8,0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 1rem;
      animation: promo-fadein 0.25s ease;
    }
    @keyframes promo-fadein {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    .promo-modal {
      background: #1a1410;
      border: 1px solid rgba(212,175,101,0.35);
      border-radius: 16px;
      padding: 2rem 2rem 1.6rem;
      max-width: 420px;
      width: 100%;
      position: relative;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(212,175,101,0.1);
      animation: promo-slidein 0.28s cubic-bezier(0.34,1.56,0.64,1);
      color: #f0e6d0;
    }
    @keyframes promo-slidein {
      from { transform: translateY(24px) scale(0.97); opacity: 0; }
      to   { transform: translateY(0) scale(1); opacity: 1; }
    }
    .promo-modal-badge {
      display: inline-block;
      background: linear-gradient(135deg, #d4af65, #a87c30);
      color: #1a1410;
      font-weight: 800;
      font-size: 1.25rem;
      padding: 0.3em 0.85em;
      border-radius: 999px;
      margin-bottom: 1rem;
      letter-spacing: 0.02em;
    }
    .promo-modal-title {
      font-size: 1.2rem;
      font-weight: 700;
      margin: 0 0 0.6rem;
      color: #f0e6d0;
      line-height: 1.3;
    }
    .promo-modal-body {
      font-size: 0.95rem;
      color: rgba(240,230,208,0.8);
      margin: 0 0 1.2rem;
      line-height: 1.55;
    }
    .promo-modal-code-wrap {
      background: rgba(212,175,101,0.08);
      border: 1px solid rgba(212,175,101,0.25);
      border-radius: 10px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.2rem;
    }
    .promo-modal-code-label {
      display: block;
      font-size: 0.75rem;
      color: rgba(212,175,101,0.7);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 0.45rem;
      font-weight: 600;
    }
    .promo-modal-code-row {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .promo-modal-code {
      font-family: 'IBM Plex Mono', 'Courier New', monospace;
      font-size: 1.45rem;
      font-weight: 700;
      color: #d4af65;
      letter-spacing: 0.12em;
      flex: 1;
    }
    .promo-modal-copy-btn {
      background: rgba(212,175,101,0.15);
      border: 1px solid rgba(212,175,101,0.3);
      color: #d4af65;
      font-size: 0.78rem;
      font-weight: 600;
      padding: 0.3em 0.75em;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .promo-modal-copy-btn:hover { background: rgba(212,175,101,0.28); }
    .promo-modal-code-hint {
      font-size: 0.75rem;
      color: rgba(240,230,208,0.5);
      margin: 0.5rem 0 0;
    }
    .promo-modal-cta {
      display: block;
      text-align: center;
      background: linear-gradient(135deg, #d4af65, #a87c30);
      color: #1a1410;
      font-weight: 700;
      font-size: 0.97rem;
      padding: 0.75em 1.5em;
      border-radius: 10px;
      text-decoration: none;
      transition: opacity 0.15s, transform 0.15s;
      margin-bottom: 0.6rem;
    }
    .promo-modal-cta:hover { opacity: 0.9; transform: translateY(-1px); }
    .promo-modal-expires {
      font-size: 0.73rem;
      color: rgba(240,230,208,0.4);
      text-align: center;
      margin: 0;
    }
    .promo-modal-close {
      position: absolute;
      top: 0.85rem;
      right: 0.85rem;
      background: none;
      border: none;
      color: rgba(240,230,208,0.4);
      font-size: 1.1rem;
      cursor: pointer;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      transition: color 0.15s;
      line-height: 1;
    }
    .promo-modal-close:hover { color: #f0e6d0; }
  `;
  document.head.appendChild(style);
}

function closePromo(overlay) {
  overlay.style.opacity = "0";
  overlay.style.transition = "opacity 0.2s";
  setTimeout(() => overlay.remove(), 200);
}

async function initPromoPopup() {
  const ref = getRefFromUrl();
  if (!ref) return;

  // Persist ref across navigation (rejestracja → logowanie → panel)
  try { sessionStorage.setItem("promo_ref", ref); } catch {}

  if (wasShown(ref)) return;

  try {
    const res = await fetch(`/api/public/promo/bootstrap?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return;
    const data = await res.json();

    if (!data.enabled || !data.popup_enabled || !data.campaign) return;

    const campaign = data.campaign;
    const discount = Number(campaign.discount_percent || 0);
    if (discount <= 0) return;

    // Determine code to show: voucher_code from campaign (returned in campaign.voucher_code
    // if set) OR generate unique code via claim-code
    let codeToShow = null;

    // Backend now returns voucher_code in campaign object if set
    if (campaign.voucher_code) {
      codeToShow = campaign.voucher_code;
    } else {
      // Generate unique code via claim-code (no email required if capture_email=false)
      if (!campaign.capture_email) {
        try {
          const claimRes = await fetch("/api/public/promo/claim-code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_key: campaign.key }),
          });
          if (claimRes.ok) {
            const claimData = await claimRes.json();
            codeToShow = claimData.code || null;
          }
        } catch {}
      }
    }

    if (!codeToShow) return;

    saveVoucherCode(codeToShow);
    markShown(ref);

    injectStyles();
    const overlay = buildModal(campaign, codeToShow);
    document.body.appendChild(overlay);

    // Copy button
    document.getElementById("promo-copy-btn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(codeToShow).then(() => {
        const btn = document.getElementById("promo-copy-btn");
        if (btn) { btn.textContent = "Skopiowano!"; setTimeout(() => { btn.textContent = "Kopiuj"; }, 1800); }
      }).catch(() => {
        const el = document.getElementById("promo-modal-code-val");
        if (el) { const r = document.createRange(); r.selectNode(el); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(r); }
      });
    });

    // Close button
    document.getElementById("promo-close-btn")?.addEventListener("click", () => closePromo(overlay));

    // Click outside to close
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePromo(overlay); });

    // Esc to close
    document.addEventListener("keydown", function handler(e) {
      if (e.key === "Escape") { closePromo(overlay); document.removeEventListener("keydown", handler); }
    });

  } catch (err) {
    // Silent fail — popup is optional
  }
}

// Export so panel-doladowanie.js can read saved code
export function getSavedPromoCode() {
  try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}

export function clearSavedPromoCode() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// Run immediately
initPromoPopup();
