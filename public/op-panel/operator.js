async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Błąd ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Czasy z SQLite `datetime('now')` / kolumn trzymane są w UTC — w panelu pokazujemy Europe/Warsaw. */
function parseUtcSqliteDateTime(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  if (raw.includes("T") && (raw.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(raw))) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0));
}

function formatOpPlTime(s) {
  const d = parseUtcSqliteDateTime(s);
  if (!d) return String(s ?? "");
  return d.toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatOpPlTimeShort(s) {
  const d = parseUtcSqliteDateTime(s);
  if (!d) return String(s ?? "");
  return d.toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const FALLBACK_CHAR =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200&h=200&fit=crop&q=75";

const FACT_NOTE_MAX = 150;

let schema = null;
let threads = [];
/** Filtr listy zgłoszeń (właściciel): open | resolved | all */
let ownerReportFilter = "open";
let ownerReportsActionsBound = false;
let ownerInsightsBound = false;
/** Zakładka listy rozmów: mine | pool | stopped | all | no_user */
let inboxBucket = "mine";
let activeId = null;
/** Ostatnio wczytane meta wątku (do podpisów wiadomości w czacie). */
let lastThreadMeta = null;
let lastFacts = [];
let opRole = "staff";
let opId = "";
let currentAssignment = null;
let touchTimer = null;
let assignHintTimer = null;
/** Liczba wiadomości pobieranych z API (15, potem +10). */
let messagesFetchLimit = 15;
let selectedAiMessageIds = new Set();
let currentThreadMessages = [];
const AI_PROMPT_STORAGE_KEY = "op-ai-prompt-v1";

const viewLogin = document.getElementById("view-login");
const viewApp = document.getElementById("view-app");
const ownerTabsEl = document.getElementById("owner-tabs");
const layoutWork = document.getElementById("layout-work");
const colInbox = document.getElementById("col-inbox");
const inboxBackdrop = document.getElementById("inbox-backdrop");
const btnInboxSidebar = document.getElementById("btn-inbox-sidebar");
const INBOX_COLLAPSE_KEY = "op-inbox-collapsed-v1";
const chatBody = document.getElementById("chat-body");
/** Czy są jeszcze starsze wiadomości do pobrania (większy limit niż obecna liczba). */
let messagesHasMore = false;
let messagesLoadingOlder = false;
let opMessagesScrollRaf = 0;
let ownerAdvancedTabsShown = false;
let ownerClientsActionsBound = false;
let ownerAdvancedUnlocked = false;
let ownerMarketingBound = false;
let marketingSelectedChannels = new Set(["instagram", "tiktok"]);
const TEASER_TEMPLATES_KEY = "owner-teaser-templates-v1";
const MKT_IMAGE_KEY_STORAGE = "owner-mkt-image-openai-key-v1";
const DEFAULT_TEASER_TEMPLATES = [
  "Witaj! Jeśli chcesz, mogę pomóc Ci spojrzeć spokojnie na Twoją obecną sytuację i podpowiedzieć pierwszy krok.",
  "Cześć! Widzę, że możesz potrzebować wsparcia. Napisz 2-3 zdania o tym, co teraz jest dla Ciebie najważniejsze.",
  "Dzień dobry! Jeśli masz pytanie o relacje, pracę lub kierunek działania, chętnie pomogę w krótkiej konsultacji.",
  "Witaj! Możesz opisać, co najbardziej Cię teraz martwi, a przygotuję konkretną odpowiedź krok po kroku.",
  "Cześć! Jeśli chcesz, zaczniemy od jednego pytania przewodniego i ustalimy, co warto zrobić najpierw.",
];
const MARKETING_STARTER_PRESETS = [
  "Nowy tydzień, nowa energia",
  "Krótka wróżba dnia",
  "Tarot na dziś",
  "3 znaki, że czas na zmianę",
  "Relacje: sygnały, których nie warto ignorować",
  "Jak odzyskać spokój po stresie",
  "Mini rytuał na dobry dzień",
  "Astrologiczna wskazówka tygodnia",
  "Jak zadawać dobre pytania do konsultacji",
  "Pierwsza konsultacja: od czego zacząć",
];
const MARKETING_GROWTH_PRESETS = [
  "Powrót klienta po 7 dniach",
  "Pakiet 20 wiadomości - przypomnienie",
  "Historia przemiany klientki",
  "Q&A: najczęstsze pytania o tarot",
  "TikTok: 3 szybkie porady relacyjne",
  "Instagram Reels: karta dnia",
  "Kampania weekendowa: relacje",
  "Kampania weekendowa: praca i finanse",
  "Lookalike: podobni do aktywnych klientów",
  "Remarketing: porzucony panel rozmów",
  "Cross-sell: tarot + astrologia",
  "Urodzinowa kampania klienta",
  "Reaktywacja klienta po 30 dniach",
  "Seria edukacyjna: mity o wróżbach",
  "Przewodnik: jak korzystać z konsultacji",
  "Sezonowa kampania pełni księżyca",
  "Mikro-oferta: 10 wiadomości start",
  "Oferta premium: 100 wiadomości",
  "Newsletter: horoskop tygodnia",
  "Pinterest: inspiracje duchowe",
];

function showLogin(on) {
  viewLogin.classList.toggle("hidden", !on);
  viewApp.classList.toggle("hidden", on);
}

function setInboxOpen(open) {
  colInbox.classList.toggle("is-open", open);
  inboxBackdrop.hidden = !open;
}

function isWideInboxLayout() {
  return window.matchMedia("(min-width: 1280px)").matches;
}

/** Lista rozmów jako osobny widok (nie zawsze widoczny panel). */
function rozmowySetOpen(open) {
  if (!layoutWork) return;
  if (opRole === "owner") {
    layoutWork.classList.toggle("layout-work--inbox-collapsed", !open);
    if (btnInboxSidebar) btnInboxSidebar.setAttribute("aria-pressed", open ? "true" : "false");
    try {
      localStorage.setItem(
        INBOX_COLLAPSE_KEY,
        layoutWork.classList.contains("layout-work--inbox-collapsed") ? "1" : "0"
      );
    } catch {
      /* ignore */
    }
    if (!isWideInboxLayout()) setInboxOpen(false);
    return;
  }
  if (isWideInboxLayout()) {
    layoutWork.classList.toggle("layout-work--sidebar-hidden", !open);
    if (btnInboxSidebar) btnInboxSidebar.setAttribute("aria-pressed", open ? "true" : "false");
  } else {
    layoutWork.classList.remove("layout-work--sidebar-hidden");
    setInboxOpen(open);
    if (btnInboxSidebar) btnInboxSidebar.setAttribute("aria-pressed", open ? "true" : "false");
  }
}

function rozmowyToggle() {
  if (opRole === "owner") {
    const collapsed = layoutWork.classList.contains("layout-work--inbox-collapsed");
    rozmowySetOpen(collapsed);
    return;
  }
  if (isWideInboxLayout()) {
    const hidden = layoutWork.classList.contains("layout-work--sidebar-hidden");
    rozmowySetOpen(hidden);
  } else {
    rozmowySetOpen(!colInbox.classList.contains("is-open"));
  }
}

/** Klasa kolorystyczna grupy notatek (kategoria). */
function factGroupClass(scope, category) {
  if (scope === "consultant") {
    if (category === "persona") return "fact-cat fact-cat--medium";
    return "fact-cat fact-cat--inne";
  }
  const map = {
    dane_osobowe: "fact-cat fact-cat--osobowe",
    rodzina: "fact-cat fact-cat--rodzina",
    zainteresowania: "fact-cat fact-cat--zainteresowania",
    zdrowie: "fact-cat fact-cat--zdrowie",
    inne: "fact-cat fact-cat--inne",
    personal_info: "fact-cat fact-cat--osobowe",
    hobby: "fact-cat fact-cat--zainteresowania",
    work: "fact-cat fact-cat--osobowe",
    other: "fact-cat fact-cat--inne",
  };
  return map[category] || "fact-cat fact-cat--inne";
}

/** Krótka etykieta wiersza (bez „— notatka”). Dla Rodzina/Inne + notatka — pusty (tylko treść). */
function factListRowLabel(scope, category, field) {
  if (scope === "client" && (category === "rodzina" || category === "inne") && field === "notatka") {
    return "";
  }
  const block = catBlockFor(scope, category);
  const catLabel = block?.label || category;
  const f = block?.fields?.find((x) => x.key === field);
  const fieldLabel = f?.label || field;
  return `${catLabel} — ${fieldLabel}`;
}

function updateFactNoteCharCounts() {
  for (const [taId, countId] of [
    ["fk-val", "fk-char-count"],
    ["fc-val", "fc-char-count"],
  ]) {
    const ta = document.getElementById(taId);
    const el = document.getElementById(countId);
    if (!ta || !el) continue;
    el.textContent = `${ta.value.length}/${FACT_NOTE_MAX}`;
  }
}

function fillCategoryField(scope, catSel, fieldSel) {
  const list = schema?.[scope] || [];
  const curCat = catSel.value || list[0]?.key;
  catSel.innerHTML = "";
  for (const c of list) {
    const opt = document.createElement("option");
    opt.value = c.key;
    const sub = c.subtitle ? ` (${c.subtitle})` : "";
    opt.textContent = `${c.label}${sub}`;
    catSel.appendChild(opt);
  }
  if (curCat && list.some((c) => c.key === curCat)) catSel.value = curCat;
  const cat = list.find((c) => c.key === catSel.value) || list[0];
  fieldSel.innerHTML = "";
  if (!cat) return;
  const used = new Set();
  const groups = cat.fieldGroups;
  if (groups?.length) {
    for (const g of groups) {
      const og = document.createElement("optgroup");
      og.label = g.label;
      for (const key of g.keys || []) {
        const f = cat.fields.find((x) => x.key === key);
        if (!f) continue;
        used.add(f.key);
        const opt = document.createElement("option");
        opt.value = f.key;
        opt.textContent = f.label;
        og.appendChild(opt);
      }
      if (og.childNodes.length) fieldSel.appendChild(og);
    }
  }
  for (const f of cat.fields) {
    if (used.has(f.key)) continue;
    const opt = document.createElement("option");
    opt.value = f.key;
    opt.textContent = f.label;
    fieldSel.appendChild(opt);
  }
}

let panelListenersBound = false;

function showClearFact(r) {
  if (opRole === "owner") return true;
  return !!(r.created_operator_id && r.created_operator_id === opId);
}

function catBlockFor(scope, category) {
  return schema?.[scope]?.find((c) => c.key === category);
}

function appendFactItems(ul, scope, items) {
  for (const r of items) {
    const li = document.createElement("li");
    const lab = factListRowLabel(scope, r.category, r.field);
    li.className = "fact-li" + (lab ? "" : " fact-li--value-only");
    const who =
      opRole === "owner"
        ? `<span class="fact-author-tag">${esc(r.created_operator_email || "—")}</span>`
        : "";
    const fid = r.id ? esc(String(r.id)) : "";
    const clearBtn =
      r.id && showClearFact(r)
        ? `<button type="button" class="fact-li-clear" data-fact-id="${fid}" data-scope="${r.scope}" data-cat="${r.category}" data-field="${r.field}" title="Usuń">×</button>`
        : "";
    const labelHtml = lab ? `<span class="fact-li-label">${esc(lab)}</span>` : "";
    li.innerHTML = `<div class="fact-li-top">
        ${labelHtml}<span class="fact-li-actions">${who}${clearBtn}</span>
      </div>
      <div class="fact-li-val">${esc(r.value)}</div>`;
    ul.appendChild(li);
  }
}

function renderFactList(scope, listEl) {
  const rows = lastFacts.filter((x) => x.scope === scope);
  listEl.innerHTML = "";
  if (!rows.length) {
    listEl.innerHTML = `<p class="fact-empty">Brak zapisanych pól — dodaj pierwszą notatkę.</p>`;
    return;
  }
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const ts = (r) => new Date(r.updated_at || 0).getTime();
  const catEntries = [...byCat.entries()].sort(([, ra], [, rb]) => {
    const maxA = Math.max(0, ...ra.map(ts));
    const maxB = Math.max(0, ...rb.map(ts));
    return maxB - maxA;
  });
  for (const [cat, rawItems] of catEntries) {
    const items = [...rawItems].sort((a, b) => {
      const d = ts(b) - ts(a);
      if (d !== 0) return d;
      return (Number(b.slot) || 0) - (Number(a.slot) || 0);
    });
    const block = catBlockFor(scope, cat);
    const catLabel = block?.label || cat;
    const sub = block?.subtitle ? ` <span class="fact-cat-sub">(${esc(block.subtitle)})</span>` : "";
    const wrap = document.createElement("div");
    wrap.className = `fact-group ${factGroupClass(scope, cat)}`;
    wrap.innerHTML = `<h4 class="fact-group-title">${esc(catLabel)}${sub}</h4>`;
    const ul = document.createElement("ul");
    ul.className = "fact-ul";
    appendFactItems(ul, scope, items);
    wrap.appendChild(ul);
    listEl.appendChild(wrap);
  }
  listEl.querySelectorAll(".fact-li-clear").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!activeId) return;
      const factId = btn.getAttribute("data-fact-id") || "";
      const body = {
        scope: btn.dataset.scope,
        category: btn.dataset.cat,
        field: btn.dataset.field,
        value: "",
      };
      if (factId) body.fact_id = factId;
      await api(`/api/op/inbox/${encodeURIComponent(activeId)}/facts`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await reloadThreadData();
    });
  });
}

function clearTouch() {
  if (touchTimer) {
    clearInterval(touchTimer);
    touchTimer = null;
  }
}

function clearAssignHint() {
  if (assignHintTimer) {
    clearInterval(assignHintTimer);
    assignHintTimer = null;
  }
  updateReplyDeadlineChip(null);
}

