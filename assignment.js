/**
 * Pula ręczna (bez auto-przydziału), ok. 4 min pierwszeństwa po odpowiedzi klienta,
 * limit minut na odpowiedź od przejęcia wątku (domyślnie 6), bezczynność 2 min.
 */

const REPLY_DEADLINE_MIN = Number(process.env.STAFF_REPLY_DEADLINE_MINUTES || 6);
const IDLE_KICK_MIN = Number(process.env.STAFF_IDLE_KICK_MINUTES || 2);
const RECLAIM_MIN = Number(process.env.STAFF_RECLAIM_WINDOW_MINUTES || 1);
const RESUME_PRIORITY_MIN = Number(process.env.STAFF_RESUME_PRIORITY_MINUTES || 4);
const QUEUE_VISIBLE_MAX = Number(process.env.STAFF_QUEUE_VISIBLE_MAX || 5);
const QUEUE_FETCH_CAP = 150;

export const STAFF_REPLY_MIN_CHARS = Number(process.env.STAFF_REPLY_MIN_CHARS || 100);
export const OWNER_REPLY_MIN_CHARS = Number(process.env.OWNER_REPLY_MIN_CHARS || 20);
export const STAFF_REPLY_MAX_CHARS = Number(process.env.STAFF_REPLY_MAX_CHARS || 900);
export const OWNER_REPLY_MAX_CHARS = Number(process.env.OWNER_REPLY_MAX_CHARS || 1500);

const REMINDER_AFTER_STAFF_HOURS = Math.min(
  168,
  Math.max(1, Number(process.env.STAFF_REMINDER_AFTER_STAFF_HOURS || 48))
);

