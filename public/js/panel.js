import { api } from "./api.js";

const browseCatalogEl = document.getElementById("browse-catalog");
const messagesEl = document.getElementById("messages");
const chatHead = document.getElementById("chat-head");
const composer = document.getElementById("composer");
const sendErr = document.getElementById("send-err");

let me = null;
let characters = [];
let selectedId = null;
let myThreads = [];
let pricing = [];
let browseFilter = "Wszystko";
let browseSort = "online";
let sessionKeepTimer = null;
let pollTimer = null;
const ONBOARDING_SNOOZE_KEY = "panel_onboarding_snooze_v1";
const PANEL_CHROME_COLLAPSED_KEY = "panel_chrome_collapsed_v1";

const SEEN_PREFIX = "panel_seen_";
const FALLBACK_PORTRAIT =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200&h=200&fit=crop&q=75";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Czasy z serwera (SQLite UTC) → wyświetlanie w Polsce. */
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

function formatPlPanelTime(s) {
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

function utcSqlTimestampMs(s) {
  const d = parseUtcSqliteDateTime(s);
  return d && !Number.isNaN(d.getTime()) ? d.getTime() : NaN;
}

function setBalance(n) {
  document.getElementById("bal").textContent = `Pozostało: ${n} wiadomości`;
}

function parseTimeHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function normalizedCategory(c) {
  const raw = String(c?.category || "").toLowerCase();
  if (raw.includes("tarot")) return "Tarot";
  if (raw.includes("astrologia")) return "Astrologia";
  if (raw.includes("jasnowid")) return "Jasnowidzenie";
  if (raw.includes("wróż") || raw.includes("wroz")) return "Wróżby";
  return "Wróżby";
}

function slotOfDay(hm) {
  const m = parseTimeHM(hm);
  if (m == null) return "other";
  if (m < 12 * 60) return "morning";
  if (m < 17 * 60) return "afternoon";
  return "evening";
}

function availabilityForCharacter(c) {
  const from = parseTimeHM(c.typical_hours_from);
  const to = parseTimeHM(c.typical_hours_to);
  if (from == null || to == null) {
    return {
      badgeClass: "avail-badge avail-badge--unknown",
      badgeText: "Godziny — do potwierdzenia",
      line: "Brak wpisanych wstępnych godzin — odpowiedź możliwa w różnych porach dnia.",
    };
  }
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  let inWin;
  if (from <= to) inWin = mins >= from && mins <= to;
  else inWin = mins >= from || mins <= to;
  const rangeText = `${c.typical_hours_from} – ${c.typical_hours_to}`;
  return {
    badgeClass: inWin ? "avail-badge avail-badge--on" : "avail-badge avail-badge--off",
    badgeText: inWin ? "Teraz: online" : "Teraz: offline",
    line: `Godziny online: ${rangeText}. (Odpowiedź może przyjść także poza tym przedziałem.)`,
  };
}

function threadIsUnread(thread) {
  if (thread.last_sender !== "staff") return false;
  const seen = localStorage.getItem(SEEN_PREFIX + thread.character_id);
  if (!seen) return true;
  const lastTs = utcSqlTimestampMs(thread.last_at);
  const seenTs = utcSqlTimestampMs(seen);
  if (!Number.isFinite(lastTs) || !Number.isFinite(seenTs)) return true;
  return lastTs > seenTs;
}

function markSeenFromMessages(characterId, messages) {
  if (!messages?.length) {
    localStorage.setItem(SEEN_PREFIX + characterId, new Date().toISOString());
    return;
  }
  const last = messages[messages.length - 1];
  localStorage.setItem(SEEN_PREFIX + characterId, last.created_at);
}

function unreadCount() {
  return myThreads.filter((t) => threadIsUnread(t)).length;
}

function updateMiniUnreadBadge() {
  const n = unreadCount();
  const el = document.getElementById("panel-unread-badge");
  if (!el) return;
  if (n <= 0) {
    el.classList.add("hidden");
    el.textContent = "";
    el.setAttribute("aria-hidden", "true");
    el.removeAttribute("aria-label");
  } else {
    el.classList.remove("hidden");
    el.textContent = n > 99 ? "99+" : String(n);
    el.setAttribute("aria-hidden", "false");
    el.setAttribute(
      "aria-label",
      n === 1 ? "1 nieprzeczytana odpowiedź od konsultanta" : `${n} nieprzeczytane odpowiedzi od konsultantów`
    );
  }
}

function applyPanelChromeCollapsed(collapsed) {
  const root = document.getElementById("panel-chrome-root");
  const toggle = document.getElementById("panel-chrome-toggle");
  const chev = document.getElementById("panel-chrome-chevron");
  const label = document.querySelector(".panel-chrome-toggle-text");
  const bodyEl = document.getElementById("panel-chrome-body");
  if (!root || !toggle) return;
  root.classList.toggle("panel-chrome-root--collapsed", collapsed);
  document.body.classList.toggle("panel-chrome-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (chev) chev.textContent = collapsed ? "▲" : "▼";
  if (label) label.textContent = collapsed ? "Rozwiń" : "Zwiń";
  if (bodyEl) {
    if (collapsed) bodyEl.setAttribute("inert", "");
    else bodyEl.removeAttribute("inert");
  }
  try {
    sessionStorage.setItem(PANEL_CHROME_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function initPanelChromeCollapse() {
  const toggle = document.getElementById("panel-chrome-toggle");
  const root = document.getElementById("panel-chrome-root");
  if (!toggle || !root) return;
  let startCollapsed = false;
  try {
    startCollapsed = sessionStorage.getItem(PANEL_CHROME_COLLAPSED_KEY) === "1";
  } catch {
    /* ignore */
  }
  applyPanelChromeCollapsed(startCollapsed);
  toggle.addEventListener("click", () => {
    const isCollapsed = root.classList.contains("panel-chrome-root--collapsed");
    applyPanelChromeCollapsed(!isCollapsed);
  });
}

const PANEL_NAV_MOBILE_MAX = 720;

function panelNavMobile() {
  return window.matchMedia(`(max-width: ${PANEL_NAV_MOBILE_MAX}px)`).matches;
}

function placeChatSideForViewport() {
  const layout = document.querySelector(".panel-layout--chat");
  const slot = document.getElementById("panel-flyout-thread-slot");
  const main = document.querySelector(".panel-layout--chat .panel-main");
  const side = document.querySelector(".panel-side--threads");
  if (!layout || !slot || !side || !main) return;
  if (panelNavMobile()) {
    if (side.parentElement !== slot) slot.appendChild(side);
  } else if (side.parentElement !== layout) {
    layout.insertBefore(side, main);
  }
}

function panelNavFlyoutClose() {
  const root = document.getElementById("panel-nav-flyout");
  const sheet = document.getElementById("panel-nav-flyout-sheet");
  const tr = document.getElementById("panel-nav-flyout-trigger");
  root?.classList.remove("panel-nav-flyout--open");
  if (sheet) sheet.setAttribute("aria-hidden", panelNavMobile() ? "true" : "false");
  tr?.setAttribute("aria-expanded", "false");
}

function panelNavFlyoutOpen() {
  if (!panelNavMobile()) return;
  const root = document.getElementById("panel-nav-flyout");
  const sheet = document.getElementById("panel-nav-flyout-sheet");
  const tr = document.getElementById("panel-nav-flyout-trigger");
  if (!root || !sheet) return;
  root.classList.add("panel-nav-flyout--open");
  sheet.setAttribute("aria-hidden", "false");
  tr?.setAttribute("aria-expanded", "true");
}

function initPanelNavFlyout() {
  document.getElementById("panel-nav-flyout-trigger")?.addEventListener("click", () => {
    if (!panelNavMobile()) return;
    panelNavFlyoutOpen();
  });
  document.getElementById("panel-nav-flyout-backdrop")?.addEventListener("click", () => {
    panelNavFlyoutClose();
  });
  document.getElementById("panel-nav-flyout-close")?.addEventListener("click", () => {
    panelNavFlyoutClose();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("panel-nav-flyout")?.classList.contains("panel-nav-flyout--open")) return;
    panelNavFlyoutClose();
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      placeChatSideForViewport();
      if (!panelNavMobile()) panelNavFlyoutClose();
    }, 120);
  });
}

function updateDocumentTitle() {
  const n = unreadCount();
  const base = "Panel klienta — Szepty Anielskie";
  document.title = n > 0 ? `(${n}) ${base}` : base;
  const banner = document.getElementById("header-unread-banner");
  if (banner) {
    if (n <= 0) {
      banner.classList.add("hidden");
      banner.textContent = "";
    } else {
      banner.classList.remove("hidden");
      banner.textContent =
        n === 1
          ? "Masz 1 nieprzeczytaną odpowiedź od konsultanta — otwórz zakładkę „Moje rozmowy”, aby ją odczytać."
          : `Masz ${n} nieprzeczytane odpowiedzi od konsultantów — otwórz zakładkę „Moje rozmowy”, aby je odczytać.`;
    }
  }
  updateMiniUnreadBadge();
}

function bestValuePackage() {
  if (!pricing.length) return null;
  const valid = pricing
    .map((p) => ({ amount: Number(p.amount), price_pln: Number(p.price_pln) }))
    .filter((p) => Number.isFinite(p.amount) && Number.isFinite(p.price_pln) && p.amount > 0 && p.price_pln > 0)
    .sort((a, b) => a.price_pln / a.amount - b.price_pln / b.amount || b.amount - a.amount);
  return valid[0] || null;
}

function refreshAccountSummary() {
  const threadEl = document.getElementById("summary-current-thread");
  const statusEl = document.getElementById("summary-last-status");
  const leftEl = document.getElementById("summary-pack-left");
  const bestEl = document.getElementById("summary-best-pack");
  if (!threadEl || !statusEl || !leftEl || !bestEl || !me) return;
  const activeThread = myThreads.find((t) => t.character_id === selectedId);
  threadEl.textContent = activeThread
    ? `Rozmowa: ${activeThread.character_name}`
    : "Rozmowa: nie wybrano jeszcze medium.";
  if (!activeThread) {
    statusEl.textContent = "Status: brak aktywnego wątku.";
  } else {
    statusEl.textContent =
      activeThread.last_sender === "user"
        ? "Status: czekasz na odpowiedź medium."
        : "Status: medium odpowiedziało w tym wątku.";
  }
  leftEl.textContent = `Pakiet wiadomości: pozostało ${me.messages_remaining} wiadomości.`;
  const best = bestValuePackage();
  if (me.messages_remaining <= 3 && best) {
    bestEl.textContent = `Kończy się pakiet. Najbardziej opłacalny pakiet: ${best.amount} wiadomości za ${best.price_pln.toFixed(
      2
    )} zł.`;
  } else if (best) {
    bestEl.textContent = `Najlepsza cena pakietu obecnie: ${best.amount} wiadomości za ${best.price_pln.toFixed(2)} zł.`;
  } else {
    bestEl.textContent = "Pakiety: brak danych cennika.";
  }
}

function showToast(msg) {
  const t = document.getElementById("client-toast");
  const lr = document.getElementById("panel-live-region");
  if (t) {
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => t.classList.add("hidden"), 8000);
  }
  if (lr) lr.textContent = msg;
}

function switchView(view) {
  const vb = document.getElementById("view-browse");
  const vc = document.getElementById("view-chat");
  const tb = document.getElementById("tab-browse");
  const tc = document.getElementById("tab-chat");
  if (!vb || !vc || !tb || !tc) return;
  vb.classList.toggle("hidden", view !== "browse");
  vc.classList.toggle("hidden", view !== "chat");
  tb.classList.toggle("panel-tab--active", view === "browse");
  tc.classList.toggle("panel-tab--active", view === "chat");
  document.body.classList.toggle("page-panel--browse-view", view === "browse");
  document.body.classList.toggle("page-panel--chat-view", view === "chat");
  if (view === "browse") renderBrowseCatalog();
  placeChatSideForViewport();
  panelNavFlyoutClose();
}

async function loadThreads() {
  const before = unreadCount();
  const d = await api("/api/threads");
  myThreads = d.threads || [];
  renderMyThreads();
  const after = unreadCount();
  if (after > before) {
    showToast("Masz nową odpowiedź od konsultanta — otwórz zakładkę „Moje rozmowy”.");
  }
  updateDocumentTitle();
  refreshAccountSummary();
}

function renderMyThreads() {
  const el = document.getElementById("my-threads");
  if (!el) return;
  el.innerHTML = "";
  if (!myThreads.length) {
    el.innerHTML = `<p class="my-thread-empty">Brak rozpoczętych rozmów — wybierz konsultanta w zakładce „Konsultanci”.</p>`;
    return;
  }
  for (const t of myThreads) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "my-thread-row" + (t.character_id === selectedId ? " active" : "");
    const unread = threadIsUnread(t);
    const title = document.createElement("span");
    title.className = "thread-row-title";
    title.textContent = t.character_name;
    b.appendChild(title);
    if (unread) {
      const tag = document.createElement("span");
      tag.className = "thread-new-badge";
      tag.textContent = "Nowa odpowiedź";
      b.appendChild(tag);
    }
    b.addEventListener("click", () => openCharacter(t.character_id));
    el.appendChild(b);
  }
}