function fmtRemain(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "minął";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  if (m) return `${m} min ${s} s`;
  return `${s} s`;
}

/** Kompaktowe odliczanie przy „Wyślij” (tylko pracownik, przejęty wątek). */
function updateReplyDeadlineChip(assignmentOverride) {
  const chip = document.getElementById("reply-deadline-chip");
  if (!chip) return;
  const asg = arguments.length ? assignmentOverride : currentAssignment;
  if (!asg || asg.is_owner || !asg.assigned_to_me || !asg.response_due_at) {
    chip.classList.add("hidden");
    chip.textContent = "";
    return;
  }
  chip.classList.remove("hidden");
  const parts = [`odpowiedź: ${fmtRemain(asg.response_due_at)}`];
  if (asg.idle_kick_at) parts.push(`bezczynność: ${fmtRemain(asg.idle_kick_at)}`);
  chip.textContent = parts.join(" · ");
}

function setPanelLocked(lock) {
  chatBody.classList.toggle("needs-claim", lock);
  document.getElementById("reply").disabled = lock;
  document.getElementById("btn-send").disabled = lock;
  document.getElementById("fc-save").disabled = lock;
  document.getElementById("fk-save").disabled = lock;
  document.getElementById("fc-val").disabled = lock;
  document.getElementById("fk-val").disabled = lock;
  document.getElementById("fc-cat").disabled = lock;
  document.getElementById("fc-field").disabled = lock;
  document.getElementById("fk-cat").disabled = lock;
  document.getElementById("fk-field").disabled = lock;
}

function applyAssignmentUI(a) {
  currentAssignment = a;
  clearAssignHint();

  if (!a) {
    setPanelLocked(false);
    updateReplyDeadlineChip(null);
    clearTouch();
    updateReplyMeta();
    return;
  }

  const isOwner = a.is_owner;
  setPanelLocked(false);

  const wantTouch =
    activeId && opRole !== "owner" && a.assigned_to_me && a.response_due_at;
  if (!wantTouch) {
    clearTouch();
  } else if (!touchTimer) {
    touchTimer = setInterval(() => {
      if (!activeId || !currentAssignment?.assigned_to_me || !currentAssignment?.response_due_at) {
        return;
      }
      api(`/api/op/inbox/${encodeURIComponent(activeId)}/touch`, { method: "POST" }).catch(
        () => {}
      );
    }, 45000);
  }

  if (isOwner) {
    updateReplyDeadlineChip(null);
  } else if (a.assigned_to_me && a.response_due_at) {
    updateReplyDeadlineChip();
    assignHintTimer = setInterval(() => updateReplyDeadlineChip(), 1000);
  } else {
    updateReplyDeadlineChip(null);
  }
  updateReplyMeta();
}

function applyRoleChrome() {
  const hub = document.getElementById("staff-hub-panel");
  const sub = document.getElementById("inbox-subtitle");
  const bucketTabs = document.getElementById("inbox-bucket-tabs");
  const mainTitle = document.getElementById("inbox-main-title");
  const line1 = document.getElementById("chat-empty-line1");
  const chatEmptyTip = document.getElementById("chat-empty-tip");
  const chatEmpty = document.getElementById("chat-empty");
  const ob = document.getElementById("owner-mode-banner");
  const linkClient = document.getElementById("header-link-client");
  const linkRecruit = document.getElementById("header-link-recruit");
  const staffSub = document.getElementById("staff-top-subnav");
  const advWrap = document.getElementById("owner-advanced-toggle-wrap");
  const advBtn = document.getElementById("owner-advanced-toggle");
  inboxBucket = opRole === "owner" ? "pending" : "mine";
  layoutWork?.classList.remove("layout-work--sidebar-hidden");
  setInboxOpen(false);
  btnInboxSidebar?.setAttribute("aria-pressed", "false");
  if (opRole !== "owner") layoutWork?.classList.remove("layout-work--inbox-collapsed");
  btnInboxSidebar?.classList.toggle("hidden", opRole !== "owner");
  staffSub?.classList.toggle("hidden", opRole === "owner");
  const logoMain = document.getElementById("op-logo-main");
  if (logoMain) {
    logoMain.title =
      opRole === "owner" ? "Panel pracy — Szepty Anielskie" : "Szept — powrót do pulpitu pracownika";
  }
  if (opRole === "owner") {
    hub.classList.add("hidden");
    sub.classList.add("hidden");
    bucketTabs?.classList.remove("hidden");
    ownerTabsEl?.classList.remove("hidden");
    advWrap?.classList.add("hidden");
    ownerAdvancedTabsShown = false;
    ownerAdvancedUnlocked = false;
    document.querySelectorAll(".owner-tab--advanced").forEach((el) => el.classList.add("hidden"));
    if (advBtn) advBtn.textContent = "Narzędzia ukryte";
    ob?.classList.remove("hidden");
    linkClient?.classList.remove("hidden");
    linkRecruit?.classList.add("hidden");
    mainTitle.textContent = "Lista rozmów (administrator)";
    line1.textContent =
      "Wątki po lewej (jak w komunikatorze). U góry: Monitor, Klienci, Reklama. Pracownicy nie widzą witryny klienta.";
    if (chatEmptyTip) {
      chatEmptyTip.innerHTML =
        "Na węższym ekranie: przycisk <strong>Lista</strong> lub <strong>Ctrl+B</strong> — pokazuje / ukrywa listę rozmów.";
    }
    chatEmpty.classList.remove("hidden");
    layoutWork.classList.remove("hidden");
    layoutWork.classList.add("layout-work--owner");
    layoutWork.classList.remove("layout-work--staff");
    setOwnerTab("inbox");
  } else {
    hub.classList.remove("hidden");
    sub.classList.add("hidden");
    bucketTabs?.classList.add("hidden");
    ownerTabsEl?.classList.add("hidden");
    advWrap?.classList.add("hidden");
    ob?.classList.add("hidden");
    linkClient?.classList.add("hidden");
    linkRecruit?.classList.add("hidden");
    mainTitle.textContent = "Lista rozmów";
    line1.textContent =
      "Jako pracownik lista rozmów jest w zakładce „Rozmowy” — stąd przechodzisz do wątku; odpowiedź piszesz dopiero w otwartym czacie.";
    if (chatEmptyTip) {
      chatEmptyTip.innerHTML =
        "Na węższym ekranie otwórz panel przyciskiem <strong>Panel boczny</strong>.";
    }
    chatEmpty.classList.add("hidden");
    layoutWork.classList.remove("hidden");
    layoutWork.classList.remove("layout-work--owner");
    layoutWork.classList.add("layout-work--staff");
    setStaffHubTab("main");
    [
      "owner-page-monitor",
      "owner-page-reports",
      "owner-page-team",
      "owner-page-insights",
      "owner-page-hr",
      "owner-page-kyc",
      "owner-page-clients",
      "owner-page-marketing",
    ].forEach((id) => {
      document.getElementById(id)?.classList.add("hidden");
    });
  }
}

function applyOwnerAdvancedVisibility() {
  const show = opRole === "owner" && ownerAdvancedUnlocked;
  document.querySelectorAll(".owner-tab--advanced").forEach((el) => el.classList.toggle("hidden", !show));
}

function setClientAdminActions(meta) {
  const box = document.getElementById("client-admin-actions");
  const st = document.getElementById("client-admin-status");
  const btnBlock = document.getElementById("btn-client-block");
  const btnUnblock = document.getElementById("btn-client-unblock");
  const btnEmail = document.getElementById("btn-client-email");
  const btnDelete = document.getElementById("btn-client-delete");
  const err = document.getElementById("client-admin-err");
  if (!box || !st || !btnBlock || !btnUnblock || !btnEmail || !btnDelete || !err) return;
  if (opRole !== "owner" || !meta?.user_id) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  err.hidden = true;
  err.textContent = "";
  const blocked = !!meta.client_profile.blocked_at;
  st.textContent = blocked
    ? `Status konta: zablokowane (${formatOpPlTime(meta.client_profile.blocked_at)})`
    : "Status konta: aktywne";
  btnBlock.classList.toggle("hidden", blocked);
  btnUnblock.classList.toggle("hidden", !blocked);
  const dlg = document.getElementById("client-email-dialog");
  const subj = document.getElementById("client-email-subject");
  const txt = document.getElementById("client-email-text");
  const dlgErr = document.getElementById("client-email-dlg-err");
  const emailForm = document.getElementById("client-email-form");
  const btnCancel = document.getElementById("client-email-cancel");
  btnEmail.onclick = () => {
    if (!dlg || !subj || !txt || !dlgErr) return;
    subj.value = "";
    txt.value = "";
    dlgErr.hidden = true;
    dlgErr.textContent = "";
    dlg.showModal();
  };
  btnCancel.onclick = () => dlg?.close();
  if (emailForm) {
    emailForm.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!meta?.user_id || !subj || !txt || !dlgErr) return;
      dlgErr.hidden = true;
      try {
        await api(`/api/op/clients/${encodeURIComponent(meta.user_id)}/email`, {
          method: "POST",
          body: JSON.stringify({
            subject: subj.value.trim(),
            text: txt.value.trim(),
          }),
        });
        dlg?.close();
      } catch (e) {
        dlgErr.textContent = e.message || String(e);
        dlgErr.hidden = false;
      }
    };
  }
  btnBlock.onclick = async () => {
    if (!window.confirm("Na pewno zablokować to konto klienta?")) return;
    try {
      await api(`/api/op/clients/${encodeURIComponent(meta.user_id || "")}/block`, {
        method: "PATCH",
        body: JSON.stringify({ blocked: true }),
      });
      await reloadThreadData();
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  };
  btnUnblock.onclick = async () => {
    if (!window.confirm("Odblokować to konto klienta?")) return;
    try {
      await api(`/api/op/clients/${encodeURIComponent(meta.user_id || "")}/block`, {
        method: "PATCH",
        body: JSON.stringify({ blocked: false }),
      });
      await reloadThreadData();
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  };
  const delDlg = document.getElementById("client-delete-dialog");
  const delForm = document.getElementById("client-delete-form");
  const delPhrase = document.getElementById("client-delete-phrase");
  const delPass = document.getElementById("client-delete-password");
  const delErr = document.getElementById("client-delete-err");
  const delCancel = document.getElementById("client-delete-cancel");
  btnDelete.onclick = () => {
    if (!delDlg || !delPhrase || !delPass || !delErr) return;
    delPhrase.value = "";
    delPass.value = "";
    delErr.hidden = true;
    delErr.textContent = "";
    delDlg.showModal();
  };
  delCancel.onclick = () => delDlg?.close();
  if (delForm) {
    delForm.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!meta?.user_id || !delPhrase || !delPass || !delErr) return;
      delErr.hidden = true;
      delErr.textContent = "";
      try {
        await api(`/api/op/clients/${encodeURIComponent(meta.user_id)}/delete`, {
          method: "POST",
          body: JSON.stringify({
            confirm_phrase: delPhrase.value.trim(),
            owner_password: delPass.value,
          }),
        });
        delDlg?.close();
        activeId = null;
        lastThreadMeta = null;
        document.getElementById("chat-body")?.classList.add("hidden");
        document.getElementById("chat-empty")?.classList.remove("hidden");
        await refreshInbox();
      } catch (e) {
        delErr.textContent = e.message || String(e);
        delErr.hidden = false;
      }
    };
  }
}

function initTheme() {
  const t = localStorage.getItem("op-theme") || "light";
  document.documentElement.dataset.theme = t;
  const bt = document.getElementById("btn-theme-toggle");
  if (bt) bt.textContent = t === "dark" ? "Jasny motyw" : "Ciemny motyw";
}

initTheme();
document.getElementById("btn-theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("op-theme", next);
  document.documentElement.dataset.theme = next;
  initTheme();
});

document.getElementById("btn-staff-tab-main")?.addEventListener("click", () => setStaffHubTab("main"));
document.getElementById("btn-staff-tab-conv")?.addEventListener("click", () => setStaffHubTab("conv"));
document.getElementById("btn-staff-tab-payout")?.addEventListener("click", () => setStaffHubTab("payout"));

let ownerConsoleHints = null;

async function loadOwnerConsoleHints() {
  if (opRole !== "owner") return null;
  if (ownerConsoleHints) return ownerConsoleHints;
  try {
    ownerConsoleHints = await api("/api/op/console/meta");
  } catch {
    ownerConsoleHints = {};
  }
  return ownerConsoleHints;
}

function setOwnerTab(tab) {
  if (opRole !== "owner") return;
  ownerTabsEl?.querySelectorAll(".owner-tab").forEach((b) => {
    b.classList.toggle("owner-tab--active", b.getAttribute("data-owner-tab") === tab);
  });
  for (const id of [
    "owner-page-monitor",
    "owner-page-reports",
    "owner-page-team",
    "owner-page-insights",
    "owner-page-hr",
    "owner-page-kyc",
    "owner-page-clients",
    "owner-page-marketing",
  ]) {
    const key = id.replace("owner-page-", "");
    document.getElementById(id)?.classList.toggle("hidden", tab !== key);
  }
  layoutWork.classList.toggle("hidden", tab !== "inbox");
  if (tab === "inbox") {
    layoutWork.classList.remove("layout-work--sidebar-hidden");
    setInboxOpen(false);
    const collapsed = layoutWork.classList.contains("layout-work--inbox-collapsed");
    btnInboxSidebar?.setAttribute("aria-pressed", collapsed ? "false" : "true");
  }
  if (tab === "monitor") refreshOwnerMonitor();
  if (tab === "reports") refreshOwnerReports();
  if (tab === "insights") refreshOwnerTeamInsights();
  if (tab === "team") refreshStaffList();
  if (tab === "clients") refreshOwnerClients();
  if (tab === "marketing") refreshOwnerMarketing();
  if (tab === "hr" || tab === "kyc") {
    const which = tab;
    loadOwnerConsoleHints().then((h) => {
      const hrEl = document.getElementById("owner-hr-dynamic");
      const kycEl = document.getElementById("owner-kyc-dynamic");
      if (which === "hr" && hrEl) {
        hrEl.textContent =
          h?.hr_pipeline_hint ||
          "(Ustaw HR_SUPPORT_PIPELINE_NOTES w .env, żeby wyświetlić tu własną notatkę operacyjną.)";
      }
      if (which === "kyc" && kycEl) {
        const a = h?.kyc_vendor_hint || "(Ustaw KYC_VENDOR_NAME w .env — np. nazwa integratora.)";
        const b = h?.kyc_flow_hint || "";
        kycEl.textContent = b ? `${a} — ${b}` : a;
      }
    });
  }
}

