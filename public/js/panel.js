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
let sessionKeepTimer = null;
let pollTimer = null;

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
    badgeText: inWin ? "Teraz: wstępne okno online" : "Teraz: poza wstępnym oknem",
    line: `Wstępne godziny (u Ciebie na komputerze): ${rangeText}. Odpowiedź może przyjść także poza tym przedziałem.`,
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

function updateDocumentTitle() {
  const n = unreadCount();
  const base = "Panel klienta — Szept Kart";
  document.title = n > 0 ? `(${n}) ${base}` : base;
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
  if (view === "browse") renderBrowseCatalog();
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
    if (t.client_hidden_at) {
      b.appendChild(document.createTextNode(" · schowana"));
    }
    b.addEventListener("click", () => openCharacter(t.character_id));
    el.appendChild(b);
  }
}

function updateThreadVisibilityRow() {
  const row = document.getElementById("thread-visibility-row");
  const note = document.getElementById("thread-vis-note");
  const btnH = document.getElementById("btn-hide-thread");
  const btnS = document.getElementById("btn-show-thread");
  if (!row || !btnH || !btnS) return;
  if (!selectedId) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  const th = myThreads.find((x) => x.character_id === selectedId);
  if (!th) {
    row.classList.add("hidden");
    return;
  }
  const hidden = !!th.client_hidden_at;
  btnH.classList.toggle("hidden", hidden);
  btnS.classList.toggle("hidden", !hidden);
  if (note) {
    note.textContent = hidden
      ? "Wątek jest schowany tylko w Twoim panelu — u konsultanta nadal widoczny."
      : "";
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

function renderProfileStrip() {
  const line = document.getElementById("panel-profile-line");
  const form = document.getElementById("panel-city-form");
  const inp = document.getElementById("panel-city-input");
  if (!me || !line) return;
  const u = me.user;
  const city = (u.city || "").trim();
  const bd = u.birth_date ? String(u.birth_date).slice(0, 10) : "—";
  line.innerHTML = `Profil: <strong>@${esc(u.username || "?")}</strong> · imię <strong>${esc(
    u.first_name || "?"
  )}</strong> · miasto <strong>${city ? esc(city) : "—"}</strong> · data urodzenia <strong>${esc(bd)}</strong>.`;
  if (form) {
    const need = !city;
    form.classList.toggle("hidden", !need);
    if (inp && need) inp.value = "";
  }
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
  const [ch, pr] = await Promise.all([api("/api/characters"), api("/api/public/pricing")]);
  characters = ch.characters;
  pricing = pr.packages || [];
  await loadThreads();
  updateDocumentTitle();
  renderBrowseCatalog();
  refreshAccountSummary();
  startSessionKeepalive();
  startThreadPoll();
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
  const groups = byCategory(characters);
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
      const about = c.about ? `<p class="browse-card-about">${esc(c.about)}</p>` : "";
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
  const about = c.about ? `<p class="panel-head-about">${esc(c.about)}</p>` : "";
  const skills = c.skills ? `<p class="panel-head-skills">${esc(c.skills)}</p>` : "";
  const gen = c.gender ? `<p class="panel-head-meta"><strong>Płeć (postać):</strong> ${esc(c.gender)}</p>` : "";
  const av = availabilityForCharacter(c);
  const hoursBlock = `<p class="panel-head-hours"><span class="${esc(av.badgeClass)}">${esc(av.badgeText)}</span> ${esc(
    av.line
  )}</p>`;
  const profileLink = `<p class="panel-head-meta"><a class="composer-foot-link" href="/medium.html?id=${encodeURIComponent(
    c.id
  )}">Zobacz pełny profil medium</a></p>`;
  chatHead.innerHTML = `<div class="panel-head-inner">
      <div class="panel-head-avatar"><img src="${src}" alt="" width="112" height="112" loading="lazy" /></div>
      <div class="panel-head-copy">
        <h1>${esc(c.name)}</h1>
        <p class="panel-head-tagline">${esc(c.tagline)}</p>
        ${gen}
        ${skills}
        ${about}
        ${hoursBlock}
        ${profileLink}
      </div>
    </div>`;
  const data = await api(`/api/threads/${encodeURIComponent(id)}/messages`);
  me.messages_remaining = data.messages_remaining;
  setBalance(me.messages_remaining);
  renderMessages(data.messages);
  markSeenFromMessages(id, data.messages);
  composer.classList.remove("hidden");
  await loadThreads();
  renderBrowseCatalog();
  updateThreadVisibilityRow();
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

document.getElementById("tab-browse")?.addEventListener("click", () => switchView("browse"));
document.getElementById("tab-chat")?.addEventListener("click", () => switchView("chat"));
document.getElementById("btn-to-browse")?.addEventListener("click", () => switchView("browse"));

document.getElementById("account-summary-toggle")?.addEventListener("click", () => {
  const card = document.getElementById("account-summary-card");
  if (!card) return;
  card.classList.toggle("hidden");
  refreshAccountSummary();
});

document.getElementById("btn-hide-thread")?.addEventListener("click", async () => {
  if (!selectedId) return;
  try {
    await api(`/api/threads/${encodeURIComponent(selectedId)}/client-visibility`, {
      method: "PATCH",
      body: JSON.stringify({ hidden: true }),
    });
    await loadThreads();
    updateThreadVisibilityRow();
  } catch (e) {
    const se = document.getElementById("send-err");
    if (se) {
      se.textContent = e.message;
      se.hidden = false;
    }
  }
});

document.getElementById("btn-show-thread")?.addEventListener("click", async () => {
  if (!selectedId) return;
  try {
    await api(`/api/threads/${encodeURIComponent(selectedId)}/client-visibility`, {
      method: "PATCH",
      body: JSON.stringify({ hidden: false }),
    });
    await loadThreads();
    updateThreadVisibilityRow();
  } catch (e) {
    const se = document.getElementById("send-err");
    if (se) {
      se.textContent = e.message;
      se.hidden = false;
    }
  }
});

document.getElementById("composer").addEventListener("submit", async (e) => {
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

try {
  await loadMe();
  const openId = new URLSearchParams(window.location.search).get("open");
  if (openId && characters.some((c) => c.id === openId)) {
    history.replaceState({}, "", "/panel.html");
    await openCharacter(openId);
  } else {
    if (openId) history.replaceState({}, "", "/panel.html");
    switchView("browse");
  }
} catch {
  window.location.href = "/logowanie.html";
}