function startSessionKeepalive() {
  if (sessionKeepTimer) clearInterval(sessionKeepTimer);
  sessionKeepTimer = setInterval(async () => {
    try {
      const m = await api("/api/me");
      me = m;
      setBalance(m.messages_remaining);
      renderProfileStrip();
    } catch {
      window.location.href = "/logowanie.html";
    }
  }, 120000);
}

function startThreadPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadThreads().catch(() => {});
  }, 35000);
}

let panelCityFormBound = false;

function genderLabelClient(g) {
  if (g === "female") return "Kobieta";
  if (g === "male") return "Mężczyzna";
  if (g === "other") return "Inna / nie podaję";
  return "—";
}

function triStateLabel(v) {
  if (v === "yes") return "Tak";
  if (v === "no") return "Nie";
  return "—";
}

function onboardingNeeded() {
  const u = me?.user;
  if (!u) return false;
  return [u.has_children, u.smokes, u.drinks_alcohol, u.has_car].every((v) => (v || "unknown") === "unknown");
}

function showProfileModal(on) {
  const modal = document.getElementById("profile-settings-modal");
  if (!modal) return;
  if (on) panelNavFlyoutClose();
  modal.classList.toggle("hidden", !on);
  modal.setAttribute("aria-hidden", on ? "false" : "true");
  if (on) refreshAccountSummary();
}