function updateReplyMeta() {
  const el = document.getElementById("reply-meta");
  const bar = document.getElementById("reply-char-bar");
  const ta = document.getElementById("reply");
  const send = document.getElementById("btn-send");
  if (!el || !ta || !send) return;
  const n = ta.value.length;
  const min = currentAssignment?.min_reply_chars ?? (opRole === "owner" ? 20 : 100);
  const max = currentAssignment?.reply_max_chars ?? (opRole === "owner" ? 1500 : 900);
  if (bar) {
    if (opRole === "owner") {
      bar.hidden = false;
      bar.textContent = `${n}/${max}`;
      bar.classList.toggle("reply-char-bar--warn", n > max * 0.95);
    } else {
      bar.hidden = true;
      bar.textContent = "";
    }
  }
  el.textContent =
    opRole === "owner"
      ? `Minimum ${min} znaków.`
      : `Znaki w odpowiedzi: ${n} (wymagane minimum ${min}, maks. ${max}).`;
  const okLen = n >= min && n <= max;
  send.disabled = !okLen || !activeId;
}

function setStaffHubTab(which) {
  const main = document.getElementById("staff-hub-main-view");
  const conv = document.getElementById("staff-hub-conv-view");
  const pay = document.getElementById("staff-hub-payout-view");
  const bMain = document.getElementById("btn-staff-tab-main");
  const bConv = document.getElementById("btn-staff-tab-conv");
  const bPay = document.getElementById("btn-staff-tab-payout");
  if (!main || !pay) return;
  const isMain = which === "main";
  const isConv = which === "conv";
  const isPay = which === "payout";
  main.classList.toggle("hidden", !isMain);
  if (conv) conv.classList.toggle("hidden", !isConv);
  pay.classList.toggle("hidden", !isPay);
  bMain?.classList.toggle("btn-ghost--tab-active", isMain);
  bConv?.classList.toggle("btn-ghost--tab-active", isConv);
  bPay?.classList.toggle("btn-ghost--tab-active", isPay);
  if (isConv) refreshStaffConvView();
}

function goStaffHub() {
  if (opRole === "owner") return;
  setStaffHubTab("main");
  activeId = null;
  lastThreadMeta = null;
  currentAssignment = null;
  clearTouch();
  clearAssignHint();
  const chDet = document.getElementById("ch-profile-detail");
  if (chDet) {
    chDet.innerHTML = "";
    chDet.hidden = true;
  }
  document.getElementById("reply-err").hidden = true;
  const qe = document.getElementById("queue-err");
  if (qe) {
    qe.hidden = true;
    qe.textContent = "";
  }
  const soeHub = document.getElementById("staff-open-err");
  if (soeHub) {
    soeHub.textContent = "";
    soeHub.hidden = true;
  }
  document.getElementById("reply").value = "";
  document.getElementById("chat-body").classList.add("hidden");
  document.getElementById("staff-hub-panel").classList.remove("hidden");
  document.getElementById("chat-empty").classList.add("hidden");
  const sts = document.getElementById("side-thread-start");
  if (sts) {
    sts.textContent = "";
    sts.hidden = true;
  }
  layoutWork.classList.add("no-thread");
  document.querySelectorAll(".thread-item").forEach((b) => b.classList.remove("active"));
  updateReplyMeta();
}

let ownerMonitorActionsBound = false;

function bindOwnerMonitorActionsOnce() {
  if (ownerMonitorActionsBound) return;
  if (!viewApp) return;
  ownerMonitorActionsBound = true;
  viewApp.addEventListener("click", async (ev) => {
    const revoke = ev.target.closest("button[data-op-revoke]");
    const block = ev.target.closest("button[data-op-block]");
    const unblock = ev.target.closest("button[data-op-unblock]");
    const btn = revoke || block || unblock;
    if (!btn || opRole !== "owner") return;
    const oid = btn.getAttribute("data-operator-id");
    if (!oid) return;
    btn.disabled = true;
    try {
      if (revoke) {
        await api(`/api/op/operators/${encodeURIComponent(oid)}/revoke-sessions`, { method: "POST" });
      } else if (block) {
        await api(`/api/op/operators/${encodeURIComponent(oid)}`, {
          method: "PATCH",
          body: JSON.stringify({ disabled: true }),
        });
      } else if (unblock) {
        await api(`/api/op/operators/${encodeURIComponent(oid)}`, {
          method: "PATCH",
          body: JSON.stringify({ disabled: false }),
        });
      }
      await refreshOwnerMonitor();
      await refreshStaffList();
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  });
}

let auditDetailClickBound = false;

function bindAuditDetailClickOnce() {
  if (auditDetailClickBound || !viewApp) return;
  auditDetailClickBound = true;
  viewApp.addEventListener("click", async (ev) => {
    const b = ev.target.closest(".btn-audit-open");
    if (!b || opRole !== "owner") return;
    const id = b.getAttribute("data-audit-id");
    if (!id) return;
    const dlg = document.getElementById("audit-dialog");
    const pre = document.getElementById("audit-dialog-body");
    if (!dlg || !pre) return;
    pre.textContent = "Ładowanie…";
    dlg.showModal();
    try {
      const r = await api(`/api/op/audit/${encodeURIComponent(id)}`);
      const raw = r.audit?.detail || "";
      try {
        pre.textContent = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        pre.textContent = String(raw);
      }
    } catch (e) {
      pre.textContent = e.message || String(e);
    }
  });
}

function renderMediumSidebar(meta) {
  const el = document.getElementById("ch-profile-detail");
  if (!el) return;
  const mp = meta.medium_profile || {};
  const skills = (mp.skills || "").trim();
  const about = (mp.about || "").trim();
  if (!skills && !about) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  const bits = [];
  if (skills) {
    bits.push(`<p class="ch-detail-skills"><span class="ch-detail-k">Krótko</span> ${esc(skills)}</p>`);
  }
  if (about) {
    bits.push(`<p class="ch-detail-about">${esc(about)}</p>`);
  }
  el.innerHTML = bits.join("");
  el.hidden = false;
}

function ownerGenderLabel(g) {
  if (g === "female") return "Kobieta";
  if (g === "male") return "Mężczyzna";
  if (g === "other") return "Inna";
  return "—";
}

function ownerTriStateLabel(v) {
  if (v === "yes") return "Tak";
  if (v === "no") return "Nie";
  return "—";
}

function clientTriStateLabel(v) {
  if (v === "yes") return "Tak";
  if (v === "no") return "Nie";
  return "—";
}

function ownerMonthLabel(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("pl-PL", { month: "long", year: "numeric" });
}

let ownerClientsFilterBound = false;

async function refreshOwnerClients() {
  if (opRole !== "owner") return;
  const body = document.getElementById("owner-clients-body");
  if (!body) return;
  if (!ownerClientsFilterBound) {
    ownerClientsFilterBound = true;
    document.getElementById("owner-clients-gender-filter")?.addEventListener("change", () => {
      refreshOwnerClients();
    });
    document.getElementById("owner-clients-sort")?.addEventListener("change", () => {
      refreshOwnerClients();
    });
  }
  if (!ownerClientsActionsBound) {
    ownerClientsActionsBound = true;
    body.addEventListener("click", async (ev) => {
      const verifyBtn = ev.target.closest("[data-client-verify-link]");
      const blockBtn = ev.target.closest("[data-client-block]");
      const unblockBtn = ev.target.closest("[data-client-unblock]");
      const deleteBtn = ev.target.closest("[data-client-delete]");
      const btn = verifyBtn || blockBtn || unblockBtn || deleteBtn;
      if (!btn) return;
      const clientId = btn.getAttribute("data-client-id");
      if (!clientId) return;
      btn.disabled = true;
      try {
        if (verifyBtn) {
          const data = await api(`/api/op/clients/${encodeURIComponent(clientId)}/verification-link`, {
            method: "POST",
            body: JSON.stringify({ regenerate: false }),
          });
          const u = String(data.verify_url || "");
          if (!u) throw new Error("Brak linku aktywacyjnego.");
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(u);
            alert("Link aktywacyjny skopiowany do schowka.");
          } else {
            window.prompt("Skopiuj link aktywacyjny:", u);
          }
        } else if (blockBtn || unblockBtn) {
          const blocked = !!blockBtn;
          const q = blocked ? "Zablokować klienta?" : "Odblokować klienta?";
          if (!window.confirm(q)) return;
          await api(`/api/op/clients/${encodeURIComponent(clientId)}/block`, {
            method: "PATCH",
            body: JSON.stringify({ blocked }),
          });
          await refreshOwnerClients();
        } else if (deleteBtn) {
          const phrase = window.prompt("Wpisz dokładnie: USUN_KONTO");
          if (phrase == null) return;
          const ownerPass = window.prompt("Podaj hasło właściciela, aby usunąć konto:");
          if (ownerPass == null) return;
          await api(`/api/op/clients/${encodeURIComponent(clientId)}/delete`, {
            method: "POST",
            body: JSON.stringify({
              confirm_phrase: String(phrase).trim(),
              owner_password: String(ownerPass),
            }),
          });
          alert("Konto klienta zostało usunięte.");
          await refreshOwnerClients();
          await refreshInbox();
        } else {
          return;
        }
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        btn.disabled = false;
      }
    });
  }
  try {
    const g = String(document.getElementById("owner-clients-gender-filter")?.value || "").trim();
    const sortDir = String(document.getElementById("owner-clients-sort")?.value || "newest").trim();
    const statsEl = document.getElementById("owner-clients-month-stats");
    const url = g ? `/api/op/clients?gender=${encodeURIComponent(g)}` : "/api/op/clients";
    const data = await api(url);
    const clients = [...(data.clients || [])];
    clients.sort((a, b) => {
      const ta = new Date(String(a?.created_at || "")).getTime() || 0;
      const tb = new Date(String(b?.created_at || "")).getTime() || 0;
      return sortDir === "oldest" ? ta - tb : tb - ta;
    });
    const byMonth = new Map();
    for (const c of clients) {
      const key = ownerMonthLabel(c?.created_at);
      if (!key) continue;
      byMonth.set(key, (byMonth.get(key) || 0) + 1);
    }
    if (statsEl) {
      const statsHtml = [...byMonth.entries()]
        .map(([label, count]) => `<span class="owner-clients-month-chip">${esc(label)}: <b>${count}</b></span>`)
        .join("");
      statsEl.innerHTML = statsHtml || `<span class="owner-clients-month-chip">Brak danych miesięcznych</span>`;
    }
    const rows = clients
      .map(
        (c) => {
          const blocked = !!c.blocked_at;
          const verifyStatus = c.email_verified_at
            ? `zweryfikowany (${formatOpPlTime(c.email_verified_at)})`
            : c.email_verification_token
              ? "oczekuje na kliknięcie linku"
              : "bez tokenu (stare konto)";
          const verifyAction = c.email_verified_at
            ? "—"
            : `<button type="button" class="btn-mon" data-client-verify-link data-client-id="${esc(
                c.id
              )}">Link aktywacyjny</button>`;
          const blockAction = blocked
            ? `<button type="button" class="btn-mon" data-client-unblock data-client-id="${esc(c.id)}">Odblokuj</button>`
            : `<button type="button" class="btn-mon btn-mon--danger" data-client-block data-client-id="${esc(c.id)}">Zablokuj</button>`;
          const deleteAction = `<button type="button" class="btn-mon btn-mon--danger" data-client-delete data-client-id="${esc(
            c.id
          )}">Usuń konto</button>`;
          const profileBlock = `<div class="owner-client-profile-block">
            <div><strong>nazwa:</strong> ${esc(c.first_name || c.display_name || "—")}</div>
            <div><strong>email:</strong> ${esc(c.email || "—")}</div>
            <div><strong>miasto:</strong> ${esc(c.city || "—")}</div>
            <div><strong>płeć:</strong> ${esc(ownerGenderLabel(c.gender))}</div>
          </div>`;
          const extraBlock = `<div class="owner-client-profile-block">
            <div><strong>dzieci:</strong> ${esc(ownerTriStateLabel(c.has_children))}</div>
            <div><strong>palenie:</strong> ${esc(ownerTriStateLabel(c.smokes))}</div>
            <div><strong>alkohol:</strong> ${esc(ownerTriStateLabel(c.drinks_alcohol))}</div>
            <div><strong>auto:</strong> ${esc(ownerTriStateLabel(c.has_car))}</div>
          </div>`;
          return (
          `<tr><td>${esc(c.username || "—")}</td><td>${profileBlock}</td><td>${extraBlock}</td><td>${esc(String(c.birth_date || "").slice(0, 10))}</td><td>${esc(
            formatOpPlTime(c.created_at)
          )}</td><td>${blocked ? "zablokowany" : "aktywny"}</td><td>${esc(verifyStatus)}</td><td>${verifyAction}<br/>${blockAction}<br/>${deleteAction}</td><td>${c.thread_count ?? 0}</td><td>${c.messages_balance ?? 0}</td></tr>`
          );
        }
      )
      .join("");
    body.innerHTML = `<table class="mon-table"><thead><tr><th>Nick</th><th>Profil</th><th>Dodatkowe info</th><th>Ur.</th><th>Rejestracja</th><th>Status konta</th><th>Status e-mail</th><th>Akcje</th><th>Wątki</th><th>Saldo</th></tr></thead><tbody>${
      rows || ""
    }</tbody></table>`;
  } catch {
    body.innerHTML = "<p class=\"queue-empty\">Nie udało się wczytać listy klientów.</p>";
  }
}