async function countAssignedThreadsForOperator(db, operatorId) {
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM threads WHERE assigned_operator_id = ?`)
    .get(operatorId);
  return Number(r?.c || 0);
}

/** SQLite `datetime('now')` / domyślne created_at bez strefy — traktujemy jako UTC, żeby JS nie liczył „+2 h” jak lokalne. */
function parseMessageTimestamp(s) {
  if (s == null || s === "") return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return new Date(str);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) return new Date(str);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) {
    return new Date(str.replace(" ", "T") + "Z");
  }
  return new Date(str);
}

function dtNow() {
  return new Date().toISOString();
}

function dtPlusMinutes(m) {
  return new Date(Date.now() + m * 60 * 1000).toISOString();
}

function responseDueFromUserMessageIso(userMsgIso) {
  if (!userMsgIso) return dtPlusMinutes(REPLY_DEADLINE_MIN);
  const base = parseMessageTimestamp(userMsgIso);
  if (!base || Number.isNaN(base.getTime())) return dtPlusMinutes(REPLY_DEADLINE_MIN);
  return new Date(base.getTime() + REPLY_DEADLINE_MIN * 60 * 1000).toISOString();
}

export async function lastMessageSender(db, threadId) {
  const r = await db
    .prepare(
      `SELECT sender FROM messages WHERE thread_id = ? ORDER BY datetime(created_at) DESC LIMIT 1`
    )
    .get(threadId);
  return r?.sender || null;
}

async function lastUserMessageRow(db, threadId) {
  return await db
    .prepare(
      `SELECT created_at FROM messages WHERE thread_id = ? AND sender = 'user' ORDER BY datetime(created_at) DESC LIMIT 1`
    )
    .get(threadId);
}

async function lastStaffWithOperator(db, threadId) {
  return await db
    .prepare(
      `SELECT operator_id FROM messages WHERE thread_id = ? AND sender = 'staff' AND operator_id IS NOT NULL ORDER BY datetime(created_at) DESC LIMIT 1`
    )
    .get(threadId);
}

async function sweepExpiredResume(db) {
  await db
    .prepare(
      `UPDATE threads SET resume_operator_id = NULL, resume_until = NULL
     WHERE resume_until IS NOT NULL AND datetime(resume_until) < datetime('now')`
    )
    .run();
}

/** Zwolnienie po bezczynności (2 min przy aktywnym terminie odpowiedzi). */
async function idleKick(db, t) {
  const prev = t.assigned_operator_id;
  await db
    .prepare(
      `UPDATE threads SET
       assigned_operator_id = NULL,
       response_due_at = NULL,
       last_staff_activity_at = NULL,
       reclaim_operator_id = ?,
       reclaim_until = ?
     WHERE id = ?`
    )
    .run(prev, dtPlusMinutes(RECLAIM_MIN), t.id);
}

/** Po STAFF_REPLY_DEADLINE min od ostatniej wiadomości klienta — zwolnij wątek. */
async function deadlineMiss(db, t) {
  await db
    .prepare(
      `UPDATE threads SET
       assigned_operator_id = NULL,
       response_due_at = NULL,
       last_staff_activity_at = NULL,
       reclaim_operator_id = NULL,
       reclaim_until = NULL
     WHERE id = ?`
    )
    .run(t.id);
}

export async function sweepAssignments(db) {
  await sweepExpiredResume(db);
  await db
    .prepare(
      `UPDATE threads SET reclaim_operator_id = NULL, reclaim_until = NULL
     WHERE reclaim_until IS NOT NULL AND datetime(reclaim_until) < datetime('now')`
    )
    .run();

  const rows = await db
    .prepare(
      `SELECT id, assigned_operator_id, response_due_at, last_staff_activity_at
       FROM threads
       WHERE assigned_operator_id IS NOT NULL`
    )
    .all();

  for (const t of rows) {
    if (t.response_due_at && t.last_staff_activity_at) {
      const idleUntil = new Date(
        new Date(t.last_staff_activity_at).getTime() + IDLE_KICK_MIN * 60 * 1000
      ).toISOString();
      if (new Date() > new Date(idleUntil)) {
        await idleKick(db, t);
        continue;
      }
    }
    if (t.response_due_at && new Date() > new Date(t.response_due_at)) {
      if ((await lastMessageSender(db, t.id)) === "user") {
        await deadlineMiss(db, t);
      }
    }
  }
}

/** Po wiadomości od klienta: pierwszeństwo dla ostatniego konsultanta (4 min), przedłużenie terminu jeśli wątek już obsadzony. */
export async function onClientMessage(db, threadId) {
  await sweepAssignments(db);
  const lastStaff = await lastStaffWithOperator(db, threadId);
  if (lastStaff?.operator_id) {
    await db.prepare(`UPDATE threads SET resume_operator_id = ?, resume_until = ? WHERE id = ?`).run(
      lastStaff.operator_id,
      dtPlusMinutes(RESUME_PRIORITY_MIN),
      threadId
    );
  } else {
    await db.prepare(`UPDATE threads SET resume_operator_id = NULL, resume_until = NULL WHERE id = ?`).run(
      threadId
    );
  }

  const t = await db.prepare(`SELECT assigned_operator_id FROM threads WHERE id = ?`).get(threadId);
  if (t?.assigned_operator_id) {
    const u = await lastUserMessageRow(db, threadId);
    const due = responseDueFromUserMessageIso(u?.created_at);
    await db.prepare(`UPDATE threads SET response_due_at = ?, last_staff_activity_at = ? WHERE id = ?`).run(
      due,
      dtNow(),
      threadId
    );
  }
}

/** Po odpowiedzi: właściciel — tylko kasuje termin; pracownik — zwalnia wątek (jedna odpowiedź na przejęcie). */
export async function onStaffReply(db, threadId, operator) {
  const isOwner = operator.role === "owner";
  if (isOwner) {
    await db
      .prepare(
        `UPDATE threads SET
         response_due_at = NULL,
         last_staff_activity_at = ?,
         resume_operator_id = NULL,
         resume_until = NULL
       WHERE id = ?`
      )
      .run(dtNow(), threadId);
    return;
  }
  await db
    .prepare(
      `UPDATE threads SET
       assigned_operator_id = NULL,
       response_due_at = NULL,
       last_staff_activity_at = ?,
       resume_operator_id = NULL,
       resume_until = NULL,
       reclaim_operator_id = NULL,
       reclaim_until = NULL
     WHERE id = ?`
    )
    .run(dtNow(), threadId);
}

export async function bumpStaffActivity(db, threadId, operatorId) {
  const t = await db.prepare(`SELECT assigned_operator_id FROM threads WHERE id = ?`).get(threadId);
  if (t?.assigned_operator_id === operatorId) {
    await db.prepare(`UPDATE threads SET last_staff_activity_at = ? WHERE id = ?`).run(dtNow(), threadId);
  }
}

/** Skrzynka „Moje rozmowy”: tylko przypisane do pracownika; właściciel — wszystkie. */
export function inboxFilterForOperator(operator) {
  if (operator.role === "owner") return { sql: "1=1", params: [] };
  return { sql: "t.assigned_operator_id = ?", params: [operator.id] };
}

const sqlLastSender = `(SELECT m.sender FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1)`;
const sqlLastAt = `(SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY datetime(m.created_at) DESC LIMIT 1)`;
const sqlUserMsgCount = `(SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender = 'user')`;

/**
 * Filtr listy rozmów (zakładki): mine | pool | no_user | stopped | pending | all (właściciel).
 */
export function inboxBucketClause(operator, bucketRaw) {
  const isOwner = operator.role === "owner";
  const b = String(bucketRaw || "")
    .trim()
    .toLowerCase();
  if (isOwner) {
    if (!b || b === "all" || b === "mine") return { sql: "1=1", params: [] };
  } else {
    if (!b || b === "mine") return { sql: "t.assigned_operator_id = ?", params: [operator.id] };
  }
  if (b === "pool") {
    return {
      sql: `t.assigned_operator_id IS NULL AND ${sqlLastSender} = 'user'`,
      params: [],
    };
  }
  if (b === "no_user") {
    if (!isOwner) return { sql: "0=1", params: [] };
    return { sql: `${sqlUserMsgCount} = 0`, params: [] };
  }
  if (b === "stopped") {
    return {
      sql: `t.assigned_operator_id IS NULL AND ${sqlLastSender} = 'staff' AND datetime(${sqlLastAt}) <= datetime('now', '-${REMINDER_AFTER_STAFF_HOURS} hours')`,
      params: [],
    };
  }
  if (b === "pending") {
    if (!isOwner) return { sql: "0=1", params: [] };
    return {
      sql: `${sqlLastSender} = 'user'`,
      params: [],
    };
  }
  return isOwner ? { sql: "1=1", params: [] } : { sql: "t.assigned_operator_id = ?", params: [operator.id] };
}

export async function isStoppedReminderEligible(db, threadId) {
  const t = await db
    .prepare(
      `SELECT assigned_operator_id FROM threads WHERE id = ?`
    )
    .get(threadId);
  if (!t || t.assigned_operator_id) return false;
  const last = await db
    .prepare(
      `SELECT sender, created_at FROM messages WHERE thread_id = ? ORDER BY datetime(created_at) DESC LIMIT 1`
    )
    .get(threadId);
  if (!last || last.sender !== "staff") return false;
  const ts = parseMessageTimestamp(last.created_at);
  if (!ts || Number.isNaN(ts.getTime())) return false;
  const ms = REMINDER_AFTER_STAFF_HOURS * 3600 * 1000;
  return Date.now() - ts.getTime() >= ms;
}

export async function threadVisibleToOperator(db, threadId, operatorId, role) {
  if (role === "owner") return true;
  const t = await db.prepare(`SELECT assigned_operator_id FROM threads WHERE id = ?`).get(threadId);
  return t?.assigned_operator_id === operatorId;
}

export async function assertStaffCanMutate(db, operator, threadId) {
  await sweepAssignments(db);
  if (operator.role === "owner") return { ok: true };

  const t = await db
    .prepare(
      `SELECT assigned_operator_id, response_due_at FROM threads WHERE id = ?`
    )
    .get(threadId);
  if (!t) return { ok: false, code: 404, error: "Nie znaleziono wątku." };

  if (t.assigned_operator_id === operator.id) {
    if (t.response_due_at && new Date() > new Date(t.response_due_at)) {
      return { ok: false, code: 403, error: "Minął limit czasu na odpowiedź — wątek wrócił do puli." };
    }
    return { ok: true };
  }

  if (t.assigned_operator_id) {
    return { ok: false, code: 403, error: "Ten wątek jest przypisany do innego pracownika." };
  }

  return { ok: false, code: 403, error: "Najpierw przejmij wątek z puli." };
}

export async function ensureReplyPermission(db, operator, threadId) {
  await sweepAssignments(db);
  if (operator.role === "owner") return { ok: true };

  const t = await db.prepare(`SELECT assigned_operator_id, response_due_at FROM threads WHERE id = ?`).get(threadId);
  if (!t) return { ok: false, code: 404, error: "Nie znaleziono wątku." };

  if (t.assigned_operator_id === operator.id) {
    if (t.response_due_at && new Date() > new Date(t.response_due_at)) {
      return { ok: false, code: 403, error: "Minął limit czasu na odpowiedź." };
    }
    return { ok: true };
  }

  return { ok: false, code: 403, error: "Najpierw przejmij wątek z puli." };
}

async function staffCharsInThread(db, threadId, operatorId) {
  const r = await db
    .prepare(
      `SELECT IFNULL(SUM(LENGTH(body)), 0) AS n FROM messages
       WHERE thread_id = ? AND sender = 'staff' AND operator_id = ?`
    )
    .get(threadId, operatorId);
  return Number(r?.n || 0);
}

/** Wątki w puli (ostatnia wiadomość od klienta); termin odpowiedzi liczy się od przejęcia. */
async function getStaffQueueRows(db, operatorId, limit = QUEUE_VISIBLE_MAX) {
  const raw = await db
    .prepare(
      `SELECT t.id,
        (SELECT m.created_at FROM messages m
         WHERE m.thread_id = t.id AND m.sender = 'user'
         ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_user_at,
        CASE
          WHEN t.resume_operator_id = ? AND datetime(t.resume_until) > datetime('now') THEN 0
          ELSE 1
        END AS pri_sort
      FROM threads t
      WHERE t.assigned_operator_id IS NULL
        AND (SELECT sender FROM messages m2 WHERE m2.thread_id = t.id
             ORDER BY datetime(m2.created_at) DESC LIMIT 1) = 'user'
        AND (
          t.resume_operator_id IS NULL
          OR t.resume_until IS NULL
          OR datetime(t.resume_until) < datetime('now')
          OR t.resume_operator_id = ?
        )
        AND (
          t.reclaim_operator_id IS NULL
          OR t.reclaim_until IS NULL
          OR datetime(t.reclaim_until) < datetime('now')
          OR t.reclaim_operator_id = ?
        )
      ORDER BY pri_sort ASC,
        datetime(COALESCE(
          (SELECT m3.created_at FROM messages m3
           WHERE m3.thread_id = t.id AND m3.sender = 'user'
           ORDER BY datetime(m3.created_at) DESC LIMIT 1),
          t.created_at
        )) ASC
      LIMIT ?`
    )
    .all(operatorId, operatorId, operatorId, QUEUE_FETCH_CAP);

  return raw
    .filter((r) => r.last_user_at)
    .slice(0, limit)
    .map((r) => ({ id: r.id, last_user_at: r.last_user_at }));
}

export async function canStaffPickFromQueue(db, operatorId, threadId) {
  const rows = await getStaffQueueRows(db, operatorId, QUEUE_VISIBLE_MAX);
  return rows.some((r) => r.id === threadId);
}

export async function getStaffQueueSlots(db, operatorId) {
  await sweepAssignments(db);
  const rows = await getStaffQueueRows(db, operatorId, QUEUE_VISIBLE_MAX);
  const now = Date.now();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t0 = parseMessageTimestamp(r.last_user_at)?.getTime();
    const waitMs = t0 != null && !Number.isNaN(t0) ? now - t0 : 0;
    const waitSec = Math.max(0, Math.floor(waitMs / 1000));
    const waitLabel =
      waitSec < 90 ? `${waitSec} s` : `ok. ${Math.floor(waitSec / 60)} min`;
    const exclusive = !!(await db
      .prepare(
        `SELECT 1 FROM threads WHERE id = ?
           AND resume_operator_id = ? AND datetime(resume_until) > datetime('now')`
      )
      .get(r.id, operatorId));
    out.push({
      slot: i + 1,
      thread_id: r.id,
      waiting_label: waitLabel,
      exclusive_for_you: !!exclusive,
    });
  }
  return out;
}

export async function getOperatorStats(db, operatorId) {
  const sent = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE sender = 'staff' AND operator_id = ?`
    )
    .get(operatorId);
  const active = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM threads WHERE assigned_operator_id = ? AND response_due_at IS NOT NULL`
    )
    .get(operatorId);
  return {
    messages_sent: sent.c,
    active_waiting_threads: active.c,
  };
}

/** Statystyki pracownika: okna czasowe + szacunek wynagrodzenia wg stawki z .env */
export async function getStaffDashboard(db, operatorId) {
  const ratePln = Number(process.env.STAFF_RATE_PLN_PER_REPLY || 0.39);
  const q = async (sql) => Number((await db.prepare(sql).get(operatorId))?.c ?? 0);
  const today = await q(
    `SELECT COUNT(*) AS c FROM messages WHERE sender = 'staff' AND operator_id = ?
     AND date(created_at) = date('now')`
  );
  const last7 = await q(
    `SELECT COUNT(*) AS c FROM messages WHERE sender = 'staff' AND operator_id = ?
     AND datetime(created_at) >= datetime('now', '-7 days')`
  );
  const prev7 = await q(
    `SELECT COUNT(*) AS c FROM messages WHERE sender = 'staff' AND operator_id = ?
     AND datetime(created_at) >= datetime('now', '-14 days')
     AND datetime(created_at) < datetime('now', '-7 days')`
  );
  const total = await q(
    `SELECT COUNT(*) AS c FROM messages WHERE sender = 'staff' AND operator_id = ?`
  );
  const stats = await getOperatorStats(db, operatorId);
  const estTotal = Math.round(total * ratePln * 100) / 100;
  const estToday = Math.round(today * ratePln * 100) / 100;
  const estLast7 = Math.round(last7 * ratePln * 100) / 100;
  const estPrev7 = Math.round(prev7 * ratePln * 100) / 100;
  return {
    rate_pln_per_reply: ratePln,
    messages_sent_total: total,
    messages_today: today,
    messages_last_7_days: last7,
    messages_prev_7_days: prev7,
    active_waiting_threads: stats.active_waiting_threads,
    estimated_earnings_pln_total: estTotal,
    estimated_earnings_today_pln: estToday,
    estimated_earnings_last_7_days_pln: estLast7,
    estimated_earnings_prev_7_days_pln: estPrev7,
  };
}

function parseTimeHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function minuteInWindow(nowMinute, fromMinute, toMinute) {
  if (fromMinute <= toMinute) return nowMinute >= fromMinute && nowMinute <= toMinute;
  return nowMinute >= fromMinute || nowMinute <= toMinute;
}

function minutesToNextStart(nowMinute, fromMinute) {
  let diff = fromMinute - nowMinute;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function capitalizePlWord(s) {
  const txt = String(s || "").trim();
  if (!txt) return "";
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function getWarsawNowInfo(now = new Date()) {
  const dtf = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const weekday = capitalizePlWord(map.weekday || "");
  const day = map.day || "";
  const month = map.month || "";
  const year = map.year || "";
  const hour = map.hour || "00";
  const minute = map.minute || "00";
  const hourN = Number(hour);
  const minuteN = Number(minute);
  const nowMinutes = Number.isFinite(hourN) && Number.isFinite(minuteN) ? hourN * 60 + minuteN : 0;
  return {
    timezone: "Europe/Warsaw",
    now_iso_utc: now.toISOString(),
    weekday_pl: weekday,
    date_pl: `${day}.${month}.${year}`,
    time_pl: `${hour}:${minute}`,
    label_pl: `${weekday}, ${day}.${month}.${year}, ${hour}:${minute}`,
    now_minutes: nowMinutes,
  };
}

function formatWarsawWeekdayHour(when) {
  return capitalizePlWord(
    new Intl.DateTimeFormat("pl-PL", {
      timeZone: "Europe/Warsaw",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(when)
  );
}

function classifyCharactersByAvailability(characters, nowInfo) {
  const online_now = [];
  const online_within_hour = [];
  const offline = [];
  const nowMinute = nowInfo.now_minutes;
  const nowDate = new Date();

  for (const c of characters) {
    const fromMinute = parseTimeHM(c.typical_hours_from);
    const toMinute = parseTimeHM(c.typical_hours_to);
    const base = {
      id: c.id,
      name: c.name,
      category: c.category || "",
      typical_hours_from: c.typical_hours_from || "",
      typical_hours_to: c.typical_hours_to || "",
      next_online_in_minutes: null,
      next_online_label_pl: "",
      status: "offline",
    };

    if (fromMinute == null || toMinute == null) {
      offline.push({
        ...base,
        status_reason: "Brak pełnych godzin dostępności.",
      });
      continue;
    }

    if (minuteInWindow(nowMinute, fromMinute, toMinute)) {
      online_now.push({
        ...base,
        status: "online_now",
      });
      continue;
    }

    const minsToStart = minutesToNextStart(nowMinute, fromMinute);
    const startAt = new Date(nowDate.getTime() + minsToStart * 60 * 1000);
    const nextLabel = formatWarsawWeekdayHour(startAt);
    if (minsToStart > 0 && minsToStart <= 60) {
      online_within_hour.push({
        ...base,
        status: "online_within_hour",
        next_online_in_minutes: minsToStart,
        next_online_label_pl: nextLabel,
      });
    } else {
      offline.push({
        ...base,
        status: "offline",
        next_online_in_minutes: minsToStart,
        next_online_label_pl: nextLabel,
      });
    }
  }

  return {
    online_now,
    online_within_hour,
    offline,
    totals: {
      all: characters.length,
      online_now: online_now.length,
      online_within_hour: online_within_hour.length,
      offline: offline.length,
    },
  };
}

export async function getOperatorMonitorSnapshot(db) {
  const nowInfo = getWarsawNowInfo();
  const operators = await db
    .prepare(
      `SELECT o.id, o.email, o.display_name, o.role, o.disabled_at,
        COALESCE(o.kyc_status, 'unverified') AS kyc_status,
        (SELECT COUNT(*) FROM messages m WHERE m.sender = 'staff' AND m.operator_id = o.id) AS messages_sent,
        (SELECT COUNT(*) FROM operator_sessions s
         WHERE s.operator_id = o.id AND datetime(s.expires_at) > datetime('now')) AS active_sessions,
        (SELECT COUNT(*) FROM threads t WHERE t.assigned_operator_id = o.id) AS threads_assigned_now,
        (SELECT COUNT(*) FROM threads t
         WHERE t.assigned_operator_id = o.id AND t.response_due_at IS NOT NULL) AS threads_awaiting_reply,
        (SELECT COUNT(*) FROM messages m
         WHERE m.sender = 'staff' AND m.operator_id = o.id
           AND datetime(m.created_at) >= datetime('now', '-7 days')) AS staff_replies_7d,
        (SELECT COUNT(*) FROM operator_audit a
         WHERE a.operator_id = o.id AND a.action = 'fact_save'
           AND datetime(a.created_at) >= datetime('now', '-7 days')) AS fact_saves_7d,
        (SELECT COUNT(*) FROM operator_audit a
         WHERE a.operator_id = o.id AND a.action = 'fact_delete'
           AND datetime(a.created_at) >= datetime('now', '-7 days')) AS fact_deletes_7d
       FROM operators o
       ORDER BY CASE WHEN o.role = 'owner' THEN 0 ELSE 1 END, o.email`
    )
    .all();
  const characters = await db
    .prepare(
      `SELECT id, name, category, typical_hours_from, typical_hours_to
       FROM characters
       ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
    )
    .all();
  const medium_status = classifyCharactersByAvailability(characters, nowInfo);
  const audits = await db
    .prepare(
      `SELECT a.id, a.operator_id, a.action, a.thread_id, a.detail, a.created_at, o.email AS operator_email
       FROM operator_audit a
       JOIN operators o ON o.id = a.operator_id
       ORDER BY datetime(a.created_at) DESC
       LIMIT 120`
    )
    .all();
  return {
    operators,
    audits,
    monitor_time: nowInfo,
    medium_status,
  };
}