function showOnboardingModal(on) {
  const modal = document.getElementById("panel-onboarding-modal");
  if (!modal) return;
  if (on) panelNavFlyoutClose();
  modal.classList.toggle("hidden", !on);
  modal.setAttribute("aria-hidden", on ? "false" : "true");
}

function maybeOpenOnboardingModal() {
  if (!onboardingNeeded()) return;
  try {
    const snoozeUntil = Number(localStorage.getItem(ONBOARDING_SNOOZE_KEY) || 0);
    if (Number.isFinite(snoozeUntil) && snoozeUntil > Date.now()) return;
  } catch {
    /* ignore */
  }
  const setVal = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value || "unknown";
  };
  const u = me.user;
  setVal("onboarding-has-children", u.has_children);
  setVal("onboarding-smokes", u.smokes);
  setVal("onboarding-drinks-alcohol", u.drinks_alcohol);
  setVal("onboarding-has-car", u.has_car);
  showOnboardingModal(true);
}

function renderProfileStrip() {
  const line = document.getElementById("panel-profile-line");
  const form = document.getElementById("panel-city-form");
  const inp = document.getElementById("panel-city-input");
  if (!me || !line) return;
  const u = me.user;
  const city = (u.city || "").trim();
  const bd = u.birth_date ? String(u.birth_date).slice(0, 10) : "—";
  const gen = genderLabelClient(u.gender);
  const extras = `dzieci <strong>${esc(triStateLabel(u.has_children))}</strong> · palenie <strong>${esc(
    triStateLabel(u.smokes)
  )}</strong> · alkohol <strong>${esc(triStateLabel(u.drinks_alcohol))}</strong> · auto <strong>${esc(
    triStateLabel(u.has_car)
  )}</strong>`;
  line.innerHTML = `Profil: <strong>@${esc(u.username || "?")}</strong> · imię <strong>${esc(
    u.first_name || "?"
  )}</strong> · płeć <strong>${esc(gen)}</strong> · miasto <strong>${city ? esc(city) : "—"}</strong> · data urodzenia <strong>${esc(
    bd
  )}</strong> · ${extras}.`;
  if (form) {
    const need = !city;
    form.classList.toggle("hidden", !need);
    if (inp && need) inp.value = "";
  }
  const settingsCity = document.getElementById("settings-city");
  if (settingsCity) settingsCity.value = city;
  const setSel = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v || "unknown";
  };
  setSel("settings-has-children", u.has_children);
  setSel("settings-smokes", u.smokes);
  setSel("settings-drinks-alcohol", u.drinks_alcohol);
  setSel("settings-has-car", u.has_car);
}