async function refreshOwnerMarketing() {
  if (opRole !== "owner") return;
  const channelsWrap = document.getElementById("mkt-channels");
  const btn = document.getElementById("btn-mkt-generate");
  const err = document.getElementById("mkt-err");
  const out = document.getElementById("mkt-results");
  if (!channelsWrap || !btn || !err || !out) return;
  const starterEl = document.getElementById("mkt-starter-list");
  const growthEl = document.getElementById("mkt-growth-list");
  const imgPromptEl = document.getElementById("mkt-image-prompt");
  const imgProviderEl = document.getElementById("mkt-image-provider");
  const imgSizeEl = document.getElementById("mkt-image-size");
  const imgApiKeyEl = document.getElementById("mkt-image-api-key");
  const imgBtn = document.getElementById("btn-mkt-image-generate");
  const imgErr = document.getElementById("mkt-image-err");
  const imgOut = document.getElementById("mkt-image-results");
  if (imgApiKeyEl && !imgApiKeyEl.dataset.restored) {
    try {
      imgApiKeyEl.value = localStorage.getItem(MKT_IMAGE_KEY_STORAGE) || "";
    } catch {
      /* ignore */
    }
    imgApiKeyEl.dataset.restored = "1";
  }
  function renderPresetCards() {
    const mk = (arr, kind) =>
      arr
        .map(
          (name) => `<article class="owner-insight-card">
            <h4 class="owner-insight-card-title">${esc(name)}</h4>
            <p class="owner-insight-card-body">Kanały: Instagram + TikTok (domyślnie). Kliknij, aby wypełnić temat.</p>
            <button type="button" class="btn-mon" data-mkt-preset="${esc(name)}" data-mkt-kind="${kind}">Użyj tego startera</button>
          </article>`
        )
        .join("");
    if (starterEl) starterEl.innerHTML = mk(MARKETING_STARTER_PRESETS, "starter");
    if (growthEl) growthEl.innerHTML = mk(MARKETING_GROWTH_PRESETS, "growth");
  }
  renderPresetCards();
  if (!ownerMarketingBound) {
    ownerMarketingBound = true;
    channelsWrap.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-mkt-channel]");
      if (!b) return;
      const ch = b.getAttribute("data-mkt-channel");
      if (!ch) return;
      if (marketingSelectedChannels.has(ch)) {
        if (marketingSelectedChannels.size > 1) marketingSelectedChannels.delete(ch);
      } else {
        marketingSelectedChannels.add(ch);
      }
      channelsWrap.querySelectorAll("[data-mkt-channel]").forEach((el) => {
        const active = marketingSelectedChannels.has(el.getAttribute("data-mkt-channel"));
        el.classList.toggle("owner-report-filter--active", active);
      });
    });
    btn.addEventListener("click", async () => {
      err.hidden = true;
      err.textContent = "";
      const topic = String(document.getElementById("mkt-topic")?.value || "").trim();
      const offer = String(document.getElementById("mkt-offer")?.value || "").trim();
      const audience = String(document.getElementById("mkt-audience")?.value || "").trim();
      const custom_prompt = String(document.getElementById("mkt-custom-prompt")?.value || "").trim();
      const provider = String(document.getElementById("mkt-ai-provider")?.value || "auto");
      if (!topic) {
        err.textContent = "Podaj temat kampanii.";
        err.hidden = false;
        return;
      }
      btn.disabled = true;
      out.innerHTML = "";
      try {
        const r = await api("/api/op/marketing/generate", {
          method: "POST",
          body: JSON.stringify({
            topic,
            offer,
            audience,
            custom_prompt,
            provider,
            channels: [...marketingSelectedChannels],
          }),
        });
        const items = r.items || [];
        out.innerHTML = items
          .map((it) => {
            const tags = (it.tags || []).map((t) => `#${esc(t)}`).join(" ");
            return `<article class="owner-insight-feed-row">
              <header class="owner-insight-feed-head">
                <strong>${esc(String(it.channel || "").replaceAll("_", " "))}</strong>
                <span class="owner-insight-feed-who">${esc((r.provider || "") + " · " + (r.model || ""))}</span>
              </header>
              <p class="owner-report-meta"><strong>Tytuł:</strong> ${esc(it.title || "—")}</p>
              <p class="owner-report-msg-body"><strong>Opis:</strong><br/>${esc(it.description || "—")}</p>
              <p class="owner-report-meta"><strong>Tagi:</strong> ${esc(tags || "—")}</p>
              <p class="owner-report-msg-body"><strong>Prompt graficzny:</strong><br/>${esc(it.visual_prompt || "—")}</p>
            </article>`;
          })
          .join("");
      } catch (e) {
        err.textContent = e.message || String(e);
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    imgBtn?.addEventListener("click", async () => {
      if (!imgPromptEl || !imgProviderEl || !imgSizeEl || !imgErr || !imgOut) return;
      const prompt = String(imgPromptEl.value || "").trim();
      const provider = String(imgProviderEl.value || "free").trim().toLowerCase();
      const size = String(imgSizeEl.value || "1024x1024").trim();
      const apiKey = String(imgApiKeyEl?.value || "").trim();
      imgErr.hidden = true;
      imgErr.textContent = "";
      if (prompt.length < 8) {
        imgErr.textContent = "Prompt obrazu jest za krótki (min. 8 znaków).";
        imgErr.hidden = false;
        return;
      }
      if (imgApiKeyEl) {
        try {
          localStorage.setItem(MKT_IMAGE_KEY_STORAGE, apiKey);
        } catch {
          /* ignore */
        }
      }
      imgBtn.disabled = true;
      imgOut.innerHTML = "";
      try {
        const r = await api("/api/op/marketing/generate-image", {
          method: "POST",
          body: JSON.stringify({
            prompt,
            provider,
            size,
            api_key: apiKey || null,
          }),
        });
        const first = Array.isArray(r.images) && r.images[0] ? r.images[0] : null;
        const url = String(first?.url || "").trim();
        if (!url) throw new Error("Brak obrazu w odpowiedzi.");
        const safeUrl = esc(url);
        imgOut.innerHTML = `<article class="owner-insight-feed-row">
          <header class="owner-insight-feed-head">
            <strong>Wygenerowany obraz</strong>
            <span class="owner-insight-feed-who">${esc((r.provider || provider) + (r.model ? " · " + r.model : ""))}</span>
          </header>
          <img src="${safeUrl}" alt="Wygenerowany obraz AI" loading="lazy" />
          <a class="composer-foot-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">Otwórz obraz w nowej karcie</a>
        </article>`;
      } catch (e) {
        imgErr.textContent = e.message || String(e);
        imgErr.hidden = false;
      } finally {
        imgBtn.disabled = false;
      }
    });
    document.getElementById("owner-page-marketing")?.addEventListener("click", (ev) => {
      const p = ev.target.closest("[data-mkt-preset]");
      if (!p) return;
      const name = p.getAttribute("data-mkt-preset") || "";
      const kind = p.getAttribute("data-mkt-kind") || "starter";
      const topic = document.getElementById("mkt-topic");
      const offer = document.getElementById("mkt-offer");
      const audience = document.getElementById("mkt-audience");
      const custom = document.getElementById("mkt-custom-prompt");
      if (topic) topic.value = name;
      if (offer) {
        offer.value =
          kind === "growth"
            ? "Przypomnienie o pakietach i szybkim wejściu do konsultacji"
            : "Start konsultacji i pierwsza odpowiedź bez czekania";
      }
      if (audience) audience.value = kind === "growth" ? "aktywni + powracający klienci" : "nowi odbiorcy";
      if (custom) {
        custom.value =
          "Skup się głównie na Instagram i TikTok. Podaj krótki hook, zwięzły opis i praktyczne hashtagi.";
      }
    });
  }
}

function renderInboxTabs() {
  const tabsEl = document.getElementById("inbox-bucket-tabs");
  if (!tabsEl) return;
  const tabs =
    opRole === "owner"
      ? [
          { key: "pending", label: "Oczekujące na odpowiedź" },
          { key: "stopped", label: "Zatrzymane" },
          { key: "teaser", label: "Zaczepka" },
          { key: "all", label: "Wszystkie" },
        ]
      : [
          { key: "mine", label: "Twoje rozmowy" },
          { key: "pool", label: "Rozmowy" },
          { key: "stopped", label: "Zatrzymane" },
        ];
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "inbox-tab" + (inboxBucket === t.key ? " inbox-tab--active" : "");
    b.textContent = t.label;
    b.addEventListener("click", () => {
      inboxBucket = t.key;
      refreshInbox();
    });
    tabsEl.appendChild(b);
  }
}

async function refreshOwnerMonitor() {
  if (opRole !== "owner") return;
  const body = document.getElementById("owner-monitor-body");
  if (!body) return;
  bindOwnerMonitorActionsOnce();
  bindAuditDetailClickOnce();
  try {
    const data = await api("/api/op/monitor");
    const list = data.operators || [];
    const staffParts = [];
    for (const o of list) {
      if (o.role === "owner") continue;
      const blocked = !!o.disabled_at;
      const actions =
        `<div class="mon-actions"><button type="button" class="btn-mon" data-operator-id="${esc(
          o.id
        )}" data-op-revoke>Wyloguj sesje</button>` +
        (blocked
          ? `<button type="button" class="btn-mon" data-operator-id="${esc(o.id)}" data-op-unblock>Odblokuj</button>`
          : `<button type="button" class="btn-mon btn-mon--danger" data-operator-id="${esc(
              o.id
            )}" data-op-block>Zablokuj</button>`) +
        "</div>";
      staffParts.push(`<article class="mon-card${blocked ? " mon-card--blocked" : ""}">
        <header class="mon-card-head">
          <h3 class="mon-card-title">${esc(o.display_name)}${
        blocked ? ' <span class="op-blocked-badge">zablokowane</span>' : ""
      }</h3>
          <span class="mon-card-email">${esc(o.email)}</span>
        </header>
        <dl class="mon-dl">
          <div><dt>KYC</dt><dd>${esc(o.kyc_status || "unverified")}</dd></div>
          <div><dt>Wiadomości do klienta (łącznie)</dt><dd>${o.messages_sent ?? 0}</dd></div>
          <div><dt>Odpowiedzi w czacie (7 dni)</dt><dd>${o.staff_replies_7d ?? 0}</dd></div>
          <div><dt>Wątki przypisane teraz</dt><dd>${o.threads_assigned_now ?? 0}</dd></div>
          <div><dt>Z terminem odpowiedzi</dt><dd>${o.threads_awaiting_reply ?? 0}</dd></div>
          <div><dt>Notatki — zapis (7 dni)</dt><dd>${o.fact_saves_7d ?? 0}</dd></div>
          <div><dt>Notatki — usunięcia (7 dni)</dt><dd>${o.fact_deletes_7d ?? 0}</dd></div>
          <div><dt>Aktywne sesje logowania</dt><dd>${o.active_sessions ?? 0}</dd></div>
        </dl>
        <footer class="mon-card-foot">${actions}</footer>
      </article>`);
    }
    const ownerSelf = list.find((o) => o.role === "owner");
    const ownerBlock = ownerSelf
      ? `<section class="mon-owner-strip"><strong>Administrator</strong> — ${esc(
          ownerSelf.display_name
        )} · ${esc(ownerSelf.email)} · aktywne sesje: ${ownerSelf.active_sessions ?? 0}</section>`
      : "";
    const aud = (data.audits || [])
      .map(
        (a) =>
          `<tr><td>${esc(formatOpPlTime(a.created_at))}</td><td>${esc(a.operator_email)}</td><td>${esc(a.action)}</td><td>${esc(
            String(a.detail || "").slice(0, 100)
          )}</td><td><button type="button" class="btn-audit-open" data-audit-id="${esc(a.id)}">Pełny wpis</button></td></tr>`
      )
      .join("");
    body.innerHTML = `${ownerBlock}
      <div class="mon-cards">${
        staffParts.join("") || "<p class=\"queue-empty\">Brak kont pracowniczych.</p>"
      }</div>
      <h4 class="mon-sub">Dziennik audytu (cały zespół)</h4>
      <div class="mon-scroll"><table class="mon-table mon-table--audit"><thead><tr><th>Kiedy</th><th>Kto</th><th>Akcja</th><th>Skrót</th><th></th></tr></thead><tbody>${aud}</tbody></table></div>`;
  } catch {
    body.innerHTML = "<p class=\"queue-empty\">Nie udało się wczytać monitora.</p>";
  }
}

function updateOwnerReportsBadge(count) {
  const el = document.getElementById("owner-tab-reports-badge");
  if (!el) return;
  const n = Number(count) || 0;
  if (n < 1) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = String(n > 99 ? "99+" : n);
  el.classList.remove("hidden");
}