export async function getAssignmentPayload(db, threadId, operator) {
  await sweepAssignments(db);
  const t = await db
    .prepare(
      `SELECT assigned_operator_id, response_due_at, reclaim_operator_id, reclaim_until,
              last_staff_activity_at
       FROM threads WHERE id = ?`
    )
    .get(threadId);
  if (!t) return null;
  const vis = await threadVisibleToOperator(db, threadId, operator.id, operator.role);
  const isOwner = operator.role === "owner";
  const mine = t.assigned_operator_id === operator.id;

  let idle_kick_at = null;
  if (mine && t.response_due_at && t.last_staff_activity_at) {
    const act = parseMessageTimestamp(t.last_staff_activity_at);
    if (act && !Number.isNaN(act.getTime())) {
      idle_kick_at = new Date(act.getTime() + IDLE_KICK_MIN * 60 * 1000).toISOString();
    }
  }

  let staff_chars_in_thread = null;
  if (mine && !isOwner) {
    staff_chars_in_thread = await staffCharsInThread(db, threadId, operator.id);
  }

  const min_reply_chars = isOwner ? OWNER_REPLY_MIN_CHARS : STAFF_REPLY_MIN_CHARS;
  const reply_max_chars = isOwner ? OWNER_REPLY_MAX_CHARS : STAFF_REPLY_MAX_CHARS;

  let reclaim_for_me = false;
  if (
    t.reclaim_operator_id === operator.id &&
    t.reclaim_until &&
    new Date(t.reclaim_until) > new Date()
  ) {
    reclaim_for_me = true;
  }

  return {
    assigned_operator_id: t.assigned_operator_id,
    response_due_at: t.response_due_at,
    reclaim_until: t.reclaim_until,
    reclaim_operator_id: t.reclaim_operator_id,
    reclaim_for_me,
    last_staff_activity_at: t.last_staff_activity_at,
    visible: vis,
    is_owner: isOwner,
    assigned_to_me: mine,
    needs_claim: false,
    reply_deadline_at: t.response_due_at,
    idle_kick_at,
    staff_chars_in_thread,
    reply_deadline_minutes: REPLY_DEADLINE_MIN,
    idle_kick_minutes: IDLE_KICK_MIN,
    reclaim_minutes: RECLAIM_MIN,
    min_reply_chars,
    reply_max_chars,
  };
}