function bindPanelCityFormOnce() {
  if (panelCityFormBound) return;
  const form = document.getElementById("panel-city-form");
  if (!form) return;
  panelCityFormBound = true;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("panel-city-err");
    const inp = document.getElementById("panel-city-input");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    const v = (inp?.value || "").trim();
    try {
      const r = await api("/api/me", { method: "PATCH", body: JSON.stringify({ city: v }) });
      me.user = r.user;
      renderProfileStrip();
      showToast("Zapisano miasto.");
    } catch (x) {
      if (err) {
        err.textContent = x.message || String(x);
        err.hidden = false;
      }
    }
  });
}

async function loadMe() {
  me = await api("/api/me");
  const u = me.user;
  const idle = me.session_idle_minutes ?? 10;
  const whoEl = document.getElementById("who");
  const hintEl = document.getElementById("session-hint");
  if (whoEl) {
    whoEl.textContent = `${u.first_name || u.display_name || "?"} (@${u.username || "?"})`;
  }
  if (hintEl) {
    hintEl.textContent = `${u.email} · wylogowanie po ${idle} min bez ruchu`;
  }
  renderProfileStrip();
  bindPanelCityFormOnce();
  setBalance(me.messages_remaining);
  const ch = await api("/api/characters");
  characters = ch.characters;
  try {
    const pr = await api("/api/public/pricing");
    pricing = pr.packages || [];
  } catch {
    pricing = [];
  }
  await loadThreads();
  renderBrowseCatalog();
  refreshAccountSummary();
  startSessionKeepalive();
  startThreadPoll();
  maybeOpenOnboardingModal();
}