function bindOwnerReportsActionsOnce() {
  if (ownerReportsActionsBound || !viewApp) return;
  ownerReportsActionsBound = true;
  viewApp.addEventListener("click", async (ev) => {
    const filt = ev.target.closest("[data-report-filter]");
    if (filt && opRole === "owner") {
      ownerReportFilter = filt.getAttribute("data-report-filter") || "open";
      await refreshOwnerReports();
      return;
    }
    const openTh = ev.target.closest("[data-report-open-thread]");
    if (openTh && opRole === "owner") {
      const tid = openTh.getAttribute("data-thread-id");
      if (!tid) return;
      setOwnerTab("inbox");
      await openThread(tid);
      setInboxOpen(false);
      return;
    }
    const resBtn = ev.target.closest("[data-report-resolve]");
    if (resBtn && opRole === "owner") {
      const rid = resBtn.getAttribute("data-report-id");
      if (!rid) return;
      resBtn.disabled = true;
      try {
        const note = window.prompt("Krótka notatka przy zamknięciu (opcjonalnie, tylko dla Ciebie):", "") ?? "";
        const data = await api(`/api/op/reports/${encodeURIComponent(rid)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "resolved", owner_note: note.trim().slice(0, 1000) }),
        });
        updateOwnerReportsBadge(data.open_count);
        await refreshOwnerReports();
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        resBtn.disabled = false;
      }
      return;
    }
    const reopenBtn = ev.target.closest("[data-report-reopen]");
    if (reopenBtn && opRole === "owner") {
      const rid = reopenBtn.getAttribute("data-report-id");
      if (!rid) return;
      reopenBtn.disabled = true;
      try {
        const data = await api(`/api/op/reports/${encodeURIComponent(rid)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "open" }),
        });
        updateOwnerReportsBadge(data.open_count);
        await refreshOwnerReports();
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        reopenBtn.disabled = false;
      }
    }
  });
}

async function refreshOwnerReports() {
  if (opRole !== "owner") return;
  const toolbar = document.getElementById("owner-reports-toolbar");
  const body = document.getElementById("owner-reports-body");
  if (!toolbar || !body) return;
  bindOwnerReportsActionsOnce();
  const filters = [
    { key: "open", label: "Otwarte" },
    { key: "resolved", label: "Załatwione" },
    { key: "all", label: "Wszystkie" },
  ];
  toolbar.innerHTML = filters
    .map(
      (f) =>
        `<button type="button" class="owner-report-filter${ownerReportFilter === f.key ? " owner-report-filter--active" : ""}" data-report-filter="${esc(f.key)}">${esc(f.label)}</button>`
    )
    .join("");
  try {
    const data = await api(`/api/op/reports?status=${encodeURIComponent(ownerReportFilter)}`);
    updateOwnerReportsBadge(data.open_count);
    const rows = data.reports || [];
    if (!rows.length) {
      body.innerHTML = "<p class=\"queue-empty\">Brak pozycji w tym filtrze.</p>";
      return;
    }
    const lines = rows.map((r) => {
      const st = r.status === "resolved" ? "Załatwione" : "Otwarte";
      const msgWho = r.message_sender === "staff" ? "Wiadomość zespołu" : "Wiadomość klienta";
      const reason = r.reason ? `<p class="owner-report-reason"><strong>Komentarz pracownika:</strong> ${esc(r.reason)}</p>` : "";
      const onote =
        r.owner_note && r.status === "resolved"
          ? `<p class="owner-report-note"><strong>Twoja notatka:</strong> ${esc(r.owner_note)}</p>`
          : "";
      const actions =
        r.status === "open"
          ? `<button type="button" class="btn-mon" data-report-open-thread data-thread-id="${esc(
              r.thread_id
            )}">Otwórz wątek</button>
             <button type="button" class="btn-mon btn-mon--primary" data-report-resolve data-report-id="${esc(
               r.id
             )}">Oznacz załatwione</button>`
          : `<button type="button" class="btn-mon" data-report-open-thread data-thread-id="${esc(
              r.thread_id
            )}">Otwórz wątek</button>
             <button type="button" class="btn-mon" data-report-reopen data-report-id="${esc(r.id)}">Cofnij do otwartych</button>`;
      return `<article class="owner-report-card">
        <header class="owner-report-card-head">
          <span class="owner-report-status owner-report-status--${esc(r.status)}">${esc(st)}</span>
          <time class="owner-report-time">${esc(formatOpPlTime(r.created_at))}</time>
        </header>
        <p class="owner-report-meta">${esc(r.reporter_display_name || "")} · ${esc(r.client_display_name || "")} · ${esc(
        r.character_name || ""
      )}</p>
        ${reason}
        <p class="owner-report-msg"><strong>${esc(msgWho)}</strong> (${esc(formatOpPlTime(r.message_created_at))})</p>
        <pre class="owner-report-msg-body">${esc(r.message_body || "")}</pre>
        ${onote}
        <footer class="owner-report-foot">${actions}</footer>
      </article>`;
    });
    body.innerHTML = `<div class="owner-report-list">${lines.join("")}</div>`;
  } catch {
    body.innerHTML = "<p class=\"queue-empty\">Nie udało się wczytać zgłoszeń.</p>";
  }
}

function bindOwnerInsightsOnce() {
  if (ownerInsightsBound || !viewApp) return;
  ownerInsightsBound = true;
  viewApp.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-insights-open-thread]");
    if (!b || opRole !== "owner") return;
    const tid = b.getAttribute("data-thread-id");
    if (!tid) return;
    setOwnerTab("inbox");
    await openThread(tid);
    setInboxOpen(false);
  });
}

async function refreshOwnerTeamInsights() {
  if (opRole !== "owner") return;
  const periodEl = document.getElementById("owner-insights-period");
  const cardsEl = document.getElementById("owner-insights-cards");
  const rankEl = document.getElementById("owner-insights-ranking");
  const feedEl = document.getElementById("owner-insights-feed");
  if (!periodEl || !cardsEl || !rankEl || !feedEl) return;
  bindOwnerInsightsOnce();
  periodEl.textContent = "Ładowanie…";
  cardsEl.innerHTML = "";
  rankEl.innerHTML = "";
  feedEl.innerHTML = "";
  try {
    const data = await api("/api/op/owner/team-insights");
    periodEl.textContent = data.period?.label || "";
    const rec =
      (data.recommendation_hint && String(data.recommendation_hint).trim()) ||
      "Plan: oceny po rozmowie, link polecający, automatyczne naliczanie premii wg rankingu — na razie widzisz tylko liczby i podgląd treści.";
    const spot = data.spotlight_message && String(data.spotlight_message).trim();
    const b = data.bonus || {};
    const bonusBits = [];
    if ((b.top1_pln || 0) > 0) bonusBits.push(`#1: ${b.top1_pln} PLN`);
    if ((b.top2_pln || 0) > 0) bonusBits.push(`#2: ${b.top2_pln} PLN`);
    if ((b.top3_pln || 0) > 0) bonusBits.push(`#3: ${b.top3_pln} PLN`);
    const bonusLine =
      bonusBits.length > 0
        ? `Sugerowane premie (ustaw w .env: STAFF_BONUS_TOP1_WEEK_PLN itd.): ${bonusBits.join(" · ")} — wypłata na razie ręczna.`
        : "Premie tygodniowe: ustaw STAFF_BONUS_TOP1_WEEK_PLN, STAFF_BONUS_TOP2_WEEK_PLN, STAFF_BONUS_TOP3_WEEK_PLN w pliku .env (kwoty orientacyjne).";
    cardsEl.innerHTML = `<div class="owner-insight-card"><h4 class="owner-insight-card-title">Polecenia i jakość</h4><p class="owner-insight-card-body">${esc(
      rec
    )}</p></div>
      <div class="owner-insight-card"><h4 class="owner-insight-card-title">Premie wg rankingu</h4><p class="owner-insight-card-body">${esc(
        bonusLine
      )}</p></div>
      ${
        spot
          ? `<div class="owner-insight-card owner-insight-card--accent"><h4 class="owner-insight-card-title">Wyróżnienie (STAFF_SPOTLIGHT_WEEK_MESSAGE)</h4><p class="owner-insight-card-body">${esc(
              spot
            )}</p></div>`
          : ""
      }`;

    const rows = data.ranking || [];
    if (!rows.length) {
      rankEl.innerHTML = "<p class=\"queue-empty\">Brak odpowiedzi pracowników w ostatnich 7 dniach.</p>";
    } else {
      const tr = rows
        .map((r, i) => {
          const prem =
            i === 0 && (b.top1_pln || 0) > 0
              ? ` <span class="owner-insight-bonus-tag">+${esc(String(b.top1_pln))} PLN</span>`
              : i === 1 && (b.top2_pln || 0) > 0
                ? ` <span class="owner-insight-bonus-tag">+${esc(String(b.top2_pln))} PLN</span>`
                : i === 2 && (b.top3_pln || 0) > 0
                  ? ` <span class="owner-insight-bonus-tag">+${esc(String(b.top3_pln))} PLN</span>`
                  : "";
          return `<tr><td>${i + 1}</td><td>${esc(r.display_name)}</td><td>${esc(r.email)}</td><td>${esc(
            String(r.staff_messages_7d)
          )}</td><td>${prem}</td></tr>`;
        })
        .join("");
      rankEl.innerHTML = `<table class="mon-table"><thead><tr><th>#</th><th>Pracownik</th><th>E-mail</th><th>Wiad. 7 dni</th><th>Premia (szkic)</th></tr></thead><tbody>${tr}</tbody></table>`;
    }

    const feed = data.feed || [];
    if (!feed.length) {
      feedEl.innerHTML = "<p class=\"queue-empty\">Brak pozycji w strumieniu.</p>";
    } else {
      feedEl.innerHTML = feed
        .map(
          (m) =>
            `<article class="owner-insight-feed-row">
            <header class="owner-insight-feed-head">
              <strong>${esc(formatOpPlTime(m.created_at))}</strong>
              <span class="owner-insight-feed-who">${esc(m.operator_display_name || "")} · ${esc(m.operator_email || "")}</span>
            </header>
            <p class="owner-insight-feed-meta">${esc(m.client_display_name || "")} · ${esc(m.character_name || "")}</p>
            <pre class="owner-insight-feed-body">${esc(m.body || "")}</pre>
            <button type="button" class="btn-mon" data-insights-open-thread data-thread-id="${esc(
              m.thread_id
            )}">Otwórz wątek</button>
          </article>`
        )
        .join("");
    }
  } catch {
    periodEl.textContent = "";
    feedEl.innerHTML = "<p class=\"queue-empty\">Nie udało się wczytać danych audytu.</p>";
  }
}

function renderQueueSlots(el, slots) {
  if (!el) return;
  el.innerHTML = "";
  if (!slots.length) {
    el.innerHTML =
      '<p class="queue-empty">Brak wątków w widocznej puli (albo ostatnia wiadomość jest już od zespołu).</p>';
    return;
  }
  for (const s of slots) {
    const wrap = document.createElement("div");
    wrap.className = "queue-row";
    const badge = s.exclusive_for_you
      ? `<span class="exclusive-tag">Twoje pierwszeństwo po odpowiedzi klienta</span>`
      : `<span class="queue-wait">Czeka: ${esc(s.waiting_label || "—")}</span>`;
    wrap.innerHTML = `<div class="queue-row-main">
        <span class="queue-slot">#${s.slot}</span>
        ${badge}
      </div>`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-queue-claim";
    b.textContent = "Wejdź w rozmowę";
    b.addEventListener("click", () => claimQueueThread(s.thread_id));
    wrap.appendChild(b);
    el.appendChild(wrap);
  }
}

function renderStoppedSlots(el, threadRows) {
  if (!el) return;
  el.innerHTML = "";
  if (!threadRows.length) {
    el.innerHTML = '<p class="queue-empty">Brak zatrzymanych wątków w tej zakładce.</p>';
    return;
  }
  for (const t of threadRows) {
    const wrap = document.createElement("div");
    wrap.className = "queue-row queue-row--stopped";
    wrap.innerHTML = `<div class="queue-row-main">
        <span class="thread-badge thread-badge--stopped" title="Wątek zatrzymany">Zatrzymany</span>
        <span class="queue-slot">${esc(t.user_display_name || "—")} · ${esc(t.character_name || "")}</span>
        <span class="queue-wait">${esc(formatOpPlTimeShort(t.thread_started_at))}</span>
      </div>`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-queue-claim";
    b.textContent = "Przejmij (zatrzymany)";
    b.addEventListener("click", () => claimStoppedThenOpen(t.thread_id));
    wrap.appendChild(b);
    el.appendChild(wrap);
  }
}

function renderMineSlots(el, threadRows) {
  if (!el) return;
  el.innerHTML = "";
  if (!threadRows.length) {
    el.innerHTML = '<p class="queue-empty">Brak przypisanych wątków — weź nowy z puli.</p>';
    return;
  }
  for (const t of threadRows) {
    const wrap = document.createElement("div");
    wrap.className = "queue-row queue-row--mine";
    wrap.innerHTML = `<div class="queue-row-main">
        <span class="queue-slot">${esc(t.user_display_name || "—")} · ${esc(t.character_name || "")}</span>
        <span class="queue-wait">${esc(formatOpPlTimeShort(t.thread_started_at))}</span>
      </div>`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-queue-claim";
    b.textContent = "Otwórz rozmowę";
    b.addEventListener("click", async () => {
      await openThread(t.thread_id);
      setInboxOpen(false);
    });
    wrap.appendChild(b);
    el.appendChild(wrap);
  }
}

const STAFF_DEMO_THREAD_ROWS = [
  { line: "Anna K. · Luna — wróżka", sub: "2024-09-14 · ostatnio: klient" },
  { line: "Marek · Tarot klasyczny", sub: "2024-10-01 · ostatnio: zespół" },
  { line: "Julia · Horoskop tygodniowy", sub: "2024-10-22 · ostatnio: klient" },
];

function renderStaffDemoThreadRows(el) {
  if (!el) return;
  el.innerHTML = "";
  for (const d of STAFF_DEMO_THREAD_ROWS) {
    const wrap = document.createElement("div");
    wrap.className = "queue-row queue-row--demo";
    wrap.innerHTML = `<div class="queue-row-main">
        <span class="queue-slot">${esc(d.line)}</span>
        <span class="queue-wait">${esc(d.sub)}</span>
      </div>`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-queue-claim";
    b.disabled = true;
    b.title = "Statyczny podgląd — brak wątku w bazie";
    b.textContent = "Tylko podgląd";
    wrap.appendChild(b);
    el.appendChild(wrap);
  }
}