export async function tryClaimThread(db, operator, threadId) {
  await sweepAssignments(db);
  if (operator.role === "owner") {
    await db
      .prepare(
        `UPDATE threads SET
         assigned_operator_id = ?,
         response_due_at = NULL,
         last_staff_activity_at = ?,
         reclaim_operator_id = NULL,
         reclaim_until = NULL,
         resume_operator_id = NULL,
         resume_until = NULL
       WHERE id = ?`
      )
      .run(operator.id, dtNow(), threadId);
    return { ok: true };
  }

  const t = await db
    .prepare(
      `SELECT assigned_operator_id, reclaim_operator_id, reclaim_until FROM threads WHERE id = ?`
    )
    .get(threadId);
  if (!t) return { ok: false, error: "Nie znaleziono wątku." };
  if (t.assigned_operator_id) return { ok: false, error: "Wątek jest już przypisany." };

  const reclaimOk =
    t.reclaim_until &&
    t.reclaim_operator_id &&
    new Date() < new Date(t.reclaim_until) &&
    t.reclaim_operator_id === operator.id;

  if (t.reclaim_until && t.reclaim_operator_id && new Date() < new Date(t.reclaim_until)) {
    if (t.reclaim_operator_id !== operator.id) {
      return { ok: false, error: "Inny pracownik ma pierwszeństwo przejęcia (okno reclaim)." };
    }
  }

  if (!reclaimOk && !(await canStaffPickFromQueue(db, operator.id, threadId))) {
    return {
      ok: false,
      error: "Nie możesz przejąć tego wątku (poza widoczną pulą max 5).",
    };
  }

  if ((await countAssignedThreadsForOperator(db, operator.id)) >= 1) {
    return {
      ok: false,
      error: "Masz już otwartą rozmowę — dokończ ją lub wyślij odpowiedź, zanim przejmiesz kolejną.",
    };
  }

  const due = dtPlusMinutes(REPLY_DEADLINE_MIN);

  await db
    .prepare(
      `UPDATE threads SET
       assigned_operator_id = ?,
       response_due_at = ?,
       last_staff_activity_at = ?,
       reclaim_operator_id = NULL,
       reclaim_until = NULL,
       resume_operator_id = NULL,
       resume_until = NULL
     WHERE id = ?`
    )
    .run(operator.id, due, dtNow(), threadId);
  return { ok: true };
}