function byCategory(list) {
  const m = new Map();
  for (const c of list) {
    if (!m.has(c.category)) m.set(c.category, []);
    m.get(c.category).push(c);
  }
  return m;
}

function renderBrowseCatalog() {
  if (!browseCatalogEl) return;
  browseCatalogEl.innerHTML = "";
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  let list = [...characters];
  if (browseFilter !== "Wszystko") {
    list = list.filter((c) => normalizedCategory(c) === browseFilter);
  }
  list.sort((a, b) => {
    if (browseSort === "online") {
      const af = availabilityForCharacter(a).badgeClass.includes("--on") ? 0 : 1;
      const bf = availabilityForCharacter(b).badgeClass.includes("--on") ? 0 : 1;
      if (af !== bf) return af - bf;
    } else {
      const order = { morning: 0, afternoon: 1, evening: 2, other: 3 };
      const desired = browseSort;
      const ao = slotOfDay(a.typical_hours_from) === desired ? 0 : order[slotOfDay(a.typical_hours_from)];
      const bo = slotOfDay(b.typical_hours_from) === desired ? 0 : order[slotOfDay(b.typical_hours_from)];
      if (ao !== bo) return ao - bo;
    }
    const ad = Math.abs((parseTimeHM(a.typical_hours_from) ?? nowMins) - nowMins);
    const bd = Math.abs((parseTimeHM(b.typical_hours_from) ?? nowMins) - nowMins);
    if (ad !== bd) return ad - bd;
    return String(a.name).localeCompare(String(b.name), "pl");
  });
  const groups = byCategory(list);
  for (const [cat, items] of groups) {
    const sec = document.createElement("section");
    sec.className = "browse-cat";
    const h = document.createElement("h2");
    h.className = "browse-cat-title";
    h.textContent = cat;
    sec.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "browse-grid";
    for (const c of items) {
      const card = document.createElement("article");
      card.className = "browse-card" + (c.id === selectedId ? " browse-card--active" : "");
      const av = availabilityForCharacter(c);
      const src = esc(c.portrait_url || FALLBACK_PORTRAIT);
      const sk = c.skills ? `<p class="browse-card-skills">${esc(c.skills)}</p>` : "";
      const about = c.about
        ? `<p class="browse-card-about-label">Jak się opisuje</p><p class="browse-card-about">${esc(c.about)}</p>`
        : "";
      const gender = c.gender ? `<p class="browse-card-gender">${esc(c.gender)}</p>` : "";
      const profileHref = `/medium.html?id=${encodeURIComponent(c.id)}`;
      card.innerHTML = `
        <div class="browse-card-top">
          <div class="browse-card-photo"><img src="${src}" alt="" width="120" height="140" loading="lazy" decoding="async" /></div>
          <div class="browse-card-head">
            <span class="${esc(av.badgeClass)}">${esc(av.badgeText)}</span>
            <h3 class="browse-card-name">${esc(c.name)}</h3>
            <p class="browse-card-tag">${esc(c.tagline)}</p>
            ${gender}
          </div>
        </div>
        ${sk}
        ${about}
        <p class="browse-card-hours">${esc(av.line)}</p>
        <div class="browse-card-actions">
          <button type="button" class="btn btn-primary browse-card-cta">Otwórz rozmowę</button>
          <a class="btn btn-outline browse-card-cta-secondary" href="${profileHref}">Profil medium</a>
        </div>`;
      card.querySelector(".browse-card-cta").addEventListener("click", () => {
        switchView("chat");
        openCharacter(c.id);
      });
      grid.appendChild(card);
    }
    sec.appendChild(grid);
    browseCatalogEl.appendChild(sec);
  }
}