function updateStaffConvTabCount(nReal) {
  const el = document.getElementById("staff-conv-tab-count");
  if (!el) return;
  const demo = STAFF_DEMO_THREAD_ROWS.length;
  el.textContent = `(${nReal + demo})`;
}

async function refreshStaffConvView() {
  if (opRole === "owner") return;
  const qEl = document.getElementById("staff-conv-queue-slots");
  const mEl = document.getElementById("staff-conv-mine-slots");
  const sEl = document.getElementById("staff-conv-stopped-slots");
  const demoEl = document.getElementById("staff-conv-demo-slots");
  if (!qEl) return;
  try {
    const [q, mineData, stoppedData] = await Promise.all([
      api("/api/op/queue"),
      api("/api/op/inbox?bucket=mine").catch(() => ({ threads: [] })),
      api("/api/op/inbox?bucket=stopped").catch(() => ({ threads: [] })),
    ]);
    const slots = q.slots || [];
    const mine = mineData.threads || [];
    const stopped = stoppedData.threads || [];
    renderQueueSlots(qEl, slots);
    renderMineSlots(mEl, mine);
    renderStoppedSlots(sEl, stopped);
    renderStaffDemoThreadRows(demoEl);
    updateStaffConvTabCount(mine.length + slots.length + stopped.length);
  } catch {
    /* offline */
  }
}

async function refreshStaffHub() {
  if (opRole === "owner") return;
  try {
    const [st, dash] = await Promise.all([
      api("/api/op/stats"),
      api("/api/op/staff-dashboard").catch(() => null),
    ]);
    document.getElementById("dash-sent").textContent = String(st.stats?.messages_sent ?? "0");
    document.getElementById("dash-active").textContent = String(
      st.stats?.active_waiting_threads ?? "0"
    );
    const d = dash?.dashboard;
    if (d) {
      const dr = document.getElementById("dash-rate");
      const de = document.getElementById("dash-earn-total");
      if (dr) dr.textContent = `${d.rate_pln_per_reply} zł / odpowiedź (szac.)`;
      if (de) de.textContent = `~${d.estimated_earnings_pln_total} zł`;
      const g = document.getElementById("period-stats-grid");
      if (g) {
        g.innerHTML = `<div class="period-card"><h4>Dziś</h4><p><strong>${d.messages_today}</strong> wiad.</p><p>~${d.estimated_earnings_today_pln} zł</p></div>
          <div class="period-card"><h4>Ostatnie 7 dni</h4><p><strong>${d.messages_last_7_days}</strong> wiad.</p><p>~${d.estimated_earnings_last_7_days_pln} zł</p></div>
          <div class="period-card"><h4>Poprzednie 7 dni</h4><p><strong>${d.messages_prev_7_days}</strong> wiad.</p><p>~${d.estimated_earnings_prev_7_days_pln} zł</p></div>`;
      }
    }
  } catch {
    /* offline */
  }
}

async function claimQueueThread(threadId) {
  const replyErr = document.getElementById("reply-err");
  const qe = document.getElementById("queue-err");
  replyErr.hidden = true;
  if (qe) {
    qe.hidden = true;
    qe.textContent = "";
  }
  try {
    const r = await api(`/api/op/inbox/${encodeURIComponent(threadId)}/claim`, {
      method: "POST",
    });
    applyAssignmentUI(r.assignment || null);
    if (opRole === "owner") await refreshInbox();
    else {
      await refreshStaffHub();
      await refreshStaffConvView();
    }
    await openThread(threadId);
    setInboxOpen(false);
  } catch (e) {
    if (qe) {
      qe.textContent = e.message;
      qe.hidden = false;
    } else {
      replyErr.textContent = e.message;
      replyErr.hidden = false;
    }
  }
}

async function claimStoppedThenOpen(threadId) {
  const replyErr = document.getElementById("reply-err");
  const qe = document.getElementById("queue-err");
  replyErr.hidden = true;
  if (qe) {
    qe.hidden = true;
    qe.textContent = "";
  }
  try {
    const r = await api(`/api/op/inbox/${encodeURIComponent(threadId)}/claim-stopped`, {
      method: "POST",
    });
    applyAssignmentUI(r.assignment || null);
    if (opRole === "owner") await refreshInbox();
    else {
      await refreshStaffHub();
      await refreshStaffConvView();
    }
    await openThread(threadId);
    setInboxOpen(false);
  } catch (e) {
    if (qe) {
      qe.textContent = e.message;
      qe.hidden = false;
    } else {
      replyErr.textContent = e.message;
      replyErr.hidden = false;
    }
  }
}

async function refreshStaffList() {
  const data = await api("/api/op/staff");
  const ul = document.getElementById("staff-list");
  ul.innerHTML = "";
  for (const o of data.operators || []) {
    const li = document.createElement("li");
    const rt = o.role === "owner" ? "właściciel" : "pracownik";
    const blk = o.disabled_at ? ' <span class="staff-blocked-tag">konto zablokowane</span>' : "";
    const kycLab =
      o.role === "staff"
        ? `<span class="staff-kyc-tag">${esc(o.kyc_status || "unverified")}</span>`
        : "";
    li.innerHTML = `<span>${esc(o.display_name)}${blk}<br /><small style="color:var(--muted)">${esc(
      o.email
    )}</small>${kycLab}</span><span class="role-tag">${esc(rt)}</span>`;
    ul.appendChild(li);
  }
}

function loadTeaserTemplates() {
  const raw = localStorage.getItem(TEASER_TEMPLATES_KEY);
  if (!raw) return [...DEFAULT_TEASER_TEMPLATES];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TEASER_TEMPLATES];
    const out = parsed.map((x) => String(x || "").trim()).filter(Boolean);
    return out.length ? out.slice(0, 80) : [...DEFAULT_TEASER_TEMPLATES];
  } catch {
    return [...DEFAULT_TEASER_TEMPLATES];
  }
}

function saveTeaserTemplates(list) {
  localStorage.setItem(TEASER_TEMPLATES_KEY, JSON.stringify(list.slice(0, 80)));
}

function fillTeaserMediumOptions(clientSel, mediumSel, targets) {
  const uid = String(clientSel.value || "").trim();
  mediumSel.innerHTML = "";
  if (!uid) {
    mediumSel.innerHTML = `<option value="">— najpierw wybierz klienta —</option>`;
    return;
  }
  const opts = targets.filter((t) => t.user_id === uid);
  if (!opts.length) {
    mediumSel.innerHTML = `<option value="">Brak dostępnych medium dla tego klienta.</option>`;
    return;
  }
  mediumSel.innerHTML = opts
    .map(
      (t) =>
        `<option value="${esc(t.character_id)}">${esc(t.character_name)} (${esc(t.category || "medium")})</option>`
    )
    .join("");
}

async function renderOwnerTeaserPanel() {
  if (opRole !== "owner") return;
  const wrap = document.getElementById("owner-teaser-panel");
  const inboxEl = document.getElementById("inbox");
  const clientSel = document.getElementById("teaser-client");
  const mediumSel = document.getElementById("teaser-medium");
  const tplSel = document.getElementById("teaser-template");
  const bodyEl = document.getElementById("teaser-body");
  const err = document.getElementById("teaser-err");
  const btnSave = document.getElementById("btn-teaser-save-template");
  const btnSend = document.getElementById("btn-teaser-send");
  if (!wrap || !inboxEl || !clientSel || !mediumSel || !tplSel || !bodyEl || !err || !btnSave || !btnSend) return;
  wrap.classList.remove("hidden");
  inboxEl.classList.add("hidden");
  const templates = loadTeaserTemplates();
  tplSel.innerHTML = templates
    .map((t, i) => `<option value="${i}">${esc(t.slice(0, 70))}</option>`)
    .join("");
  if (templates[0] && !bodyEl.value.trim()) bodyEl.value = templates[0];
  tplSel.onchange = () => {
    const idx = Number(tplSel.value);
    if (Number.isFinite(idx) && templates[idx]) bodyEl.value = templates[idx];
  };
  err.hidden = true;
  err.textContent = "";
  const data = await api("/api/op/teaser/targets?limit=120");
  const targets = data.targets || [];
  if (!targets.length) {
    clientSel.innerHTML = `<option value="">Brak klientów z możliwą zaczepką.</option>`;
    mediumSel.innerHTML = `<option value="">—</option>`;
  } else {
    const byUser = new Map();
    for (const t of targets) {
      if (!byUser.has(t.user_id)) {
        byUser.set(t.user_id, {
          user_id: t.user_id,
          user_name: t.user_name,
          username: t.username || "",
        });
      }
    }
    const clients = [...byUser.values()];
    clientSel.innerHTML = clients
      .map(
        (c) =>
          `<option value="${esc(c.user_id)}">${esc(c.user_name)}${c.username ? " (@" + esc(c.username) + ")" : ""}</option>`
      )
      .join("");
    clientSel.onchange = () => fillTeaserMediumOptions(clientSel, mediumSel, targets);
    fillTeaserMediumOptions(clientSel, mediumSel, targets);
  }
  btnSave.onclick = () => {
    const text = String(bodyEl.value || "").trim();
    if (text.length < 8) {
      err.textContent = "Szablon jest za krótki.";
      err.hidden = false;
      return;
    }
    const next = [text, ...templates.filter((x) => x !== text)];
    saveTeaserTemplates(next);
    tplSel.innerHTML = next
      .map((t, i) => `<option value="${i}">${esc(t.slice(0, 70))}</option>`)
      .join("");
    tplSel.value = "0";
    err.hidden = true;
  };
  btnSend.onclick = async () => {
    err.hidden = true;
    const uid = String(clientSel.value || "").trim();
    const cid = String(mediumSel.value || "").trim();
    const text = String(bodyEl.value || "").trim();
    if (!uid || !cid) {
      err.textContent = "Wybierz klienta i medium.";
      err.hidden = false;
      return;
    }
    if (text.length < 8) {
      err.textContent = "Treść zaczepki jest za krótka.";
      err.hidden = false;
      return;
    }
    btnSend.disabled = true;
    try {
      await api("/api/op/teaser/send", {
        method: "POST",
        body: JSON.stringify({
          user_id: uid,
          character_id: cid,
          body: text,
        }),
      });
      await refreshInbox();
      alert("Zaczepka wysłana.");
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    } finally {
      btnSend.disabled = false;
    }
  };
}

function inboxMessagesUrl(threadId, limit) {
  return `/api/op/inbox/${encodeURIComponent(threadId)}/messages?limit=${limit}`;
}

/** Etykieta w nagłówku bąbelka: właściciel widzi autora odpowiedzi zespołu; pracownik — imię medium / klientki. */
function messageBubbleWhoLabel(msg) {
  const meta = lastThreadMeta;
  if (!meta) {
    return msg.sender === "staff" ? "Zespół" : "Klient";
  }
  const mediumName =
    String(meta.character_name || meta.medium_profile?.name || "").trim() || "Medium";
  const clientName =
    String(meta.client_profile?.first_name || "").trim() ||
    String(meta.user_display_name || "").trim() ||
    "Klient";

  if (msg.sender === "user") {
    return clientName;
  }
  if (opRole === "owner") {
    const nm = String(msg.staff_display_name || "").trim() || "—";
    const em = String(msg.staff_email || "").trim();
    return em ? `${nm} · ${em}` : nm;
  }
  return mediumName;
}

function setHasMoreFromData(data) {
  messagesHasMore = !!data?.has_more_messages;
}

function loadAiPromptFromStorage() {
  const el = document.getElementById("ai-prompt");
  if (!el) return;
  const saved = localStorage.getItem(AI_PROMPT_STORAGE_KEY);
  if (saved && saved.trim()) {
    el.value = saved;
    return;
  }
  el.value =
    "Napisz propozycję odpowiedzi po polsku, empatycznie i konkretnie. Bez danych kontaktowych i bez obietnic gwarancji.";
}

function saveAiPromptToStorage() {
  const el = document.getElementById("ai-prompt");
  if (!el) return;
  localStorage.setItem(AI_PROMPT_STORAGE_KEY, String(el.value || ""));
}

function clearAiSelection() {
  selectedAiMessageIds.clear();
  updateAiSelectedCounter();
}

function updateAiSelectedCounter() {
  const el = document.getElementById("ai-selected-count");
  if (!el) return;
  el.textContent = `Zaznaczone do AI: ${selectedAiMessageIds.size}`;
}

function getSelectedMessagesForAi() {
  const ids = [];
  for (const msg of currentThreadMessages) {
    if (selectedAiMessageIds.has(msg.id)) ids.push(msg.id);
  }
  return ids;
}