/** Przejęcie wątku „zatrzymanego” — po N h od ostatniej wiadomości pracownika, gdy klient nie odpisał. */
export async function tryClaimStoppedThread(db, operator, threadId) {
  await sweepAssignments(db);
  if (operator.role === "owner") {
    return tryClaimThread(db, operator, threadId);
  }
  const t = await db
    .prepare(
      `SELECT assigned_operator_id, reclaim_operator_id, reclaim_until FROM threads WHERE id = ?`
    )
    .get(threadId);
  if (!t) return { ok: false, error: "Nie znaleziono wątku." };
  if (t.assigned_operator_id) return { ok: false, error: "Wątek jest już przypisany." };
  if (!(await isStoppedReminderEligible(db, threadId))) {
    return {
      ok: false,
      error: `Przypomnienie możliwe dopiero po ${REMINDER_AFTER_STAFF_HOURS} h od ostatniej wiadomości zespołu, gdy klient jeszcze nie odpisał.`,
    };
  }
  const reclaimOk =
    t.reclaim_until &&
    t.reclaim_operator_id &&
    new Date() < new Date(t.reclaim_until) &&
    t.reclaim_operator_id === operator.id;
  if (t.reclaim_until && t.reclaim_operator_id && new Date() < new Date(t.reclaim_until)) {
    if (t.reclaim_operator_id !== operator.id) {
      return { ok: false, error: "Inny pracownik ma pierwszeństwo przejęcia (okno reclaim)." };
    }
  }
  if (!reclaimOk && (await countAssignedThreadsForOperator(db, operator.id)) >= 1) {
    return {
      ok: false,
      error: "Masz już otwartą rozmowę — dokończ ją lub wyślij odpowiedź, zanim przejmiesz kolejną.",
    };
  }
  const due = dtPlusMinutes(REPLY_DEADLINE_MIN);
  await db
    .prepare(
      `UPDATE threads SET
       assigned_operator_id = ?,
       response_due_at = ?,
       last_staff_activity_at = ?,
       reclaim_operator_id = NULL,
       reclaim_until = NULL,
       resume_operator_id = NULL,
       resume_until = NULL
     WHERE id = ?`
    )
    .run(operator.id, due, dtNow(), threadId);
  return { ok: true };
}