async function openCharacter(id) {
  switchView("chat");
  selectedId = id;
  sendErr.textContent = "";
  sendErr.hidden = true;
  composer.classList.add("hidden");
  messagesEl.innerHTML = "";
  const c = characters.find((x) => x.id === id);
  if (!c) return;
  const src = esc(c.portrait_url || FALLBACK_PORTRAIT);
  const av = availabilityForCharacter(c);
  const hoursShort = c.typical_hours_from && c.typical_hours_to
    ? `${esc(c.typical_hours_from)} – ${esc(c.typical_hours_to)}`
    : "";
  // Messenger-style compact head — tylko awatar, nazwa, status
  chatHead.innerHTML = `
    <div class="panel-head-messenger">
      <div class="panel-head-avatar-sm" role="button" tabindex="0" title="Informacje o medium" style="cursor:pointer">
        <img src="${src}" alt="" width="44" height="44" loading="lazy" />
      </div>
      <div class="panel-head-copy-sm">
        <span class="panel-head-name-sm">${esc(c.name)}</span>
        <span class="${esc(av.badgeClass)} panel-head-badge-sm">${esc(av.badgeText)}${hoursShort ? ` · ${hoursShort}` : ""}</span>
      </div>
      <a href="/medium.html?id=${encodeURIComponent(c.id)}" class="btn btn-outline btn-sm panel-head-profile-link">Profil</a>
    </div>`;
  chatHead.querySelector(".panel-head-avatar-sm")?.addEventListener("click", () => showMediumInfoPopup(c));
  chatHead.querySelector(".panel-head-avatar-sm")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showMediumInfoPopup(c); }
  });
  const data = await api(`/api/threads/${encodeURIComponent(id)}/messages`);
  me.messages_remaining = data.messages_remaining;
  setBalance(me.messages_remaining);
  renderMessages(data.messages);
  markSeenFromMessages(id, data.messages);
  composer.classList.remove("hidden");
  await loadThreads();
  renderBrowseCatalog();
}

function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  if (!msgs.length) {
    const p = document.createElement("p");
    p.className = "top-meta";
    p.textContent = "Brak wiadomości w tym wątku — napisz pierwszą.";
    messagesEl.appendChild(p);
    return;
  }
  const c = characters.find((x) => x.id === selectedId);
  const staffName = c?.name
    ? String(c.name)
        .split(/\s[—–-]\s/)[0]
        .trim() || "Konsultant"
    : "Konsultant";
  for (const m of msgs) {
    const div = document.createElement("div");
    div.className = `bubble ${m.sender === "staff" ? "staff" : "user"}`;
    const who = m.sender === "staff" ? staffName : "Ty";
    div.innerHTML = `<span class="meta">${esc(who)} · ${esc(formatPlPanelTime(m.created_at))}</span>${esc(m.body)}`;
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/logowanie.html";
});

