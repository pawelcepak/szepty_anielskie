function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function renderList(listEl, values) {
  if (!listEl || !Array.isArray(values) || !values.length) return;
  listEl.innerHTML = values.map((item) => `<li>${text(item)}</li>`).join("");
}

async function loadSiteConfig() {
  try {
    const res = await fetch("/api/public/site-config", { credentials: "same-origin" });
    if (!res.ok) throw new Error("Brak konfiguracji");
    return await res.json();
  } catch {
    return null;
  }
}

function setAll(selector, value) {
  for (const el of document.querySelectorAll(selector)) {
    el.textContent = value;
  }
}

(async () => {
  const cfg = await loadSiteConfig();
  if (!cfg) return;

  const domain = text(cfg.domain, window.location.host);
  const company = cfg.company || {};
  const pricing = cfg.pricing || {};
  const legal = cfg.legal || {};
  const privacy = cfg.privacy || {};

  setAll('[data-config="brandName"]', text(cfg.brandName, "Szepty Anielskie"));
  setAll('[data-config="domain"]', domain);
  setAll('[data-config="ownerFullName"]', text(company.ownerFullName, "[Imię Nazwisko]"));
  setAll('[data-config="businessName"]', text(company.businessName, "[Nazwa firmy]"));
  setAll('[data-config="nip"]', text(company.nip, "[NIP]"));
  setAll('[data-config="address"]', text(company.address, "[adres]"));
  setAll('[data-config="email"]', text(company.email, "[email]"));
  setAll('[data-config="paymentOperator"]', text(pricing.paymentOperator, "PayU"));
  setAll('[data-config="complaintsEmail"]', text(legal.complaintsEmail, text(company.email, "[email]")));
  setAll('[data-config="complaintsDays"]', String(legal.complaintsResponseBusinessDays ?? 14));
  setAll('[data-config="noticeDays"]', String(legal.regulationChangeNoticeDays ?? 14));
  setAll('[data-config="taxYears"]', String(legal.taxRetentionYears ?? 5));

  const contactEmail = text(company.email, text(legal.complaintsEmail, "kontakt@example.com"));
  for (const link of document.querySelectorAll("[data-support-email-link]")) {
    link.setAttribute("href", `mailto:${contactEmail}`);
  }

  const packages = Array.isArray(pricing.clientPackages) ? pricing.clientPackages : [];
  const packageListInline = document.getElementById("package-list-inline");
  if (packageListInline && packages.length) {
    packageListInline.textContent = packages.map((pkg) => Number(pkg.amount)).join(", ");
  }

  renderList(document.getElementById("privacy-registration-fields"), privacy.registrationFields);
  renderList(document.getElementById("privacy-automatic-fields"), privacy.automaticFields);
})();
