// Due rules for parts, reminders and documents. Used by the API and the daily check. Texts follow the chosen language.
import { t } from "../public/i18n.js";

const MONTH_WARN_DAYS = 30; // months-based items warn this many days ahead
const ORDER = ["overdue", "soon", "ok", "unknown"];

export function dayDiff(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}

export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

const isNum = (x) => x !== "" && x != null && Number.isFinite(Number(x));

function worst(list) {
  let best = "unknown";
  for (const s of list) if (ORDER.indexOf(s) < ORDER.indexOf(best)) best = s;
  return best;
}

// Latest entry by date (then by km).
function latestOf(list) {
  let best = null;
  for (const x of list) {
    if (!x.date) continue;
    if (!best || x.date > best.date || (x.date === best.date && Number(x.km) > Number(best.km))) best = x;
  }
  return best;
}

export function currentKm(v) {
  let km = Number(v.odometer) || 0;
  for (const s of v.services || []) km = Math.max(km, Number(s.km) || 0);
  for (const f of v.fuel || []) km = Math.max(km, Number(f.km) || 0);
  for (const p of v.parts || []) for (const h of p.history || []) km = Math.max(km, Number(h.km) || 0);
  return km;
}

// Where a reminder's "last done" comes from: a linked part, a linked service type, or its own dates.
function lastForReminder(r, v) {
  const link = r.link || "";
  if (link.startsWith("part:")) {
    const p = (v.parts || []).find((x) => x.id === link.slice(5));
    return p ? latestOf(p.history || []) : null;
  }
  if (link.startsWith("service:")) {
    const kind = link.slice(8);
    return latestOf((v.services || []).filter((s) => s.type === kind));
  }
  return r.lastDate ? { date: r.lastDate, km: r.lastKm } : null;
}

// Due status from a lifespan (km and/or months) counted from the last entry.
function evalDue(lifeKm, lifeMonths, last, v, km, today, lang) {
  const found = [];
  if (last && isNum(lifeKm) && isNum(last.km)) {
    const remaining = Number(last.km) + Number(lifeKm) - km;
    const warn = Number(v.kmWarn) || 500;
    found.push({
      status: remaining <= 0 ? "overdue" : remaining <= warn ? "soon" : "ok",
      text: remaining < 0 ? t(lang, "km_overdue", { n: -remaining })
        : remaining === 0 ? t(lang, "km_now")
        : t(lang, "km_due", { n: remaining }),
    });
  }
  if (last && last.date && isNum(lifeMonths)) {
    const due = addMonths(last.date, Number(lifeMonths));
    const days = dayDiff(today, due);
    found.push({
      status: days <= 0 ? "overdue" : days <= MONTH_WARN_DAYS ? "soon" : "ok",
      text: days < 0 ? t(lang, "months_overdue", { n: -days })
        : days === 0 ? t(lang, "months_today")
        : t(lang, "months_due", { n: days, date: due }),
    });
  }
  if (!found.length) return { status: "unknown", text: t(lang, "no_record") };
  return { status: worst(found.map((f) => f.status)), text: found.map((f) => f.text).join(" · ") };
}

function evalDocument(d, today, lang) {
  if (!d.expires) return { id: d.id, type: d.type, status: "unknown", text: t(lang, "doc_none") };
  const days = dayDiff(today, d.expires);
  const status = days < 0 ? "overdue" : days <= MONTH_WARN_DAYS ? "soon" : "ok";
  const text = days < 0 ? t(lang, "doc_expired", { n: -days })
    : days === 0 ? t(lang, "doc_today")
    : t(lang, "doc_expires", { n: days, date: d.expires });
  return { id: d.id, type: d.type, status, text };
}

// For each document type, only the document with the latest expiry date counts.
function latestIds(docs) {
  const best = {};
  for (const d of docs) {
    if (!d.expires) continue;
    if (!best[d.type] || d.expires > best[d.type].expires) best[d.type] = d;
  }
  return new Set(Object.values(best).map((d) => d.id));
}

export function evaluate(v, today, lang = "en") {
  const km = currentKm(v);
  const latest = latestIds(v.documents || []);
  return {
    currentKm: km,
    parts: (v.parts || []).map((p) => {
      const d = evalDue(p.lifeKm, p.lifeMonths, latestOf(p.history || []), v, km, today, lang);
      return { id: p.id, name: p.name, status: d.status, text: d.text, priority: !!p.priority };
    }),
    reminders: (v.reminders || []).map((r) => {
      const d = evalDue(
        r.mode === "km" ? r.intervalKm : null,
        r.mode === "months" ? r.intervalMonths : null,
        lastForReminder(r, v), v, km, today, lang
      );
      return { id: r.id, name: r.name, status: d.status, text: d.text };
    }),
    documents: (v.documents || []).map((d) => ({ ...evalDocument(d, today, lang), latest: latest.has(d.id) })),
  };
}

export function computeStatuses(vehicles, today, lang = "en") {
  const out = {};
  for (const v of vehicles) out[v.id] = evaluate(v, today, lang);
  return out;
}

// Items due soon or overdue, overdue first.
export function dueItems(vehicles, today, lang = "en") {
  const items = [];
  const urgent = (s) => s === "overdue" || s === "soon";
  for (const v of vehicles) {
    const ev = evaluate(v, today, lang);
    for (const p of ev.parts) {
      if (urgent(p.status)) items.push({ status: p.status, text: `${v.name}: ${p.name}. ${p.text}` });
    }
    for (const r of ev.reminders) {
      if (urgent(r.status)) items.push({ status: r.status, text: `${v.name}: ${r.name}. ${r.text}` });
    }
    for (const d of ev.documents) {
      if (d.latest && urgent(d.status)) {
        items.push({ status: d.status, text: `${v.name}: ${t(lang, "doc_" + d.type.toLowerCase())}. ${d.text}` });
      }
    }
  }
  items.sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));
  return items;
}

// Title and body for the daily notification.
export function notificationSummary(vehicles, today, lang = "en") {
  const items = dueItems(vehicles, today, lang);
  const n = items.length;
  const title = n === 0 ? t(lang, "notif_title_none")
    : n === 1 ? t(lang, "notif_title_one")
    : t(lang, "notif_title_many", { n });
  const body = n === 0 ? t(lang, "notif_body_none") : items.slice(0, 5).map((i) => i.text).join("\n");
  return { title, body, items };
}