function showMediumInfoPopup(c) {
  const modal = document.getElementById("medium-info-modal");
  if (!modal) return;
  panelNavFlyoutClose();
  const titleEl = document.getElementById("medium-modal-title");
  const bodyEl = document.getElementById("medium-modal-body");
  if (titleEl) titleEl.textContent = c.name;
  const src = esc(c.portrait_url || FALLBACK_PORTRAIT);
  const av = availabilityForCharacter(c);
  const hoursShort =
    c.typical_hours_from && c.typical_hours_to
      ? `${esc(c.typical_hours_from)} – ${esc(c.typical_hours_to)}`
      : "";
  bodyEl.innerHTML = `
    <div class="medium-popup-top">
      <div class="medium-popup-photo">
        <img src="${src}" alt="${esc(c.name)}" width="90" height="113" loading="lazy" />
      </div>
      <div>
        <span class="${esc(av.badgeClass)}">${esc(av.badgeText)}</span>
        <p class="medium-popup-tagline">${esc(c.tagline)}</p>
        ${hoursShort ? `<p class="medium-popup-hours">Godziny: ${hoursShort}</p>` : ""}
      </div>
    </div>
    ${c.about ? `<p class="medium-popup-about-label">Jak się opisuje</p><p class="medium-popup-about">${esc(c.about)}</p>` : ""}
    ${c.skills ? `<p class="medium-popup-skills">Specjalizacje: ${esc(c.skills)}</p>` : ""}
    <div class="medium-popup-actions">
      <button type="button" class="btn btn-primary" id="medium-popup-start-btn">Otwórz rozmowę</button>
      <a href="/medium.html?id=${encodeURIComponent(c.id)}" class="btn btn-outline">Pełny profil</a>
    </div>`;
  bodyEl.querySelector("#medium-popup-start-btn")?.addEventListener("click", () => {
    modal.classList.add("hidden");
    openCharacter(c.id);
  });
  modal.classList.remove("hidden");
}

document.getElementById("btn-close-medium-modal")?.addEventListener("click", () => {
  document.getElementById("medium-info-modal")?.classList.add("hidden");
});
document.getElementById("medium-info-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
});

document.getElementById("tab-browse")?.addEventListener("click", () => switchView("browse"));
document.getElementById("tab-chat")?.addEventListener("click", () => switchView("chat"));
document.getElementById("btn-to-browse")?.addEventListener("click", () => switchView("browse"));
document.getElementById("panel-catalog-filters")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  browseFilter = String(btn.dataset.filter || "Wszystko");
  for (const el of document.querySelectorAll("#panel-catalog-filters [data-filter]")) {
    el.classList.toggle("active", el === btn);
  }
  renderBrowseCatalog();
});
document.getElementById("panel-sort")?.addEventListener("change", (event) => {
  browseSort = String(event.target.value || "online");
  renderBrowseCatalog();
});

document.getElementById("account-summary-toggle")?.addEventListener("click", () => {
  showProfileModal(true);
});

document.getElementById("btn-close-profile")?.addEventListener("click", () => {
  showProfileModal(false);
});

// Zamknij profile modal po kliknięciu w tło
document.getElementById("profile-settings-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) showProfileModal(false);
});

document.getElementById("panel-onboarding-later")?.addEventListener("click", () => {
  try {
    localStorage.setItem(ONBOARDING_SNOOZE_KEY, String(Date.now() + 12 * 60 * 60 * 1000));
  } catch {
    /* ignore */
  }
  showOnboardingModal(false);
});

document.getElementById("panel-onboarding-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = document.getElementById("panel-onboarding-err");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const payload = {
    has_children: String(document.getElementById("onboarding-has-children")?.value || "unknown").trim(),
    smokes: String(document.getElementById("onboarding-smokes")?.value || "unknown").trim(),
    drinks_alcohol: String(document.getElementById("onboarding-drinks-alcohol")?.value || "unknown").trim(),
    has_car: String(document.getElementById("onboarding-has-car")?.value || "unknown").trim(),
  };
  try {
    const result = await api("/api/me", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    me.user = result.user;
    renderProfileStrip();
    showOnboardingModal(false);
    showToast("Zapisano dodatkowe informacje w profilu.");
  } catch (e) {
    if (err) {
      err.hidden = false;
      err.textContent = e.message || String(e);
    }
  }
});