async function generateAiDraft() {
  const err = document.getElementById("ai-err");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (!activeId) return;
  const ids = getSelectedMessagesForAi();
  if (!ids.length) {
    if (err) {
      err.textContent = "Zaznacz co najmniej jedną wiadomość do AI.";
      err.hidden = false;
    }
    return;
  }
  const promptEl = document.getElementById("ai-prompt");
  const providerEl = document.getElementById("ai-provider");
  const replyEl = document.getElementById("reply");
  if (!promptEl || !providerEl || !replyEl) return;
  const prompt = String(promptEl.value || "").trim();
  if (!prompt) {
    if (err) {
      err.textContent = "Podaj prompt dla asystenta AI.";
      err.hidden = false;
    }
    return;
  }
  saveAiPromptToStorage();
  const btn = document.getElementById("btn-ai-generate");
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/op/inbox/${encodeURIComponent(activeId)}/ai-draft`, {
      method: "POST",
      body: JSON.stringify({
        message_ids: ids,
        prompt,
        provider: String(providerEl.value || "auto"),
      }),
    });
    replyEl.value = String(r.draft || "").trim();
    updateReplyMeta();
    replyEl.focus();
  } catch (e) {
    if (err) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

const opMessages = document.getElementById("op-messages");

async function loadMoreMessagesOlder() {
  if (!activeId || !messagesHasMore || messagesLoadingOlder || messagesFetchLimit >= 500) return null;
  messagesLoadingOlder = true;
  const id = activeId;
  const next = messagesFetchLimit + 10;
  try {
    const data = await api(inboxMessagesUrl(id, next));
    if (activeId !== id) return null;
    messagesFetchLimit = next;
    lastThreadMeta = data.meta || lastThreadMeta;
    lastFacts = data.facts || [];
    applyAssignmentUI(data.assignment || null);
    renderFactList("client", document.getElementById("fk-list"));
    renderFactList("consultant", document.getElementById("fc-list"));
    opRenderMessages(data.messages, { preserveOlderScroll: true });
    setHasMoreFromData(data);
    return data;
  } catch {
    return null;
  } finally {
    messagesLoadingOlder = false;
  }
}

async function runAutoFillOlderUntilScrollable() {
  let n = 0;
  while (
    activeId &&
    opMessages &&
    messagesHasMore &&
    !messagesLoadingOlder &&
    messagesFetchLimit < 500 &&
    n < 50 &&
    opMessages.scrollHeight <= opMessages.clientHeight + 2
  ) {
    n++;
    const r = await loadMoreMessagesOlder();
    if (!r) break;
  }
}

async function tryLoadOlderOnScrollNearBottom() {
  if (!activeId || !opMessages || !messagesHasMore || messagesLoadingOlder || messagesFetchLimit >= 500) {
    return;
  }
  if (opMessages.scrollTop + opMessages.clientHeight < opMessages.scrollHeight - 80) return;
  await loadMoreMessagesOlder();
}

async function reloadThreadData() {
  if (!activeId) return;
  const id = activeId;
  const data = await api(inboxMessagesUrl(id, messagesFetchLimit));
  if (activeId !== id) return;
  lastThreadMeta = data.meta || null;
  lastFacts = data.facts || [];
  applyAssignmentUI(data.assignment || null);
  renderFactList("client", document.getElementById("fk-list"));
  renderFactList("consultant", document.getElementById("fc-list"));
  setHasMoreFromData(data);
  opRenderMessages(data.messages);
  await runAutoFillOlderUntilScrollable();
}

function opRenderMessages(msgs, opts = {}) {
  currentThreadMessages = Array.isArray(msgs) ? msgs : [];
  const preserve = !!opts.preserveOlderScroll;
  const prev = preserve
    ? { scrollHeight: opMessages.scrollHeight, scrollTop: opMessages.scrollTop }
    : null;
  opMessages.innerHTML = "";
  for (const msg of msgs) {
    const who = messageBubbleWhoLabel(msg);
    const ownFoot =
      opRole !== "owner" && msg.sender === "staff" && msg.is_own_staff_reply
        ? `<span class="bubble-own-foot">Twoja wiadomość</span>`
        : "";
    const bubbleInner = `<span class="meta">${esc(who)} · ${esc(formatOpPlTime(msg.created_at))}</span>${esc(msg.body)}${ownFoot}`;
    const aiSel = selectedAiMessageIds.has(msg.id) ? " bubble-row--ai-selected" : "";
    let sideHtml = "";
    if (opRole === "staff") {
      sideHtml = msg.has_open_report
        ? `<span class="msg-report-badge" title="Właściciel widzi to zgłoszenie">Zgłoszone</span>`
        : `<button type="button" class="btn-msg-report" data-msg-id="${esc(
            msg.id
          )}" title="Zgłoś właścicielowi (dowolna wiadomość z czatu)">Zgłoś</button>`;
    } else if (opRole === "owner" && msg.has_open_report) {
      sideHtml = `<span class="msg-report-badge" title="Otwarte zgłoszenie">Zgłoszenie</span>`;
    }
    const div = document.createElement("div");
    div.className = `bubble ${msg.sender === "staff" ? "staff" : "user"}`;
    div.innerHTML = bubbleInner;
    const row = document.createElement("div");
    row.className = `bubble-row bubble-row--${msg.sender === "user" ? "user" : "staff"}${aiSel}`;
    row.setAttribute("data-msg-id", msg.id);
    row.title = "Kliknij wiersz, aby zaznaczyć lub odznaczyć do asystenta AI";
    if (sideHtml) {
      const aside = document.createElement("div");
      aside.className = "bubble-aside";
      aside.innerHTML = sideHtml;
      if (msg.sender === "user") {
        row.appendChild(aside);
        row.appendChild(div);
      } else {
        row.appendChild(div);
        row.appendChild(aside);
      }
    } else {
      if (msg.sender === "user") {
        row.appendChild(div);
      } else {
        row.appendChild(div);
      }
    }
    opMessages.appendChild(row);
  }
  if (preserve && prev) {
    opMessages.scrollTop = opMessages.scrollHeight - prev.scrollHeight + prev.scrollTop;
  } else {
    opMessages.scrollTop = 0;
  }
  updateAiSelectedCounter();
}

