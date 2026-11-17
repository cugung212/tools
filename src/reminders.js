// Reminder rules for vehicles. Used by the API and by the daily check. Texts follow the chosen language.
import { t } from "../public/i18n.js";

const MONTH_WARN_DAYS = 30; // months-based reminders and documents warn this many days ahead

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

export function currentKm(v) {
  let km = Number(v.odometer) || 0;
  for (const s of v.services || []) km = Math.max(km, Number(s.km) || 0);
  for (const f of v.fuel || []) km = Math.max(km, Number(f.km) || 0);
  return km;
}

function evalReminder(r, v, km, today, lang) {
  const unknown = { id: r.id, name: r.name, status: "unknown", text: t(lang, "no_record") };
  if (r.mode === "km") {
    if (!isNum(r.lastKm) || !isNum(r.intervalKm)) return unknown;
    const remaining = Number(r.lastKm) + Number(r.intervalKm) - km;
    const warn = Number(v.kmWarn) || 500;
    const status = remaining <= 0 ? "overdue" : remaining <= warn ? "soon" : "ok";
    const text = remaining < 0 ? t(lang, "km_overdue", { n: -remaining })
      : remaining === 0 ? t(lang, "km_now")
      : t(lang, "km_due", { n: remaining });
    return { id: r.id, name: r.name, status, text };
  }
  if (!r.lastDate || !isNum(r.intervalMonths)) return unknown;
  const due = addMonths(r.lastDate, Number(r.intervalMonths));
  const days = dayDiff(today, due);
  const status = days <= 0 ? "overdue" : days <= MONTH_WARN_DAYS ? "soon" : "ok";
  const text = days < 0 ? t(lang, "months_overdue", { n: -days })
    : days === 0 ? t(lang, "months_today")
    : t(lang, "months_due", { n: days, date: due });
  return { id: r.id, name: r.name, status, text };
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

// For each document type, only the document with the latest expiry date counts for reminders.
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
    reminders: (v.reminders || []).map((r) => evalReminder(r, v, km, today, lang)),
    documents: (v.documents || []).map((d) => ({ ...evalDocument(d, today, lang), latest: latest.has(d.id) })),
  };
}

export function computeStatuses(vehicles, today, lang = "en") {
  const out = {};
  for (const v of vehicles) out[v.id] = evaluate(v, today, lang);
  return out;
}

// Items that are due soon or overdue, overdue first.
export function dueItems(vehicles, today, lang = "en") {
  const items = [];
  for (const v of vehicles) {
    const ev = evaluate(v, today, lang);
    for (const r of ev.reminders) {
      if (r.status === "overdue" || r.status === "soon") items.push({ status: r.status, text: `${v.name}: ${r.name}. ${r.text}` });
    }
    for (const d of ev.documents) {
      if (d.latest && (d.status === "overdue" || d.status === "soon")) {
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