document.getElementById("body")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  if (composer?.classList.contains("hidden")) return;
  e.preventDefault();
  composer?.requestSubmit();
});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  sendErr.hidden = true;
  const body = document.getElementById("body").value.trim();
  if (!selectedId || !body) return;
  try {
    await api(`/api/threads/${encodeURIComponent(selectedId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    document.getElementById("body").value = "";
    const data = await api(`/api/threads/${encodeURIComponent(selectedId)}/messages`);
    me.messages_remaining = data.messages_remaining;
    setBalance(me.messages_remaining);
    renderMessages(data.messages);
    markSeenFromMessages(selectedId, data.messages);
    await loadThreads();
    renderBrowseCatalog();
  } catch (err) {
    sendErr.textContent = err.message;
    sendErr.hidden = false;
  }
});

document.getElementById("panel-settings-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("settings-profile-err");
  if (err) err.hidden = true;
  const city = String(document.getElementById("settings-city")?.value || "").trim();
  const has_children = String(document.getElementById("settings-has-children")?.value || "unknown").trim();
  const smokes = String(document.getElementById("settings-smokes")?.value || "unknown").trim();
  const drinks_alcohol = String(document.getElementById("settings-drinks-alcohol")?.value || "unknown").trim();
  const has_car = String(document.getElementById("settings-has-car")?.value || "unknown").trim();
  const avatarFile = document.getElementById("settings-avatar")?.files?.[0];
  let avatar_url = undefined;
  if (avatarFile) {
    if (avatarFile.size > 420000) {
      if (err) {
        err.textContent = "Zdjęcie jest za duże (max ok. 400 KB).";
        err.hidden = false;
      }
      return;
    }
    avatar_url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(new Error("Nie udało się odczytać zdjęcia."));
      r.readAsDataURL(avatarFile);
    });
  }
  try {
    const payload = { city, has_children, smokes, drinks_alcohol, has_car };
    if (avatar_url) payload.avatar_url = avatar_url;
    const r = await api("/api/me", { method: "PATCH", body: JSON.stringify(payload) });
    me.user = r.user;
    renderProfileStrip();
    showToast("Zapisano ustawienia profilu.");
  } catch (x) {
    if (err) {
      err.textContent = x.message || String(x);
      err.hidden = false;
    }
  }
});

document.getElementById("panel-password-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("settings-password-err");
  if (err) err.hidden = true;
  const current_password = String(document.getElementById("settings-current-pass")?.value || "");
  const new_password = String(document.getElementById("settings-new-pass")?.value || "");
  try {
    await api("/api/me/change-password", { method: "POST", body: JSON.stringify({ current_password, new_password }) });
    document.getElementById("settings-current-pass").value = "";
    document.getElementById("settings-new-pass").value = "";
    showToast("Hasło zostało zmienione.");
  } catch (x) {
    if (err) {
      err.textContent = x.message || String(x);
      err.hidden = false;
    }
  }
});

document.getElementById("panel-email-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("settings-email-err");
  if (err) err.hidden = true;
  const new_email = String(document.getElementById("settings-new-email")?.value || "").trim();
  try {
    await api("/api/me/request-email-change", { method: "POST", body: JSON.stringify({ new_email }) });
    document.getElementById("settings-new-email").value = "";
    showToast("Wysłaliśmy link potwierdzający zmianę e-mail na nowy adres.");
  } catch (x) {
    if (err) {
      err.textContent = x.message || String(x);
      err.hidden = false;
    }
  }
});

try {
  initPanelChromeCollapse();
  initPanelNavFlyout();
  placeChatSideForViewport();
  panelNavFlyoutClose();
  await loadMe();
  const openId = new URLSearchParams(window.location.search).get("open");
  if (openId && characters.some((c) => c.id === openId)) {
    history.replaceState({}, "", "/panel.html");
    await openCharacter(openId);
  } else {
    if (openId) history.replaceState({}, "", "/panel.html");
    switchView("browse");
  }
} catch (e) {
  if (e?.status === 401 || e?.status === 403) {
    window.location.href = "/logowanie.html";
  } else {
    const se = document.getElementById("send-err");
    if (se) {
      se.textContent = "Nie udało się załadować panelu. Odśwież stronę.";
      se.hidden = false;
    }
  }
}