async function trySession() {
  try {
    const me = await api("/api/op/me");
    ownerConsoleHints = null;
    opRole = me.operator.role || "staff";
    opId = me.operator.id || "";
    const roleLab = opRole === "owner" ? "właściciel" : "pracownik";
    document.getElementById("op-who").textContent = `${me.operator.display_name} (${me.operator.email}) · ${roleLab}`;
    if (opRole === "owner") await refreshStaffList();
    if (opRole === "owner") updateOwnerReportsBadge(me.open_message_reports ?? 0);
    applyRoleChrome();
    if (opRole === "owner" && layoutWork) {
      try {
        if (localStorage.getItem(INBOX_COLLAPSE_KEY) === "1") layoutWork.classList.add("layout-work--inbox-collapsed");
        else layoutWork.classList.remove("layout-work--inbox-collapsed");
      } catch {
        /* ignore */
      }
      const collapsed = layoutWork.classList.contains("layout-work--inbox-collapsed");
      btnInboxSidebar?.setAttribute("aria-pressed", collapsed ? "false" : "true");
    }
    if (me.payout) {
      const p = me.payout;
      const setv = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v ?? "";
      };
      setv("pay-fn", p.first_name);
      setv("pay-ln", p.last_name);
      setv("pay-addr", p.address_line);
      setv("pay-post", p.postal_code);
      setv("pay-city", p.city);
      setv("pay-country", p.country);
      setv("pay-iban", p.iban);
      const pf = document.getElementById("pay-freq");
      if (pf) pf.value = p.frequency || "";
    }
    const kycMini = document.getElementById("kyc-mini");
    if (kycMini && me.kyc) {
      kycMini.textContent = `Status weryfikacji tożsamości (KYC, przyszła integracja zewnętrzna): ${me.kyc.status}.`;
    }
    const bannedWrap = document.getElementById("reply-banned-wrap");
    const bannedPop = document.getElementById("reply-banned-popover");
    if (bannedWrap && bannedPop) {
      if (me.reply_rules) {
        const banned = me.reply_rules.banned_substrings || [];
        const hint = me.reply_rules.hint || "";
        const list =
          banned.length > 0
            ? `<ul class="reply-banned-ul">${banned.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
            : "";
        bannedPop.innerHTML = hint
          ? `<p class="reply-banned-pop-lead">${esc(hint)}</p>${list}`
          : list || `<p class="reply-banned-pop-lead">Brak listy — stosuj się do wytycznych portalu.</p>`;
        bannedWrap.classList.remove("hidden");
      } else {
        bannedPop.innerHTML = "";
        bannedWrap.classList.add("hidden");
      }
    }

    schema = await api("/api/op/facts-schema");
    loadAiPromptFromStorage();
    updateAiSelectedCounter();
    showLogin(false);
    layoutWork.classList.add("no-thread");
    const chatEmptyEl = document.getElementById("chat-empty");
    const staffHubEl = document.getElementById("staff-hub-panel");
    if (opRole === "owner") {
      chatEmptyEl?.classList.remove("hidden");
      staffHubEl?.classList.add("hidden");
    } else {
      chatEmptyEl?.classList.add("hidden");
      staffHubEl?.classList.remove("hidden");
    }
    document.getElementById("chat-body").classList.add("hidden");

    fillCategoryField("consultant", document.getElementById("fc-cat"), document.getElementById("fc-field"));
    fillCategoryField("client", document.getElementById("fk-cat"), document.getElementById("fk-field"));

    if (!panelListenersBound) {
      panelListenersBound = true;
      ownerTabsEl?.addEventListener("click", (e) => {
        const b = e.target.closest("[data-owner-tab]");
        if (!b || !ownerTabsEl.contains(b)) return;
        setOwnerTab(b.getAttribute("data-owner-tab") || "inbox");
      });
      document.getElementById("owner-advanced-toggle")?.addEventListener("click", () => {
        ownerAdvancedTabsShown = !ownerAdvancedTabsShown;
        ownerAdvancedUnlocked = ownerAdvancedTabsShown;
        applyOwnerAdvancedVisibility();
        const b = document.getElementById("owner-advanced-toggle");
        if (b) {
          b.textContent = ownerAdvancedTabsShown
            ? "Ukryj narzędzia właściciela"
            : "Pokaż ukryte narzędzia właściciela";
        }
      });
      document.getElementById("op-logo-main")?.addEventListener("click", (ev) => {
        if (opRole !== "owner") return;
        if (!(ev.ctrlKey && ev.shiftKey)) return;
        ev.preventDefault();
        ownerAdvancedUnlocked = !ownerAdvancedUnlocked;
        applyOwnerAdvancedVisibility();
        alert(
          ownerAdvancedUnlocked
            ? "Ukryte narzędzia właściciela odblokowane."
            : "Ukryte narzędzia właściciela ponownie ukryte."
        );
      });
      document.getElementById("btn-change-password")?.addEventListener("click", () => {
        const dlg = document.getElementById("change-password-dialog");
        const err = document.getElementById("op-pass-dlg-err");
        const cur = document.getElementById("op-pass-current");
        const next = document.getElementById("op-pass-new");
        if (err) {
          err.hidden = true;
          err.textContent = "";
        }
        if (cur) cur.value = "";
        if (next) next.value = "";
        dlg?.showModal();
      });
      document.getElementById("op-pass-cancel")?.addEventListener("click", () => {
        document.getElementById("change-password-dialog")?.close();
      });
      document.getElementById("change-password-form")?.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const err = document.getElementById("op-pass-dlg-err");
        if (err) {
          err.hidden = true;
          err.textContent = "";
        }
        const current_password = String(document.getElementById("op-pass-current")?.value || "");
        const new_password = String(document.getElementById("op-pass-new")?.value || "");
        try {
          await api("/api/op/me/password", {
            method: "PATCH",
            body: JSON.stringify({ current_password, new_password }),
          });
          document.getElementById("change-password-dialog")?.close();
          alert("Hasło zostało zmienione.");
        } catch (e) {
          if (err) {
            err.textContent = e.message || String(e);
            err.hidden = false;
          }
        }
      });
      document.getElementById("btn-save-payout")?.addEventListener("click", async () => {
        const err = document.getElementById("payout-err");
        if (err) {
          err.hidden = true;
          err.textContent = "";
        }
        const body = {
          first_name: document.getElementById("pay-fn")?.value || "",
          last_name: document.getElementById("pay-ln")?.value || "",
          address_line: document.getElementById("pay-addr")?.value || "",
          postal_code: document.getElementById("pay-post")?.value || "",
          city: document.getElementById("pay-city")?.value || "",
          country: document.getElementById("pay-country")?.value || "",
          iban: document.getElementById("pay-iban")?.value || "",
          frequency: document.getElementById("pay-freq")?.value || "",
        };
        try {
          await api("/api/op/me/payout", { method: "PATCH", body: JSON.stringify(body) });
        } catch (e) {
          if (err) {
            err.textContent = e.message;
            err.hidden = false;
          }
        }
      });
      document.getElementById("op-messages")?.addEventListener("click", async (ev) => {
        const row = ev.target.closest(".bubble-row[data-msg-id]");
        if (row && !ev.target.closest(".btn-msg-report")) {
          const mid = row.getAttribute("data-msg-id");
          if (mid) {
            if (selectedAiMessageIds.has(mid)) selectedAiMessageIds.delete(mid);
            else selectedAiMessageIds.add(mid);
            row.classList.toggle("bubble-row--ai-selected", selectedAiMessageIds.has(mid));
            updateAiSelectedCounter();
          }
          return;
        }
        const btn = ev.target.closest(".btn-msg-report");
        if (!btn || opRole !== "staff") return;
        const mid = btn.getAttribute("data-msg-id");
        if (!mid || !activeId) return;
        if (
          !window.confirm(
            "Zgłosić tę wiadomość do właściciela? W następnym kroku możesz dodać krótki komentarz."
          )
        ) {
          return;
        }
        const reason = window.prompt("Komentarz do zgłoszenia (opcjonalnie, max 500 znaków):", "") ?? "";
        btn.disabled = true;
        try {
          await api(`/api/op/inbox/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(mid)}/report`, {
            method: "POST",
            body: JSON.stringify({ reason: reason.trim().slice(0, 500) }),
          });
          await reloadThreadData();
        } catch (e) {
          alert(e.message || String(e));
        } finally {
          btn.disabled = false;
        }
      });
      opMessages?.addEventListener("scroll", () => {
        if (opMessagesScrollRaf) cancelAnimationFrame(opMessagesScrollRaf);
        opMessagesScrollRaf = requestAnimationFrame(() => {
          opMessagesScrollRaf = 0;
          void tryLoadOlderOnScrollNearBottom();
        });
      });
      document.getElementById("fc-cat").addEventListener("change", () =>
        fillCategoryField("consultant", document.getElementById("fc-cat"), document.getElementById("fc-field"))
      );
      document.getElementById("fk-cat").addEventListener("change", () =>
        fillCategoryField("client", document.getElementById("fk-cat"), document.getElementById("fk-field"))
      );
      document.getElementById("fc-val")?.addEventListener("input", updateFactNoteCharCounts);
      document.getElementById("fk-val")?.addEventListener("input", updateFactNoteCharCounts);
      updateFactNoteCharCounts();
      document.getElementById("fc-save").addEventListener("click", async () => {
        const err = document.getElementById("fc-err");
        err.hidden = true;
        if (!activeId) return;
        try {
          await api(`/api/op/inbox/${encodeURIComponent(activeId)}/facts`, {
            method: "PATCH",
            body: JSON.stringify({
              scope: "consultant",
              category: document.getElementById("fc-cat").value,
              field: document.getElementById("fc-field").value,
              value: document.getElementById("fc-val").value,
            }),
          });
          document.getElementById("fc-val").value = "";
          updateFactNoteCharCounts();
          await reloadThreadData();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      });
      document.getElementById("reply").addEventListener("input", updateReplyMeta);
      document.getElementById("fk-save").addEventListener("click", async () => {
        const err = document.getElementById("fk-err");
        err.hidden = true;
        if (!activeId) return;
        try {
          await api(`/api/op/inbox/${encodeURIComponent(activeId)}/facts`, {
            method: "PATCH",
            body: JSON.stringify({
              scope: "client",
              category: document.getElementById("fk-cat").value,
              field: document.getElementById("fk-field").value,
              value: document.getElementById("fk-val").value,
            }),
          });
          document.getElementById("fk-val").value = "";
          updateFactNoteCharCounts();
          await reloadThreadData();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      });
      document.getElementById("btn-ai-clear")?.addEventListener("click", () => {
        clearAiSelection();
        opRenderMessages(currentThreadMessages);
      });
      document.getElementById("btn-ai-generate")?.addEventListener("click", async () => {
        await generateAiDraft();
      });
      document.getElementById("ai-prompt")?.addEventListener("input", () => saveAiPromptToStorage());
    }

    const replyTa = document.getElementById("reply");
    if (replyTa) replyTa.maxLength = opRole === "owner" ? 1500 : 900;

    await refreshInbox();
  } catch {
    showLogin(true);
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const loginErr = document.getElementById("login-err");
  loginErr.hidden = true;
  const fd = new FormData(e.target);
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  try {
    await api("/api/op/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await trySession();
  } catch (err) {
    loginErr.textContent = err.message;
    loginErr.hidden = false;
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/api/op/auth/logout", { method: "POST" });
  clearTouch();
  clearAssignHint();
  activeId = null;
  lastThreadMeta = null;
  currentAssignment = null;
  opId = "";
  ownerConsoleHints = null;
  showLogin(true);
});

document.getElementById("btn-refresh").addEventListener("click", () => refreshInbox());

btnInboxSidebar?.addEventListener("click", () => rozmowyToggle());
inboxBackdrop.addEventListener("click", () => setInboxOpen(false));

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || String(e.key || "").toLowerCase() !== "b" || opRole !== "owner") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
    return;
  e.preventDefault();
  layoutWork?.classList.toggle("layout-work--inbox-collapsed");
  const collapsed = layoutWork?.classList.contains("layout-work--inbox-collapsed");
  btnInboxSidebar?.setAttribute("aria-pressed", collapsed ? "false" : "true");
  try {
    localStorage.setItem(INBOX_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
});

async function refreshInbox() {
  if (opRole !== "owner") {
    await refreshStaffHub();
    await refreshStaffConvView();
    return;
  }
  const teaserWrap = document.getElementById("owner-teaser-panel");
  const inboxEl = document.getElementById("inbox");
  if (inboxBucket === "teaser") {
    if (teaserWrap) teaserWrap.classList.remove("hidden");
    if (inboxEl) inboxEl.classList.add("hidden");
    renderInboxTabs();
    await renderOwnerTeaserPanel();
    return;
  }
  const data = await api(`/api/op/inbox?bucket=${encodeURIComponent(inboxBucket)}`);
  threads = data.threads || [];
  if (teaserWrap) teaserWrap.classList.add("hidden");
  if (inboxEl) inboxEl.classList.remove("hidden");
  renderInboxTabs();
  const inboxPane = document.getElementById("inbox");
  inboxPane.innerHTML = "";
  for (const t of threads) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "thread-item" +
      (t.thread_id === activeId ? " active" : "") +
      (opRole === "owner" ? " thread-item--owner" : "");
    btn.dataset.threadId = t.thread_id;
    const prev = (t.last_preview || "").replace(/\s+/g, " ").slice(0, 72);
    const poolTag =
      opRole === "owner" && !t.assigned_operator_id ? '<span class="pool-tag">pula</span>' : "";
    const clientHide =
      opRole === "owner" && t.client_hidden_at
        ? '<span class="inbox-client-hide" title="Klient schował wątek w swoim panelu — rozmowa trwa">ukr. u kl.</span>'
        : "";
    const stats =
      opRole === "owner"
        ? `<div class="t4">${esc(formatOpPlTimeShort(t.thread_started_at))} · ${
            t.message_count ?? 0
          } wiad. · ostatnio: ${esc(t.last_sender || "—")} ${clientHide}</div>`
        : "";
    btn.innerHTML = `<div class="t1">${esc(t.user_display_name)}</div>
      <div class="t2">${esc(t.character_name)} · ${esc(t.category || "")}</div>
      <div class="t3">${esc(t.last_sender || "")} · ${esc(prev)} ${poolTag}</div>${stats}`;
    btn.addEventListener("click", async () => {
      await openThread(t.thread_id);
      setInboxOpen(false);
    });
    inboxPane.appendChild(btn);
  }
}

async function openThread(id) {
  if (opRole === "owner") setOwnerTab("inbox");
  clearTouch();
  clearAssignHint();
  messagesFetchLimit = 15;
  clearAiSelection();
  activeId = id;
  document.getElementById("reply-err").hidden = true;
  const qe = document.getElementById("queue-err");
  if (qe) {
    qe.hidden = true;
    qe.textContent = "";
  }
  const soe0b = document.getElementById("staff-open-err");
  if (soe0b) {
    soe0b.textContent = "";
    soe0b.hidden = true;
  }
  document.getElementById("reply").value = "";
  const fkVal = document.getElementById("fk-val");
  const fcVal = document.getElementById("fc-val");
  if (fkVal) fkVal.value = "";
  if (fcVal) fcVal.value = "";
  document.getElementById("fk-err").hidden = true;
  document.getElementById("fc-err").hidden = true;
  updateFactNoteCharCounts();
  for (const b of document.querySelectorAll(".thread-item")) {
    b.classList.toggle("active", b.dataset.threadId === id);
  }

  let data;
  try {
    data = await api(inboxMessagesUrl(id, messagesFetchLimit));
  } catch (e) {
    if (activeId !== id) return;
    activeId = null;
    lastThreadMeta = null;
    document.querySelectorAll(".thread-item").forEach((b) => b.classList.remove("active"));
    if (opRole !== "owner") {
      const qe = document.getElementById("queue-err");
      if (qe) {
        qe.textContent = e.message;
        qe.hidden = false;
      }
      const soe = document.getElementById("staff-open-err");
      if (soe) {
        soe.textContent = e.message;
        soe.hidden = false;
      }
      document.getElementById("staff-hub-panel").classList.remove("hidden");
      document.getElementById("chat-body").classList.add("hidden");
      layoutWork.classList.add("no-thread");
    }
    return;
  }
  if (activeId !== id) return;
  const soeOk = document.getElementById("staff-open-err");
  if (soeOk) {
    soeOk.textContent = "";
    soeOk.hidden = true;
  }
  const m = data.meta;
  layoutWork.classList.remove("no-thread");
  document.getElementById("staff-hub-panel").classList.add("hidden");
  document.getElementById("chat-empty").classList.add("hidden");
  document.getElementById("chat-body").classList.remove("hidden");

  const cp = m.client_profile || {};
  const whoName = cp.first_name || m.user_display_name || "?";
  const whoNick = cp.username ? ` @${cp.username}` : "";

  const sts = document.getElementById("side-thread-start");
  if (sts) {
    const startLine = m.thread_started_at ? `Start rozmowy: ${formatOpPlTime(m.thread_started_at)}` : "";
    if (opRole === "owner") {
      const bits = [startLine];
      bits.push(`Wątek: ${m.id}`);
      bits.push(`Klient: ${whoName}${whoNick}`);
      if (m.message_count != null) bits.push(`${m.message_count} wiad.`);
      if (m.client_hidden_at) bits.push("Klient schował wątek u siebie w panelu.");
      sts.textContent = bits.filter(Boolean).join(" · ");
    } else {
      sts.textContent = startLine;
    }
    sts.hidden = !sts.textContent;
  }

  const purl = m.character_portrait_url || FALLBACK_CHAR;
  const chImg = document.getElementById("ch-portrait");
  chImg.src = purl;
  chImg.alt = m.character_name || "";
  document.getElementById("ch-name").textContent = m.character_name || "";
  const mpSide = m.medium_profile || {};
  document.getElementById("ch-tag").textContent =
    [mpSide.gender, m.character_tagline].filter(Boolean).join(" · ") || m.character_tagline || "";

  const name = whoName;
  const avSrc =
    cp.avatar_url && /^data:image\/(png|jpe?g|webp);base64,/i.test(String(cp.avatar_url))
      ? String(cp.avatar_url)
      : "";
  const clImg = document.getElementById("cl-portrait");
  if (avSrc) {
    clImg.src = avSrc.replace(/"/g, "");
  } else {
    clImg.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=128&background=ede9e5&color=1a1816`;
  }
  clImg.alt = name;
  document.getElementById("cl-name").textContent = `${name}${cp.username ? ` (@${cp.username})` : ""}`;
  const cityStr = (cp.city || "").trim();
  const clCity = document.getElementById("cl-city");
  if (clCity) {
    clCity.textContent = cityStr ? `Miasto: ${cityStr}` : "";
    clCity.hidden = !cityStr;
  }
  const birthStr = cp.birth_date ? String(cp.birth_date).slice(0, 10) : "";
  const clBirth = document.getElementById("cl-birth");
  if (clBirth) {
    clBirth.textContent = birthStr ? `Data urodzenia: ${birthStr}` : "";
    clBirth.hidden = !birthStr;
  }
  const clGender = document.getElementById("cl-gender");
  if (clGender) {
    const g =
      cp.gender === "female" ? "Kobieta" : cp.gender === "male" ? "Mężczyzna" : cp.gender === "other" ? "Inna" : "";
    clGender.textContent = g ? `Płeć: ${g}` : "";
    clGender.hidden = !g;
  }
  const clEmail = document.getElementById("cl-email");
  if (clEmail) {
    if (opRole === "owner") {
      clEmail.textContent = m.user_email || "";
      clEmail.hidden = false;
    } else {
      clEmail.textContent = "";
      clEmail.hidden = true;
    }
  }
  const clExtra = document.getElementById("cl-extra");
  if (clExtra) {
    clExtra.textContent = `Dzieci: ${clientTriStateLabel(cp.has_children)} · Palenie: ${clientTriStateLabel(
      cp.smokes
    )} · Alkohol: ${clientTriStateLabel(cp.drinks_alcohol)} · Auto: ${clientTriStateLabel(cp.has_car)}`;
    clExtra.hidden = false;
  }

  setClientAdminActions(m);

  renderMediumSidebar(m);

  lastThreadMeta = data.meta || null;
  lastFacts = data.facts || [];
  renderFactList("client", document.getElementById("fk-list"));
  renderFactList("consultant", document.getElementById("fc-list"));
  setHasMoreFromData(data);
  opRenderMessages(data.messages);
  await runAutoFillOlderUntilScrollable();
  applyAssignmentUI(data.assignment || null);
  updateReplyMeta();
  updateFactNoteCharCounts();
  document.getElementById("reply").focus();
}

async function sendReply() {
  const replyErr = document.getElementById("reply-err");
  replyErr.hidden = true;
  if (!activeId) return;
  const body = document.getElementById("reply").value.trim();
  if (!body) return;
  const min = currentAssignment?.min_reply_chars ?? (opRole === "owner" ? 20 : 100);
  const max = currentAssignment?.reply_max_chars ?? (opRole === "owner" ? 1500 : 900);
  if (body.length < min) {
    replyErr.textContent = `Odpowiedź musi mieć co najmniej ${min} znaków (obecnie ${body.length}).`;
    replyErr.hidden = false;
    return;
  }
  if (body.length > max) {
    replyErr.textContent = `Odpowiedź może mieć maks. ${max} znaków (obecnie ${body.length}).`;
    replyErr.hidden = false;
    return;
  }
  try {
    await api(`/api/op/inbox/${encodeURIComponent(activeId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    document.getElementById("reply").value = "";
    await refreshInbox();
    if (opRole !== "owner") {
      goStaffHub();
    } else {
      await reloadThreadData();
    }
  } catch (e) {
    replyErr.textContent = e.message;
    replyErr.hidden = false;
  }
}

document.getElementById("btn-send").addEventListener("click", () => sendReply());
document.getElementById("reply").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    sendReply();
  }
});

document.getElementById("btn-add-staff").addEventListener("click", async () => {
  const err = document.getElementById("ns-err");
  err.hidden = true;
  const email = document.getElementById("ns-email").value.trim();
  const display_name = document.getElementById("ns-name").value.trim();
  const password = document.getElementById("ns-pass").value;
  try {
    await api("/api/op/staff", {
      method: "POST",
      body: JSON.stringify({ email, display_name, password }),
    });
    document.getElementById("ns-email").value = "";
    document.getElementById("ns-name").value = "";
    document.getElementById("ns-pass").value = "";
    await refreshStaffList();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

trySession();
