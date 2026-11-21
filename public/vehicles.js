/* Vehicles tab: garage, parts (brands and models), services, reminders, fuel, expenses, documents,
   report, settings and notifications. English and Vietnamese. */
import { t, LANGS } from "/i18n.js";

const KEY = "vehicles-v1";
const LANG_KEY = "vehicles-lang";
const DOC_TYPES = ["Registration", "Inspection", "Insurance"];
const EXP_CATS = ["Insurance", "Parking", "Washing", "Repair", "Other"];
const FUEL_TYPES = ["E10", "E5", "RON 92", "RON 95", "Other"];
const ACTIONS = ["Replaced", "Serviced", "Repaired", "Cleaned", "Checked", "Adjusted"];

const root = document.getElementById("vehicles-root");
let lang = "en";
let vehicles = [];
let statuses = {};
let pushState = "checking"; // checking | unsupported | needs-home | denied | off | on
let reminderTime = "10:00";
let view = freshView("garage");
let note = "";
let chain = Promise.resolve();
let importText = "";
let importPreview = null;
let drag = null;
let searches = {};
let scrollMemory = {};
let lastNav = "";
let lastDepth = 0;

function freshView(name) {
  return {
    name, vehicleId: null, partId: null, tab: "parts", adding: false, editing: false, importing: false,
    odoEditing: false, odoDraft: null, odoFocusPending: false, detailsOpen: false, editingEntryId: null, brandForm: null, modelForm: null,
  };
}

const T = (key, params) => t(lang, key, params);
const locale = () => (lang === "vi" ? "vi-VN" : "en-US");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const toNum = (s) => {
  if (s === "" || s == null) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isNumC = (x) => x !== "" && x != null && Number.isFinite(Number(x));
const fmtNum = (n) => (Number(n) || 0).toLocaleString(locale());
const fmtKm = (n) => (n === "" || n == null ? "" : fmtNum(n) + " km");
const fmtMoney = (n) => fmtNum(n) + " " + T("vnd");
const opts = (list) => list.map((x) => (typeof x === "string" ? { value: x, label: x } : x));
const docLabel = (type) => T("doc_" + type.toLowerCase());
const catLabel = (c) => T("cat_" + c.toLowerCase());
const fuelLabel = (f) => (f === "Other" ? T("fuel_other") : f);
const statusLabel = (s) => T("status_" + s);
const actionLabel = (a) => (a ? T("action_" + a.toLowerCase()) : "");
const actionOptions = () => ACTIONS.map((a) => ({ value: a, label: actionLabel(a) }));
const lines = (s) => (s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const oneLine = (s) => lines(s).join(" ");
const flat = (s) => (s || "").replace(/\n+/g, " · ");

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function addMonthsClient(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

function currentKm(v) {
  let km = Number(v.odometer) || 0;
  for (const s of v.services) km = Math.max(km, Number(s.km) || 0);
  for (const f of v.fuel) km = Math.max(km, Number(f.km) || 0);
  for (const p of v.parts) for (const h of p.history) km = Math.max(km, Number(h.km) || 0);
  return km;
}

// Highest km in the records (the Current ODO cannot be lower than this)
function logKm(v) {
  let km = 0;
  for (const s of v.services) km = Math.max(km, Number(s.km) || 0);
  for (const f of v.fuel) km = Math.max(km, Number(f.km) || 0);
  for (const p of v.parts) for (const h of p.history) km = Math.max(km, Number(h.km) || 0);
  return km;
}

// Fills in fields that older saves do not have. Old parts become one brand with one model.
function migrate(v) {
  v.parts = v.parts || [];
  v.services = v.services || [];
  v.fuel = v.fuel || [];
  v.expenses = v.expenses || [];
  v.reminders = v.reminders || [];
  v.documents = v.documents || [];
  v.services.forEach((s) => { s.parts = s.parts || []; });
  v.reminders.forEach((r) => { r.link = r.link || ""; });
  let changed = false;
  v.parts.forEach((p, i) => {
    p.history = p.history || [];
    if (typeof p.order !== "number") p.order = i;
    if (!Array.isArray(p.brands)) {
      changed = true;
      const brandLines = lines(p.brand);
      const brand = { id: uid(), name: brandLines[0] || T("default_brand"), notes: brandLines.slice(1).join("\n"), models: [] };
      const hasLife = isNumC(p.lifeKm) || isNumC(p.lifeMonths) || !!p.lifeText;
      let model = null;
      if (hasLife) {
        model = {
          id: uid(), name: T("default_model"), notes: "",
          lifeKm: p.lifeKm ?? "", lifeMonths: p.lifeMonths ?? "", lifeText: p.lifeText || "",
        };
        brand.models.push(model);
      }
      p.brands = [brand];
      p.history.forEach((h) => {
        if (!h.brandId) {
          h.brandId = brand.id;
          h.modelId = model ? model.id : "";
        }
      });
    }
  });
  return changed;
}

// Starting data: the two vehicles. Reminder intervals are placeholders; check them against your manuals.
function seed() {
  const docs = () => DOC_TYPES.map((x) => ({ id: uid(), type: x, issued: "", expires: "", note: "" }));
  const rem = (name, mode, interval) => ({
    id: uid(), name, mode, link: "",
    intervalKm: mode === "km" ? interval : "",
    intervalMonths: mode === "months" ? interval : "",
    lastKm: "", lastDate: "",
  });
  return [
    {
      id: uid(), name: "Kia Cerato", type: "car", make: "Kia", model: "Cerato 2.0", year: 2017,
      plate: "", odometer: 0, kmWarn: 500, details: "", parts: [], services: [], fuel: [], expenses: [],
      reminders: [rem("Engine oil change", "km", 5000), rem("Brake fluid change", "months", 24)],
      documents: docs(),
    },
    {
      id: uid(), name: "Honda SH 150i", type: "scooter", make: "Honda", model: "SH 150i", year: 2014,
      plate: "", odometer: 0, kmWarn: 200, details: "", parts: [], services: [], fuel: [], expenses: [],
      reminders: [rem("Engine oil change", "km", 3000), rem("Brake fluid change", "months", 24)],
      documents: docs(),
    },
  ];
}

function readCache() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    return null;
  }
}
function cache() {
  try {
    localStorage.setItem(KEY, JSON.stringify(vehicles));
    localStorage.setItem(LANG_KEY, lang);
  } catch (e) {}
}

function updateTabLabel() {
  const tab = document.getElementById("tab-vehicles");
  if (tab) tab.textContent = T("tab");
}

async function refreshStatuses() {
  try {
    const res = await fetch("/api/vehicles/status", { cache: "no-store" });
    if (res.ok) statuses = (await res.json()).statuses || {};
  } catch (e) {}
  render();
}

// Saves are queued one at a time; each sends the latest list, language and reminder time.
// Undo and redo for all Vehicles data. Each saved change keeps the state before it.
const HISTORY_LIMIT = 50;
let undoStack = [];
let redoStack = [];
let baseline = ""; // the saved state the next change is compared with

const snapshot = () => JSON.stringify(vehicles);

function recordHistory() {
  const now = snapshot();
  if (baseline && now !== baseline) {
    undoStack.push(baseline);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }
  baseline = now;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restoreState(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restoreState(redoStack.pop());
}

function restoreState(json) {
  vehicles = JSON.parse(json);
  baseline = json;
  note = "";
  view.odoEditing = false;
  view.odoDraft = null;
  view.adding = false;
  view.importing = false;
  view.editing = false;
  view.editingEntryId = null;
  view.brandForm = null;
  view.modelForm = null;
  cache();
  render();
  persist();
}

function arrowIcon(redoArrow) {
  const span = document.createElement("span");
  const d = redoArrow
    ? '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'
    : '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>';
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  return span;
}

// Small undo and redo buttons shown on the title line of each Vehicles screen
function historyButtons() {
  return el("span", { class: "vhist" },
    el("button", {
      class: "vhistbtn", type: "button", "aria-label": T("undo"), title: T("undo"),
      disabled: undoStack.length === 0, onclick: undo,
    }, arrowIcon(false)),
    el("button", {
      class: "vhistbtn", type: "button", "aria-label": T("redo"), title: T("redo"),
      disabled: redoStack.length === 0, onclick: redo,
    }, arrowIcon(true)));
}

function persist() {
  recordHistory();
  cache();
  chain = chain
    .then(() => fetch("/api/vehicles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicles, lang, reminderTime }),
    }))
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      note = "";
      updateTabLabel();
      return refreshStatuses();
    })
    .catch(() => {
      note = T("saved_locally");
      render();
    });
  return chain;
}

async function load() {
  lang = localStorage.getItem(LANG_KEY) || "en";
  let migrated = false;
  try {
    const res = await fetch("/api/vehicles", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (LANGS.includes(data.lang)) lang = data.lang;
    if (typeof data.reminderTime === "string") reminderTime = data.reminderTime;
    if ((data.vehicles || []).length) {
      vehicles = data.vehicles;
    } else {
      vehicles = readCache() || seed();
      migrated = vehicles.map((v) => migrate(v)).some(Boolean);
      baseline = snapshot();
      cache();
      await persist();
      return;
    }
  } catch (e) {
    vehicles = readCache() || seed();
    note = T("showing_copy");
  }
  migrated = vehicles.map((v) => migrate(v)).some(Boolean) || migrated;
  baseline = snapshot();
  cache();
  updateTabLabel();
  if (migrated) persist();
  refreshStatuses();
}

function setLanguage(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  note = "";
  cache();
  updateTabLabel();
  render();
  persist();
}

const statusOf = (v) => statuses[v.id] || { parts: [], reminders: [], documents: [] };
const URGENT = (s) => s === "overdue" || s === "soon";

function worstStatus(list) {
  const order = ["overdue", "soon", "ok", "unknown"];
  let best = "unknown";
  for (const s of list) if (order.indexOf(s) < order.indexOf(best)) best = s;
  return best;
}
function vehicleStatus(v) {
  const ev = statusOf(v);
  return worstStatus([
    ...ev.parts.map((p) => p.status),
    ...ev.reminders.map((r) => r.status),
    ...ev.documents.filter((d) => d.latest).map((d) => d.status),
  ]);
}
function chip(status, label) {
  return el("span", { class: "vchip vchip-" + status }, label || statusLabel(status));
}

// ---- Notifications ----

const base64ToBytes = (s) => {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

async function detectPush() {
  const standalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !standalone) {
    pushState = "needs-home";
  } else if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    pushState = "unsupported";
  } else if (Notification.permission === "denied") {
    pushState = "denied";
  } else {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    pushState = sub && Notification.permission === "granted" ? "on" : "off";
  }
  render();
}

function enablePush() {
  // Permission is requested straight from the tap, which iPhone requires
  Notification.requestPermission()
    .then(async (perm) => {
      if (perm !== "granted") {
        pushState = "denied";
        return render();
      }
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;
      const key = (await (await fetch("/api/push/key", { cache: "no-store" })).json()).key;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(key),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error("subscribe failed");
      pushState = "on";
      render();
    })
    .catch(() => {
      note = T("enable_failed");
      render();
    });
}

function pushCard() {
  const children = [
    el("h2", {}, T("notifications")),
    el("p", { class: "vmuted" }, T("push_" + pushState, { time: reminderTime })),
  ];
  if (pushState === "off") {
    children.push(el("button", { class: "primary", type: "button", onclick: enablePush }, T("turn_on")));
  }
  const time = el("input", { class: "vinput", type: "time", "aria-label": T("reminder_time") });
  time.value = reminderTime;
  time.addEventListener("change", () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) return;
    reminderTime = time.value;
    render();
    persist();
  });
  children.push(
    el("label", { class: "vfield" }, el("span", {}, T("reminder_time")), time),
    el("p", { class: "vmuted" }, T("reminder_time_hint")));
  return el("div", { class: "vcard" }, children);
}

// ---- Forms and lists ----

// A form field can fill itself from other fields (derive) until the user types in it.
// A select can refill its options when another select changes (optionsFrom).
function form(fields, submitText, onSubmit, onCancel) {
  const inputs = {};
  const rows = fields.map((f) => {
    if (f.checks) {
      const boxes = f.checks.map((c) => el("label", { class: "vcheck" },
        el("input", { type: "checkbox", value: c.value }), el("span", {}, c.label)));
      inputs[f.name] = {
        get value() {
          return boxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.value).join("|");
        },
      };
      return el("div", { class: "vfield" }, el("span", {}, f.label),
        boxes.length ? boxes : el("span", { class: "vmuted" }, T("no_parts_yet")));
    }
    const input = f.options
      ? el("select", { class: "vinput" }, opts(f.options).map((o) => el("option", { value: o.value }, o.label)))
      : f.multiline
        ? el("textarea", { class: "vinput vmulti", rows: 3, placeholder: f.placeholder, "aria-label": f.label })
        : el("input", { class: "vinput", type: f.type || "text", inputmode: f.inputmode, placeholder: f.placeholder });
    if (f.value != null) input.value = f.value;
    inputs[f.name] = input;
    return el("label", { class: "vfield" }, el("span", {}, f.label), input);
  });
  const valuesOf = () => {
    const out = {};
    for (const k of Object.keys(inputs)) out[k] = inputs[k].value;
    return out;
  };
  fields.forEach((f) => {
    const target = inputs[f.name];
    if (f.derive) {
      target.addEventListener("input", () => { target.dataset.touched = "1"; });
      const recalc = () => { if (!target.dataset.touched) target.value = f.derive.fn(valuesOf()); };
      f.derive.from.forEach((src) => {
        inputs[src].addEventListener("input", recalc);
        inputs[src].addEventListener("change", recalc);
      });
    }
    if (f.optionsFrom) {
      const src = inputs[f.optionsFrom.from];
      src.addEventListener("change", () => {
        const list = opts(f.optionsFrom.build(src.value));
        target.replaceChildren(...list.map((o) => el("option", { value: o.value }, o.label)));
        target.value = list.length ? list[0].value : "";
        target.dispatchEvent(new Event("change"));
      });
    }
  });
  const buttons = [el("button", { class: "primary", type: "submit" }, submitText)];
  if (onCancel) buttons.push(el("button", { type: "button", onclick: onCancel }, T("cancel")));
  return el("form", {
    class: "vform",
    autocomplete: "off",
    onsubmit: (e) => {
      e.preventDefault();
      const vals = {};
      for (const k of Object.keys(inputs)) vals[k] = inputs[k].value.trim();
      note = onSubmit(vals) || "";
      render();
    },
  }, rows, onCancel ? el("div", { class: "vformbar" }, buttons) : buttons);
}

function addBlock(label, fields, submitText, handler) {
  if (!view.adding) {
    return el("button", {
      class: "vadd", type: "button",
      onclick: () => { view.adding = true; note = ""; render(); },
    }, "+ " + label);
  }
  return form(fields, submitText, (vals) => {
    const err = handler(vals);
    if (!err) view.adding = false;
    return err;
  });
}

function item(title, status, lines2, actions) {
  return el("div", { class: "vitem" },
    el("div", { class: "vrow" }, el("strong", {}, title), status || null),
    lines2.filter(Boolean).map((l) => el("div", { class: "vmuted" }, l)),
    el("div", { class: "vactions" }, actions || []));
}

const delBtn = (onDelete) => el("button", { class: "vdel", type: "button", onclick: onDelete }, T("delete"));

// ---- Brands, models and next due ----

const brandById = (p, id) => (p.brands || []).find((b) => b.id === id) || null;
const modelById = (p, id) => {
  for (const b of p.brands || []) {
    const m = (b.models || []).find((x) => x.id === id);
    if (m) return m;
  }
  return null;
};

// Next due km and date, from the chosen model's lifespan counted from the entry
function nextKmFor(model, km) {
  const k = toNum(km);
  return k != null && model && isNumC(model.lifeKm) ? k + Number(model.lifeKm) : "";
}
function nextDateFor(model, date) {
  return date && model && isNumC(model.lifeMonths) ? addMonthsClient(date, Number(model.lifeMonths)) : "";
}

function lifeSummary(m) {
  return [
    m.lifeKm !== "" && m.lifeKm != null ? T("every_km", { n: fmtNum(m.lifeKm) }) : "",
    m.lifeMonths !== "" && m.lifeMonths != null ? T("every_months", { n: m.lifeMonths }) : "",
    m.lifeText,
  ].filter(Boolean).join(" · ");
}

function brandOptions(p) {
  return p.brands.length
    ? p.brands.map((b) => ({ value: b.id, label: b.name }))
    : [{ value: "", label: T("no_brands") }];
}
function modelOptions(p, brandId) {
  const b = brandById(p, brandId);
  const models = b ? b.models : [];
  return models.length
    ? models.map((m) => ({ value: m.id, label: m.name + (lifeSummary(m) ? " · " + lifeSummary(m) : "") }))
    : [{ value: "", label: T("no_models") }];
}

// Keeps a brand and model that exist; otherwise picks the first brand and its first model
function pickIds(p, brandId, modelId) {
  const b = brandById(p, brandId) || p.brands[0] || null;
  if (!b) return { brandId: "", modelId: "" };
  const m = (b.models || []).find((x) => x.id === modelId) || (b.models || [])[0] || null;
  return { brandId: b.id, modelId: m ? m.id : "" };
}

function lastEntry(p) {
  let best = null;
  for (const h of p.history) {
    if (!best || h.date > best.date || (h.date === best.date && Number(h.km) > Number(best.km))) best = h;
  }
  return best;
}

// The brand and model used last time, or the first ones
function defaultPick(p) {
  const last = lastEntry(p);
  return last ? pickIds(p, last.brandId, last.modelId) : pickIds(p, "", "");
}

function findBM(p, h) {
  const model = modelById(p, h.modelId);
  const brand = model ? (p.brands || []).find((b) => (b.models || []).includes(model)) : brandById(p, h.brandId);
  return { brand: brand || null, model: model || null };
}

function partText(p) {
  return [
    p.name, p.description, p.oem, actionLabel(p.defaultAction),
    p.brands.map((b) => b.name + " " + b.models.map((m) => m.name).join(" ")).join(" "),
  ].join(" ");
}

// ---- Scopes: tell the drag code how to read and save each ordered list ----

const vehicleScope = () => ({ list: () => vehicles, id: (x) => x.id, commit: (arr) => { vehicles = arr; } });
const partScope = (v) => ({
  list: () => partsSorted(v),
  id: (x) => x.id,
  group: (x) => (x.priority ? 1 : 0),
  commit: (arr) => { arr.forEach((p, i) => { p.order = i; }); },
});
const brandScope = (p) => ({ list: () => p.brands, id: (x) => x.id, commit: (arr) => { p.brands = arr; } });
const modelScope = (b) => ({ list: () => b.models, id: (x) => x.id, commit: (arr) => { b.models = arr; } });
const reminderScope = (v) => ({ list: () => v.reminders, id: (x) => x.id, commit: (arr) => { v.reminders = arr; } });
const documentScope = (v) => ({ list: () => v.documents, id: (x) => x.id, commit: (arr) => { v.documents = arr; } });

// ---- Garage ----

function vehicleFields(v) {
  return [
    { name: "type", label: T("f_type"), options: [{ value: "car", label: T("type_car") }, { value: "scooter", label: T("type_scooter") }], value: v ? v.type : "car" },
    { name: "name", label: T("f_name"), placeholder: T("ph_vehicle_name"), value: v ? v.name : "" },
    { name: "make", label: T("f_make"), value: v ? v.make : "" },
    { name: "model", label: T("f_model"), value: v ? v.model : "" },
    { name: "year", label: T("f_year"), type: "number", inputmode: "numeric", value: v ? v.year : "" },
    { name: "plate", label: T("f_plate"), value: v ? v.plate : "" },
    { name: "odometer", label: T("f_odometer"), type: "number", inputmode: "numeric", value: v ? v.odometer : "" },
    { name: "kmWarn", label: T("f_warn"), type: "number", inputmode: "numeric", value: v ? v.kmWarn : 500 },
  ];
}

function addVehicle(vals) {
  if (!vals.name) return T("err_name_vehicle");
  vehicles.push({
    id: uid(), name: vals.name, type: vals.type || "car", make: vals.make, model: vals.model,
    year: toNum(vals.year) ?? "", plate: vals.plate, details: "",
    odometer: toNum(vals.odometer) ?? 0, kmWarn: toNum(vals.kmWarn) ?? 500,
    parts: [], services: [], fuel: [], expenses: [], reminders: [],
    documents: DOC_TYPES.map((x) => ({ id: uid(), type: x, issued: "", expires: "", note: "" })),
  });
  persist();
  return "";
}

function languageSwitch() {
  return el("div", { class: "vlang", role: "group", "aria-label": T("lang_label") },
    LANGS.map((l) => el("button", {
      type: "button", class: "vtab", "aria-pressed": String(lang === l),
      onclick: () => setLanguage(l),
    }, t(l, "lang_name"))),
    el("button", { type: "button", class: "vtab", "aria-label": T("settings"), onclick: openSettings }, "⚙ " + T("settings")));
}

function reportIcon() {
  const span = document.createElement("span");
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>';
  return span;
}

const vehicleText = (v) => [v.name, v.make, v.model, v.plate, v.year].join(" ");

function vehicleCard(v) {
  return el("button", { class: "vcard vcar", type: "button", onclick: () => goDetail(v.id, "parts") },
    el("div", { class: "vrow" }, el("strong", {}, v.name), chip(vehicleStatus(v))),
    el("div", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ")),
    el("div", { class: "vmuted" }, fmtKm(currentKm(v))));
}

function garageView() {
  return el("div", {},
    el("div", { class: "vtitlerow" }, el("h1", {}, T("vehicles_title")), historyButtons()),
    el("div", { class: "vrow vsubrow" },
      el("p", { class: "vsub" }, vehicles.length === 1 ? T("vehicle_one") : T("vehicles_many", { n: vehicles.length })),
      languageSwitch()),
    note ? el("p", { class: "vnote" }, note) : null,
    el("div", { class: "vreport-row" },
      el("button", { class: "vreport", type: "button", onclick: openReport }, reportIcon(), T("report_open"))),
    vehicles.length > 1 ? el("p", { class: "vmuted" }, T("reorder_hint_list")) : null,
    searchable("garage", vehicles, vehicleText,
      (shown, unfiltered) => shown.map((v) => reorderRow(vehicleScope(), v.id, vehicleCard(v), unfiltered)),
      { tag: "ul", cls: "vlist vgarage", emptyKey: "nothing_here" }),
    addBlock(T("add_vehicle"), vehicleFields(null), T("save_vehicle"), addVehicle));
}

// ---- Navigation and scroll memory ----

function viewKey(vw) {
  return [vw.name, vw.vehicleId || "", vw.partId || "", vw.tab || ""].join("|");
}

// Moves to another screen. The screen being left keeps its scroll position, and the
// screen being opened returns to where it was left (or to the top the first time).
function go(next) {
  scrollMemory[viewKey(view)] = window.scrollY;
  view = next;
  note = "";
  render();
  window.scrollTo(0, scrollMemory[viewKey(view)] || 0);
}

function goGarage() { go(freshView("garage")); }
function goDetail(id, tab) { go({ ...freshView("detail"), vehicleId: id, tab: tab || "parts" }); }
function openPart(id) { go({ ...view, name: "part", partId: id, adding: false, editing: false, importing: false, odoEditing: false, brandForm: null, modelForm: null }); }
function openReport() { go(freshView("report")); }
function openSettings() { go(freshView("settings")); }
function currentVehicle() { return vehicles.find((x) => x.id === view.vehicleId); }

// ---- Current ODO ----

// Current ODO: tap the number to type a new reading. Enter or leaving the field saves it.
let odoBusy = false;

function toggleOdoEdit(v) {
  view.odoEditing = true;
  view.odoDraft = null;
  view.odoFocusPending = true;
  note = "";
  render();
}

function cancelOdo() {
  view.odoEditing = false;
  view.odoDraft = null;
  view.odoFocusPending = false;
  note = "";
  render();
}

function commitOdo(v, raw) {
  if (odoBusy) return;
  odoBusy = true;
  try {
    if (String(raw).trim() === "") return cancelOdo();
    const km = toNum(raw);
    if (km == null) {
      view.odoDraft = raw;
      view.odoFocusPending = true;
      note = T("err_odo");
      return render();
    }
    const floor = logKm(v);
    if (km < floor) {
      view.odoDraft = raw;
      view.odoFocusPending = true;
      note = T("odo_too_low", { n: fmtNum(floor) });
      return render();
    }
    view.odoEditing = false;
    view.odoDraft = null;
    view.odoFocusPending = false;
    note = "";
    v.odometer = km;
    render();
    persist();
  } finally {
    odoBusy = false;
  }
}

function odoValue(v) {
  if (view.odoEditing) {
    let handled = false;
    const input = el("input", {
      class: "vinput vodo-input", type: "number", inputmode: "numeric", "aria-label": T("odo_current"),
      oninput: (e) => { view.odoDraft = e.target.value; },
      onkeydown: (e) => {
        if (e.key === "Enter") { e.preventDefault(); handled = true; commitOdo(v, e.target.value); }
        else if (e.key === "Escape") { handled = true; cancelOdo(); }
      },
      onblur: (e) => { if (!handled && view.odoEditing) commitOdo(v, e.target.value); },
    });
    input.value = view.odoDraft != null ? view.odoDraft : String(currentKm(v));
    return el("span", { class: "vodo-wrap" }, el("span", { class: "vodo-label" }, T("odo_label")), input);
  }
  return el("span", { class: "vodo-wrap" },
    el("span", { class: "vodo-label" }, T("odo_label")),
    el("button", {
      class: "vodo-value", type: "button", "aria-label": T("odo_update"),
      onclick: () => toggleOdoEdit(v),
    }, fmtKm(currentKm(v))));
}



// ---- Details and references (multi-line, links are tappable) ----

function linkify(text) {
  const out = [];
  const re = /https?:\/\/[^\s]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}



// ---- Vehicle screen ----

function detailView(v) {
  const tabs = ["parts", "services", "reminders", "fuel", "expenses", "documents"];
  const meta = [v.year, v.plate].filter(Boolean).join(" · ");
  return el("div", {},
    el("div", { class: "vbar" },
      el("div", { class: "vbar-left" },
        el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
        chip(vehicleStatus(v)),
        odoValue(v)),
      el("button", {
        class: "vdetailsbtn", type: "button", "aria-pressed": String(!!view.detailsOpen),
        onclick: () => { view.detailsOpen = !view.detailsOpen; note = ""; render(); },
      }, T("details_btn"))),
    el("div", { class: "vtitlerow" },
      el("h1", {}, v.name),
      meta ? el("span", { class: "vmeta" }, meta) : null,
      historyButtons()),
    note ? el("p", { class: "vnote" }, note) : null,
    vehicleDetailsBlock(v),
    el("div", { class: "vtabs" }, tabs.map((key) => el("button", {
      type: "button", class: "vtab", "aria-pressed": String(view.tab === key),
      onclick: () => { view.tab = key; view.adding = false; view.importing = false; note = ""; render(); },
    }, T("tab_" + key)))),
    tabBody(v));
}

function tabBody(v) {
  if (view.tab === "services") return visitsTab(v);
  if (view.tab === "reminders") return remindersTab(v);
  if (view.tab === "fuel") return fuelTab(v);
  if (view.tab === "expenses") return expensesTab(v);
  if (view.tab === "documents") return documentsTab(v);
  return partsTab(v);
}

// ---- Reorder: drag handle and drag logic (works for every reorderable list) ----

function dragHandle(scope, id) {
  return el("span", {
    class: "handle", title: T("reorder_hint"), "aria-label": T("reorder_hint"),
    onpointerdown: (e) => startDrag(e, scope, id),
    onpointermove: moveDrag,
    onpointerup: (e) => endDrag(e, true),
    onpointercancel: (e) => endDrag(e, false),
  }, "⠿");
}

function reorderRow(scope, id, content, canDrag) {
  return el("li", { class: "vreorder", "data-rid": id },
    canDrag ? dragHandle(scope, id) : null,
    el("div", { class: "vreorder-body" }, content));
}

function startDrag(e, scope, id) {
  const list = scope.list();
  const idx = list.findIndex((x) => scope.id(x) === id);
  if (idx < 0) return;
  const me = list[idx];
  const groupOf = scope.group || (() => 0);
  let lo = idx;
  let hi = idx;
  while (lo > 0 && groupOf(list[lo - 1]) === groupOf(me)) lo--;
  while (hi < list.length - 1 && groupOf(list[hi + 1]) === groupOf(me)) hi++;
  const groupIds = new Set(list.slice(lo, hi + 1).map((x) => scope.id(x)));
  const li = e.currentTarget.closest("li");
  const container = li.parentElement;
  const others = [...container.querySelectorAll(":scope > li[data-rid]")]
    .filter((r) => r !== li && groupIds.has(r.dataset.rid));
  const rect = li.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(container).rowGap) || 10;
  const grid = getComputedStyle(container).display === "grid";
  drag = {
    scope, id, li, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2,
    height: rect.height, step: rect.height + gap, grid,
    lo, f: idx - lo, others,
    pos: others.map((r) => { const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }),
    k: null, list,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
  if (!grid) others.forEach((r) => r.classList.add("shift"));
  e.preventDefault();
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  const x = drag.centerX + dx;
  const y = drag.centerY + dy;
  const h = drag.height / 2;
  let k = 0;
  if (drag.grid) {
    // Two columns: a row counts as before the dragged item if it is higher, or level and to the left
    drag.li.style.transform = `translate(${dx}px, ${dy}px)`;
    drag.pos.forEach((p) => {
      if (p.y < y - h || (Math.abs(p.y - y) <= h && p.x < x)) k++;
    });
  } else {
    drag.li.style.transform = `translateY(${dy}px)`;
    drag.pos.forEach((p) => { if (p.y < y) k++; });
    // Other rows slide one slot to open a gap where the dragged row will land
    drag.others.forEach((r, j) => {
      const newSlot = j < k ? j : j + 1;
      const oldSlot = j < drag.f ? j : j + 1;
      const shift = newSlot > oldSlot ? drag.step : newSlot < oldSlot ? -drag.step : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }
  drag.k = k;
}

function endDrag(e, apply) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  d.li.classList.remove("dragging");
  if (!apply || d.k === null || d.k === d.f) {
    resetDrag(d);
    return;
  }
  if (d.grid) {
    commitDrag(d);
    return;
  }
  d.li.classList.add("shift");
  d.li.style.transform = `translateY(${(d.k - d.f) * d.step}px)`;
  setTimeout(() => commitDrag(d), 200);
}

function resetDrag(d) {
  d.li.style.transform = "";
  d.li.classList.remove("shift");
  d.others.forEach((r) => {
    r.style.transform = "";
    r.classList.remove("shift");
  });
}

function commitDrag(d) {
  const moved = d.list.find((x) => d.scope.id(x) === d.id);
  const rest = d.list.filter((x) => d.scope.id(x) !== d.id);
  rest.splice(d.lo + d.k, 0, moved);
  d.scope.commit(rest);
  render();
  persist();
}

// ---- Parts ----

function partsSorted(v) {
  return [...v.parts].sort((a, b) => ((b.priority ? 1 : 0) - (a.priority ? 1 : 0)) || (a.order - b.order));
}

function partFields(p) {
  return [
    { name: "name", label: T("f_name"), placeholder: T("ph_part_name"), value: p ? p.name : "" },
    { name: "description", label: T("f_description"), multiline: true, value: p ? p.description : "" },
    { name: "oem", label: T("f_oem"), value: p ? p.oem : "" },
    { name: "defaultAction", label: T("f_default_action"), options: actionOptions(), value: p ? p.defaultAction : "Replaced" },
  ];
}

function addPart(v, vals) {
  if (!vals.name) return T("err_name_part");
  v.parts.push({
    id: uid(), name: vals.name, description: vals.description || "", oem: vals.oem || "",
    defaultAction: vals.defaultAction || "Replaced", priority: false, order: v.parts.length,
    history: [], brands: [],
  });
  persist();
  return "";
}

function updatePart(p, vals) {
  if (!vals.name) return T("err_name_part");
  Object.assign(p, {
    name: vals.name, description: vals.description || "", oem: vals.oem || "",
    defaultAction: vals.defaultAction || "Replaced",
  });
  view.editing = false;
  persist();
  return "";
}

// One tap: log this part as done today at the current mileage, with the brand and model used last time
function quickDone(v, p) {
  const date = todayVN();
  const km = currentKm(v);
  const pick = defaultPick(p);
  const model = modelById(p, pick.modelId);
  p.history.push({
    id: uid(), date, km, action: p.defaultAction || "Replaced", cost: "", shop: "", notes: "", visitId: "",
    brandId: pick.brandId, modelId: pick.modelId, nextKm: nextKmFor(model, km), nextDate: nextDateFor(model, date),
  });
  render();
  persist();
}

function starBtn(p) {
  return el("button", {
    class: "vstar", type: "button",
    "aria-pressed": String(!!p.priority),
    "aria-label": T(p.priority ? "prio_remove" : "prio_set"),
    title: T(p.priority ? "prio_remove" : "prio_set"),
    onclick: () => { p.priority = !p.priority; render(); persist(); },
  }, p.priority ? "★" : "☆");
}

function partRow(v, p, canDrag) {
  const st = statusOf(v).parts.find((x) => x.id === p.id) || { status: "unknown", text: T("no_record") };
  const last = lastEntry(p);
  const card = el("div", { class: "vpart" + (p.priority ? " priority" : "") },
    el("div", { class: "vrow" },
      el("span", { class: "vleft" },
        starBtn(p),
        el("button", { class: "vlink", type: "button", onclick: () => openPart(p.id) }, p.name)),
      chip(st.status)),
    last ? el("div", { class: "vmuted" }, T("last_done", { action: actionLabel(last.action), date: last.date, km: fmtKm(last.km) })) : null,
    st.status !== "unknown" ? el("div", { class: "vmuted" }, st.text) : null,
    el("div", { class: "vactions" },
      el("button", { type: "button", onclick: () => quickDone(v, p) }, T("done_today"))));
  return reorderRow(partScope(v), p.id, card, canDrag);
}

function partsTab(v) {
  if (view.importing) return importPanel(v);
  const list = partsSorted(v);
  const add = addBlock(T("add_part"), partFields(null), T("save_part"), (vals) => addPart(v, vals));
  const importBtn = view.adding ? null : el("button", {
    class: "vadd", type: "button",
    onclick: () => { view.importing = true; importPreview = null; importText = ""; note = ""; render(); },
  }, T("import_sheet"));
  return el("div", {},
    list.length ? null : el("p", { class: "vmuted" }, T("no_parts_yet")),
    list.length
      ? searchable(searchKey("parts"), list, partText,
          (shown, unfiltered) => shown.map((p) => partRow(v, p, unfiltered)),
          { tag: "ul", cls: "vlist", emptyKey: "nothing_here" })
      : null,
    importBtn,
    add);
}

function partDetailView(v, p) {
  const st = statusOf(v).parts.find((x) => x.id === p.id) || { status: "unknown", text: T("no_record") };
  const entries = [...p.history].sort((a, b) => (a.date < b.date ? 1 : -1));
  const priced = p.history
    .filter((h) => toNum(h.cost) != null)
    .sort((a, b) => toNum(a.cost) - toNum(b.cost));
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: () => goDetail(v.id, "parts") }, T("back_parts")),
    el("div", { class: "vtitlerow" }, el("h1", {}, p.name), historyButtons()),
    el("div", { class: "vrow vsubrow" }, el("span", { class: "vmuted" }, st.status !== "unknown" ? st.text : ""), chip(st.status)),
    note ? el("p", { class: "vnote" }, note) : null,
    el("div", { class: "vcard" },
      el("h2", {}, T("part_details")),
      [
        flat(p.description),
        p.oem ? T("f_oem") + ": " + p.oem : "",
        T("f_default_action") + ": " + actionLabel(p.defaultAction),
      ].filter(Boolean).map((l) => el("div", { class: "vmuted" }, l))),
    el("div", { class: "vactions" },
      el("button", { type: "button", onclick: () => { view.editing = !view.editing; note = ""; render(); } }, T("edit_part")),
      el("button", {
        class: "vdel", type: "button",
        onclick: () => {
          if (!confirm(T("delete_part_confirm", { name: p.name }))) return;
          v.parts = v.parts.filter((x) => x.id !== p.id);
          v.services.forEach((s) => { s.parts = (s.parts || []).filter((x) => x !== p.id); });
          goDetail(v.id, "parts");
          persist();
        },
      }, T("delete_part"))),
    view.editing ? form(partFields(p), T("save_part"), (vals) => updatePart(p, vals)) : null,
    brandsSection(p),
    el("h2", {}, T("part_history")),
    entries.length
      ? searchable(searchKey("history|" + p.id), entries, historyText,
          (shown) => shown.map((h) => historyItem(v, p, h)), { emptyKey: "part_no_history" })
      : el("p", { class: "vmuted" }, T("part_no_history")),
    priced.length
      ? el("div", {},
          el("h2", {}, T("part_prices")),
          priced.map((h) => {
            const bm = findBM(p, h);
            return item(
              fmtMoney(h.cost),
              null,
              [[bm.brand ? bm.brand.name : "", bm.model ? bm.model.name : "", h.shop].filter(Boolean).join(" · "), h.date],
              []);
          }))
      : null,
    addBlock(T("add_entry"), entryFields(v, p), T("save_entry"), (vals) => addEntry(v, p, vals)));
}

// ---- Brands and models inside a part ----

function brandsSection(p) {
  return el("div", {},
    el("h2", {}, T("brands_models")),
    p.brands.length
      ? el("div", {},
          el("p", { class: "vmuted" }, T("reorder_hint_list")),
          el("ul", { class: "vlist" }, p.brands.map((b) => brandRow(p, b, true))))
      : el("p", { class: "vmuted" }, T("no_brands")),
    brandAddArea(p));
}

function brandRow(p, b, canDrag) {
  const editing = view.brandForm && view.brandForm.mode === "edit" && view.brandForm.id === b.id;
  const content = el("div", { class: "vbrand" },
    el("div", { class: "vrow" },
      el("strong", {}, b.name),
      el("span", { class: "vactions" },
        el("button", { type: "button", onclick: () => { view.brandForm = { mode: "edit", id: b.id }; note = ""; render(); } }, T("edit_entry")),
        el("button", {
          class: "vdel", type: "button",
          onclick: () => {
            if (!confirm(T("delete_brand_confirm", { name: b.name }))) return;
            p.brands = p.brands.filter((x) => x.id !== b.id);
            render();
            persist();
          },
        }, T("delete")))),
    b.notes ? el("div", { class: "vmuted" }, flat(b.notes)) : null,
    editing ? brandEditForm(p, b) : null,
    b.models.length
      ? el("ul", { class: "vmodels" }, b.models.map((m) => modelRow(p, b, m)))
      : el("p", { class: "vmuted" }, T("no_models")),
    modelAddArea(p, b));
  return reorderRow(brandScope(p), b.id, content, canDrag);
}

function brandEditForm(p, b) {
  return form([
    { name: "name", label: T("f_brand_name"), value: b.name },
    { name: "notes", label: T("f_notes"), multiline: true, value: b.notes || "" },
  ], T("save_brand"), (vals) => {
    if (!vals.name) return T("err_name_brand");
    Object.assign(b, { name: vals.name, notes: vals.notes || "" });
    view.brandForm = null;
    persist();
    return "";
  });
}

function brandAddArea(p) {
  if (view.brandForm && view.brandForm.mode === "add") {
    return form([
      { name: "name", label: T("f_brand_name") },
      { name: "notes", label: T("f_notes"), multiline: true },
    ], T("save_brand"), (vals) => {
      if (!vals.name) return T("err_name_brand");
      p.brands.push({ id: uid(), name: vals.name, notes: vals.notes || "", models: [] });
      view.brandForm = null;
      persist();
      return "";
    });
  }
  return el("button", {
    class: "vadd", type: "button",
    onclick: () => { view.brandForm = { mode: "add" }; note = ""; render(); },
  }, "+ " + T("add_brand"));
}

function modelRow(p, b, m) {
  const editing = view.modelForm && view.modelForm.mode === "edit" && view.modelForm.id === m.id;
  const content = el("div", { class: "vmodel" },
    el("div", { class: "vrow" },
      el("strong", {}, m.name),
      el("span", { class: "vactions" },
        el("button", { type: "button", onclick: () => { view.modelForm = { mode: "edit", id: m.id, brandId: b.id }; note = ""; render(); } }, T("edit_entry")),
        el("button", {
          class: "vdel", type: "button",
          onclick: () => {
            if (!confirm(T("delete_model_confirm", { name: m.name }))) return;
            b.models = b.models.filter((x) => x.id !== m.id);
            render();
            persist();
          },
        }, T("delete")))),
    lifeSummary(m) ? el("div", { class: "vmuted" }, lifeSummary(m)) : null,
    m.notes ? el("div", { class: "vmuted" }, flat(m.notes)) : null,
    editing ? modelForm(p, b, m) : null);
  return reorderRow(modelScope(b), m.id, content, true);
}

// Adds a model when m is null, otherwise edits m
function modelForm(p, b, m) {
  return form([
    { name: "name", label: T("f_model_name"), value: m ? m.name : "" },
    { name: "lifeKm", label: T("f_life_km"), type: "number", inputmode: "numeric", value: m ? m.lifeKm : "" },
    { name: "lifeMonths", label: T("f_life_months"), type: "number", inputmode: "numeric", value: m ? m.lifeMonths : "" },
    { name: "lifeText", label: T("f_life_text"), value: m ? (m.lifeText || "") : "" },
    { name: "notes", label: T("f_notes"), multiline: true, value: m ? (m.notes || "") : "" },
  ], T(m ? "save_model" : "save_model"), (vals) => {
    if (!vals.name) return T("err_name_model");
    const data = {
      name: vals.name, lifeKm: toNum(vals.lifeKm) ?? "", lifeMonths: toNum(vals.lifeMonths) ?? "",
      lifeText: vals.lifeText || "", notes: vals.notes || "",
    };
    if (m) Object.assign(m, data);
    else b.models.push({ id: uid(), ...data });
    view.modelForm = null;
    persist();
    return "";
  });
}

function modelAddArea(p, b) {
  if (view.modelForm && view.modelForm.mode === "add" && view.modelForm.brandId === b.id) return modelForm(p, b, null);
  return el("button", {
    class: "vadd", type: "button",
    onclick: () => { view.modelForm = { mode: "add", brandId: b.id }; note = ""; render(); },
  }, "+ " + T("add_model"));
}

// ---- History entries (each one records the brand and model used, and its next due) ----

function entryFields(v, p, entry) {
  const auto = !entry;
  const km = entry ? entry.km : currentKm(v);
  const date = entry ? entry.date : todayVN();
  const pick = entry ? pickIds(p, entry.brandId, entry.modelId) : defaultPick(p);
  const model = modelById(p, pick.modelId);
  return [
    { name: "action", label: T("f_action"), options: actionOptions(), value: entry ? entry.action : (p.defaultAction || "Replaced") },
    { name: "date", label: T("f_date"), type: "date", value: date },
    { name: "km", label: T("f_km"), type: "number", inputmode: "numeric", value: km },
    { name: "brand", label: T("f_brand_pick"), options: brandOptions(p), value: pick.brandId },
    {
      name: "model", label: T("f_model_pick"), options: modelOptions(p, pick.brandId), value: pick.modelId,
      optionsFrom: { from: "brand", build: (bid) => modelOptions(p, bid) },
    },
    { name: "cost", label: T("f_cost"), type: "number", inputmode: "numeric", value: entry ? entry.cost : "" },
    { name: "shop", label: T("f_shop"), value: entry ? entry.shop : "" },
    { name: "notes", label: T("f_notes"), multiline: true, value: entry ? entry.notes : "" },
    {
      name: "nextKm", label: T("f_next_km"), type: "number", inputmode: "numeric",
      value: entry ? (entry.nextKm ?? "") : nextKmFor(model, km),
      derive: auto ? { from: ["km", "model"], fn: (vals) => nextKmFor(modelById(p, vals.model), vals.km) } : null,
    },
    {
      name: "nextDate", label: T("f_next_date"), type: "date",
      value: entry ? (entry.nextDate || "") : nextDateFor(model, date),
      derive: auto ? { from: ["date", "model"], fn: (vals) => nextDateFor(modelById(p, vals.model), vals.date) } : null,
    },
  ];
}

function addEntry(v, p, vals) {
  if (!vals.date) return T("err_entry");
  p.history.push({
    id: uid(), date: vals.date, km: toNum(vals.km) ?? "", action: vals.action || "Replaced",
    cost: toNum(vals.cost) ?? "", shop: vals.shop || "", notes: vals.notes || "", visitId: "",
    brandId: vals.brand || "", modelId: vals.model || "",
    nextKm: toNum(vals.nextKm) ?? "", nextDate: vals.nextDate || "",
  });
  persist();
  return "";
}

function updateEntry(p, h, vals) {
  if (!vals.date) return T("err_entry");
  Object.assign(h, {
    date: vals.date, km: toNum(vals.km) ?? "", action: vals.action || "Replaced",
    cost: toNum(vals.cost) ?? "", shop: vals.shop || "", notes: vals.notes || "",
    brandId: vals.brand || "", modelId: vals.model || "",
    nextKm: toNum(vals.nextKm) ?? "", nextDate: vals.nextDate || "",
  });
  view.editingEntryId = null;
  persist();
  return "";
}

const historyText = (h) => [h.date, actionLabel(h.action), h.shop, h.notes, h.km, h.cost].join(" ");

function historyItem(v, p, h) {
  if (view.editingEntryId === h.id) {
    return el("div", {},
      form(entryFields(v, p, h), T("save_entry"), (vals) => updateEntry(p, h, vals)),
      el("button", { class: "vback", type: "button", onclick: () => { view.editingEntryId = null; note = ""; render(); } }, T("cancel")));
  }
  const bm = findBM(p, h);
  const hasNext = (h.nextKm !== "" && h.nextKm != null) || !!h.nextDate;
  const nextText = hasNext
    ? T("next_line", {
        km: h.nextKm !== "" && h.nextKm != null ? fmtKm(h.nextKm) : T("dash"),
        date: h.nextDate || T("dash"),
      })
    : "";
  return item(
    actionLabel(h.action) + " · " + h.date,
    null,
    [
      [bm.brand ? bm.brand.name : "", bm.model ? bm.model.name : ""].filter(Boolean).join(" · "),
      fmtKm(h.km),
      h.cost !== "" && h.cost != null && toNum(h.cost) ? fmtMoney(h.cost) : "",
      h.shop,
      h.notes,
      nextText,
    ],
    [
      el("button", {
        type: "button",
        onclick: () => { view.editingEntryId = h.id; view.editing = false; note = ""; render(); },
      }, T("edit_entry")),
      delBtn(() => { p.history = p.history.filter((x) => x.id !== h.id); render(); persist(); }),
    ]);
}

// ---- Spreadsheet import (columns A to I copied from Google Sheets) ----

// Splits tab-separated text. Quoted cells may contain line breaks, as Google Sheets copies them.
function parseTSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// "11/2/2020" is day/month/year
function parseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// Reads "40k (VN)", "5 năm / 240k", "1.5 năm / 20k" and similar. Unknown text is kept as written.
function parseLife(s) {
  const text = (s || "").trim();
  const my = /(\d+(?:[.,]\d+)?)\s*năm/i.exec(text);
  const mk = /(\d+(?:[.,]\d+)?)\s*k\b/i.exec(text);
  return {
    text,
    months: my ? Math.round(parseFloat(my[1].replace(",", ".")) * 12) : "",
    km: mk ? Math.round(parseFloat(mk[1].replace(",", ".")) * 1000) : "",
  };
}

function guessAction(name) {
  const n = name.toLowerCase();
  if (/chỉnh|canh|tết|căn/.test(n)) return "Adjusted";
  if (/vệ sinh|súc|rửa/.test(n)) return "Cleaned";
  return "Replaced";
}

// Columns: A name, B description, C part number, D brand, E price, F dates, G odometer, H lifespan, I next due (recalculated)
function toPart(c) {
  const name = (c[0] || "").trim();
  if (!name) return null;
  const prices = lines(c[4]).map(toNum);
  const dates = lines(c[5]).map(parseDate);
  const odos = lines(c[6]).map(toNum);
  const life = parseLife(c[7]);
  const action = guessAction(name);
  const brandLines = lines(c[3]);
  const model = { id: uid(), name: T("default_model"), notes: "", lifeKm: life.km, lifeMonths: life.months, lifeText: life.text };
  const brand = { id: uid(), name: brandLines[0] || T("default_brand"), notes: brandLines.slice(1).join("\n"), models: [model] };
  const count = Math.max(dates.length, odos.length, prices.length);
  const history = [];
  for (let i = 0; i < count; i++) {
    const date = dates.length === 1 ? dates[0] : dates[i];
    if (!date) continue;
    const km = odos.length === 1 ? odos[0] : odos[i];
    const price = prices.length === 1 ? prices[0] : prices[i];
    history.push({
      id: uid(), date, km: km ?? "", action, cost: price ?? "", shop: "", notes: "", visitId: "",
      brandId: brand.id, modelId: model.id, nextKm: "", nextDate: "",
    });
  }
  return {
    id: uid(), name, description: oneLine(c[1]), oem: oneLine(c[2]), defaultAction: action,
    priority: false, order: 0, history, brands: [brand],
  };
}

function parseSheet(text) {
  const rows = parseTSV(text).filter((r, i) => !(i === 0 && /^(tên|name)$/i.test((r[0] || "").trim())));
  return rows.map(toPart).filter(Boolean);
}

function appendParts(v, parts) {
  parts.forEach((p) => {
    p.order = v.parts.length;
    v.parts.push(p);
  });
}

function importPanel(v) {
  const preview = importPreview;
  return el("div", { class: "vform" },
    el("h2", {}, T("import_sheet")),
    el("p", { class: "vmuted" }, T("import_help")),
    el("textarea", {
      class: "vinput vmulti", rows: 8, "aria-label": T("import_help"),
      oninput: (e) => { importText = e.target.value; },
    }, importText),
    el("div", { class: "vactions" },
      el("button", {
        type: "button",
        onclick: () => { importPreview = parseSheet(importText); note = ""; render(); },
      }, T("import_preview")),
      el("button", {
        type: "button",
        onclick: () => { view.importing = false; importPreview = null; note = ""; render(); },
      }, T("cancel"))),
    preview && preview.length
      ? el("div", {},
          preview.map((p) => el("div", { class: "vmuted" },
            p.name + " · " + p.history.length + " · " + (p.brands[0] ? p.brands[0].name : "—"))),
          el("button", {
            class: "primary", type: "button",
            onclick: () => {
              const n = preview.length;
              appendParts(v, preview);
              view.importing = false;
              importPreview = null;
              importText = "";
              note = T("import_done", { n });
              render();
              persist();
            },
          }, T("import_go", { n: preview.length })))
      : preview ? el("p", { class: "vnote" }, T("import_none")) : null);
}

// ---- Services (visits to a shop) ----

function partNameById(v, pid) {
  return (v.parts.find((x) => x.id === pid) || {}).name || "";
}

function visitFields(v) {
  return [
    { name: "date", label: T("f_date"), type: "date", value: todayVN() },
    { name: "type", label: T("f_visit_type"), placeholder: T("ph_visit_type") },
    { name: "km", label: T("f_km"), type: "number", inputmode: "numeric", value: currentKm(v) },
    { name: "cost", label: T("f_cost"), type: "number", inputmode: "numeric" },
    { name: "action", label: T("f_visit_action"), options: actionOptions(), value: "Serviced" },
    { name: "parts", label: T("f_parts_done"), checks: v.parts.map((p) => ({ value: p.id, label: p.name })) },
    { name: "notes", label: T("f_notes") },
  ];
}

// Ticked parts get a history entry with the brand and model they last used, and its next due
function addVisit(v, vals) {
  if (!vals.date || !vals.type) return T("err_service");
  const km = toNum(vals.km);
  const visit = {
    id: uid(), date: vals.date, km: km ?? "", type: vals.type,
    cost: toNum(vals.cost) ?? 0, notes: vals.notes || "",
    action: vals.action || "Serviced",
    parts: vals.parts ? vals.parts.split("|").filter(Boolean) : [],
  };
  v.services.push(visit);
  if (km != null) v.odometer = Math.max(Number(v.odometer) || 0, km);
  for (const pid of visit.parts) {
    const p = v.parts.find((x) => x.id === pid);
    if (!p) continue;
    const pick = defaultPick(p);
    const model = modelById(p, pick.modelId);
    p.history.push({
      id: uid(), date: visit.date, km: visit.km, action: visit.action,
      cost: "", shop: "", notes: visit.notes, visitId: visit.id,
      brandId: pick.brandId, modelId: pick.modelId,
      nextKm: nextKmFor(model, visit.km), nextDate: nextDateFor(model, visit.date),
    });
  }
  persist();
  return "";
}

function deleteVisit(v, id) {
  v.services = v.services.filter((s) => s.id !== id);
  v.parts.forEach((p) => { p.history = p.history.filter((h) => h.visitId !== id); });
  persist();
}

const visitText = (v, s) => [s.type, s.date, s.notes, actionLabel(s.action), (s.parts || []).map((pid) => partNameById(v, pid)).join(" ")].join(" ");

function visitItem(v, s) {
  return item(
    s.type || "—",
    s.cost ? el("span", { class: "vmuted" }, fmtMoney(s.cost)) : null,
    [s.date, actionLabel(s.action), fmtKm(s.km), (s.parts || []).map((pid) => partNameById(v, pid)).filter(Boolean).join(", "), s.notes],
    [delBtn(() => deleteVisit(v, s.id))]);
}

function visitsTab(v) {
  const sorted = [...v.services].sort((a, b) => (a.date < b.date ? 1 : -1));
  return el("div", {},
    searchable(searchKey("services"), sorted, (s) => visitText(v, s),
      (shown) => shown.map((s) => visitItem(v, s)), { emptyKey: "nothing_here" }),
    addBlock(T("add_service"), visitFields(v), T("save_service"), (vals) => addVisit(v, vals)));
}

// ---- Reminders (can follow a part or a service type) ----

function kindsOf(v) {
  return [...new Set(v.services.map((s) => s.type).filter(Boolean))];
}

function linkOptions(v) {
  return [
    { value: "", label: T("not_linked") },
    ...v.parts.map((p) => ({ value: "part:" + p.id, label: T("link_part") + ": " + p.name })),
    ...kindsOf(v).map((k) => ({ value: "service:" + k, label: T("link_service") + ": " + k })),
  ];
}

function linkLabel(v, link) {
  if (link.startsWith("part:")) {
    const p = v.parts.find((x) => x.id === link.slice(5));
    return p ? T("link_part") + ": " + p.name : "";
  }
  if (link.startsWith("service:")) return T("link_service") + ": " + link.slice(8);
  return "";
}

function reminderFields(v) {
  return [
    { name: "name", label: T("f_name"), placeholder: T("ph_reminder_name") },
    { name: "link", label: T("f_link"), options: linkOptions(v), value: "" },
    { name: "mode", label: T("f_repeat_by"), options: [{ value: "km", label: T("f_repeat_km") }, { value: "months", label: T("f_repeat_months") }] },
    { name: "intervalKm", label: T("f_every_km"), type: "number", inputmode: "numeric" },
    { name: "intervalMonths", label: T("f_every_months"), type: "number", inputmode: "numeric" },
    { name: "lastDate", label: T("f_last_done_date"), type: "date" },
    { name: "lastKm", label: T("f_last_done_km"), type: "number", inputmode: "numeric" },
  ];
}

function addReminder(v, vals) {
  if (!vals.name) return T("err_name_reminder");
  if (vals.mode === "km" && toNum(vals.intervalKm) == null) return T("err_km_interval");
  if (vals.mode === "months" && toNum(vals.intervalMonths) == null) return T("err_month_interval");
  v.reminders.push({
    id: uid(), name: vals.name, mode: vals.mode, link: vals.link || "",
    intervalKm: toNum(vals.intervalKm) ?? "", intervalMonths: toNum(vals.intervalMonths) ?? "",
    lastDate: vals.lastDate || "", lastKm: toNum(vals.lastKm) ?? "",
  });
  persist();
  return "";
}

function reminderItem(v, r, ev) {
  const st = ev.find((x) => x.id === r.id) || { status: "unknown", text: T("no_record") };
  const every = r.mode === "km" ? T("every_km", { n: fmtNum(r.intervalKm) }) : T("every_months", { n: r.intervalMonths });
  const actions = [];
  if (!r.link) {
    actions.push(el("button", {
      type: "button",
      onclick: () => { r.lastDate = todayVN(); r.lastKm = currentKm(v); render(); persist(); },
    }, T("done_today")));
  }
  actions.push(delBtn(() => { v.reminders = v.reminders.filter((x) => x.id !== r.id); persist(); }));
  return item(r.name, chip(st.status), [
    st.status !== "unknown" ? st.text : "",
    every,
    r.link ? T("link_follows", { x: linkLabel(v, r.link) }) : "",
  ], actions);
}

function remindersTab(v) {
  const ev = statusOf(v).reminders;
  return el("div", {},
    searchable(searchKey("reminders"), v.reminders, (r) => [r.name, linkLabel(v, r.link)].join(" "),
      (shown, unfiltered) => shown.map((r) => reorderRow(reminderScope(v), r.id, reminderItem(v, r, ev), unfiltered)),
      { tag: "ul", cls: "vlist", emptyKey: "nothing_here" }),
    addBlock(T("add_reminder"), reminderFields(v), T("save_reminder"), (vals) => addReminder(v, vals)));
}

// ---- Fuel ----

function fuelItem(v, f, cons) {
  return item(
    f.date + " · " + fmtKm(f.km),
    null,
    [
      fmtNum(f.liters) + " L · " + fmtMoney(f.cost) + " · " + fuelLabel(f.fuelType) +
        (cons[f.id] ? " · " + fmtNum(cons[f.id].toFixed(1)) + " L/100 km" : ""),
      f.note,
    ],
    [delBtn(() => { v.fuel = v.fuel.filter((x) => x.id !== f.id); persist(); })]);
}

function fuelTab(v) {
  const sorted = [...v.fuel].sort((a, b) => Number(a.km) - Number(b.km));
  const cons = {};
  for (let i = 1; i < sorted.length; i++) {
    const diff = Number(sorted[i].km) - Number(sorted[i - 1].km);
    const litres = Number(sorted[i].liters);
    if (diff > 0 && litres > 0) cons[sorted[i].id] = (litres / diff) * 100;
  }
  const add = addBlock(T("add_fuel"), [
    { name: "date", label: T("f_date"), type: "date", value: todayVN() },
    { name: "km", label: T("f_km"), type: "number", inputmode: "numeric" },
    { name: "liters", label: T("f_liters"), type: "number", inputmode: "decimal" },
    { name: "cost", label: T("f_total_cost"), type: "number", inputmode: "numeric" },
    { name: "fuelType", label: T("f_fuel_type"), options: FUEL_TYPES.map((f) => ({ value: f, label: fuelLabel(f) })) },
    { name: "note", label: T("f_notes") },
  ], T("save_fuel"), (vals) => {
    const km = toNum(vals.km);
    const liters = toNum(vals.liters);
    if (!vals.date || km == null || liters == null) return T("err_fuel");
    v.fuel.push({ id: uid(), date: vals.date, km, liters, cost: toNum(vals.cost) ?? 0, fuelType: vals.fuelType, note: vals.note || "" });
    v.odometer = Math.max(Number(v.odometer) || 0, km);
    persist();
    return "";
  });
  return el("div", {},
    el("p", { class: "vmuted" }, T("consumption_note")),
    searchable(searchKey("fuel"), [...sorted].reverse(), (f) => [f.date, f.km, f.fuelType, f.note].join(" "),
      (shown) => shown.map((f) => fuelItem(v, f, cons)), { emptyKey: "nothing_here" }),
    add);
}

// ---- Expenses ----

function expenseItem(v, e) {
  return item(
    catLabel(e.category),
    el("span", { class: "vmuted" }, fmtMoney(e.amount)),
    [e.date, e.note],
    [delBtn(() => { v.expenses = v.expenses.filter((x) => x.id !== e.id); persist(); })]);
}

function expensesTab(v) {
  const today = todayVN();
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  let monthTotal = 0;
  let yearTotal = 0;
  for (const e of v.expenses) {
    const amount = Number(e.amount) || 0;
    if (e.date.startsWith(year)) yearTotal += amount;
    if (e.date.startsWith(month)) monthTotal += amount;
  }
  const sorted = [...v.expenses].sort((a, b) => (a.date < b.date ? 1 : -1));
  const add = addBlock(T("add_expense"), [
    { name: "date", label: T("f_date"), type: "date", value: today },
    { name: "category", label: T("f_category"), options: EXP_CATS.map((c) => ({ value: c, label: catLabel(c) })) },
    { name: "amount", label: T("f_amount"), type: "number", inputmode: "numeric" },
    { name: "note", label: T("f_notes") },
  ], T("save_expense"), (vals) => {
    const amount = toNum(vals.amount);
    if (!vals.date || amount == null) return T("err_amount");
    v.expenses.push({ id: uid(), date: vals.date, category: vals.category, amount, note: vals.note || "" });
    persist();
    return "";
  });
  return el("div", {},
    el("p", { class: "vmuted" }, T("this_month", { m: fmtMoney(monthTotal), y: fmtMoney(yearTotal) })),
    searchable(searchKey("expenses"), sorted, (e) => [e.date, catLabel(e.category), e.note, e.amount].join(" "),
      (shown) => shown.map((e) => expenseItem(v, e)), { emptyKey: "nothing_here" }),
    add);
}

// ---- Documents ----

function documentItem(v, d, ev) {
  const st = ev.find((x) => x.id === d.id) || { status: "unknown", text: "", latest: false };
  const showText = st.latest && st.status !== "unknown";
  return item(
    docLabel(d.type),
    chip(st.latest ? st.status : "unknown", st.latest ? null : T("status_older")),
    [T("issued_line", { issued: d.issued || T("dash"), expires: d.expires || T("dash") }), showText ? st.text : ""],
    [delBtn(() => { v.documents = v.documents.filter((x) => x.id !== d.id); persist(); })]);
}

function documentsTab(v) {
  const ev = statusOf(v).documents;
  const add = addBlock(T("add_document"), [
    { name: "type", label: T("f_document"), options: DOC_TYPES.map((x) => ({ value: x, label: docLabel(x) })) },
    { name: "issued", label: T("f_issued_date"), type: "date" },
    { name: "expires", label: T("f_expiry_date"), type: "date" },
    { name: "note", label: T("f_notes") },
  ], T("save_document"), (vals) => {
    if (!vals.type) return T("err_doc_type");
    v.documents.push({ id: uid(), type: vals.type, issued: vals.issued || "", expires: vals.expires || "", note: vals.note || "" });
    persist();
    return "";
  });
  return el("div", {},
    searchable(searchKey("documents"), v.documents, (d) => [d.type, docLabel(d.type), d.issued, d.expires, d.note].join(" "),
      (shown, unfiltered) => shown.map((d) => reorderRow(documentScope(v), d.id, documentItem(v, d, ev), unfiltered)),
      { tag: "ul", cls: "vlist", emptyKey: "nothing_here" }),
    add);
}

// ---- Vehicle details (edit and delete) ----

// Form fields for the Details section (Current ODO is changed on the vehicle screen instead)
function detailsFields(v) {
  return vehicleFields(v)
    .filter((f) => f.name !== "odometer")
    .concat([{ name: "details", label: T("f_details"), multiline: true, value: v.details || "" }]);
}

function deleteVehicleNow(v) {
  if (!confirm(T("delete_confirm", { name: v.name }))) return;
  vehicles = vehicles.filter((x) => x.id !== v.id);
  goGarage();
  persist();
}

function vehicleDetailsBlock(v) {
  if (!view.detailsOpen) return null;
  const links = (v.details || "").match(/https?:\/\/[^\s]+/g) || [];
  return el("div", { class: "vcard vdetailsbox" },
    el("h2", {}, T("vehicle_details")),
    form(detailsFields(v), T("save_details"), (vals) => {
      if (!vals.name) return T("err_name_vehicle");
      Object.assign(v, {
        type: vals.type || v.type,
        name: vals.name,
        make: vals.make,
        model: vals.model,
        year: toNum(vals.year) ?? "",
        plate: vals.plate,
        kmWarn: toNum(vals.kmWarn) ?? 500,
        details: vals.details || "",
      });
      view.detailsOpen = false;
      persist();
      return "";
    }, () => { view.detailsOpen = false; note = ""; render(); }),
    links.length
      ? el("div", { class: "vlinks" },
          el("strong", {}, T("links_label")),
          links.map((u) => el("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, u)))
      : null,
    el("button", { class: "vdel vdelete", type: "button", onclick: () => deleteVehicleNow(v) }, T("delete_vehicle")));
}

// ---- Search ----

function searchKey(part) {
  return [view.name, view.vehicleId || "", view.tab, part || ""].join("|");
}

// A search box above a list. Typing filters the list in place, so the box keeps focus.
// build(shown, unfiltered): unfiltered is false while searching, which turns reordering off.
function searchable(key, items, toText, build, opts2 = {}) {
  const input = el("input", {
    class: "vinput vsearch", type: "search",
    placeholder: T("search_placeholder"), "aria-label": T("search_placeholder"),
  });
  input.value = searches[key] || "";
  const tag = opts2.tag || "div";
  const box = el(tag, { class: opts2.cls || "vsearch-box" });
  const fill = () => {
    const q = (searches[key] || "").trim().toLowerCase();
    const shown = q ? items.filter((x) => String(toText(x)).toLowerCase().includes(q)) : items;
    const nodes = shown.length ? build(shown, !q) : [];
    if (!nodes.length) {
      nodes.push(el(tag === "ul" ? "li" : "p", { class: "vmuted" },
        q ? T("search_none") : T(opts2.emptyKey || "nothing_here")));
    }
    box.replaceChildren(...nodes);
  };
  input.addEventListener("input", () => {
    searches[key] = input.value;
    fill();
  });
  fill();
  return el("div", { class: "vsearchable" }, input, box);
}

// ---- Report: everything due soon or overdue ----

function reportRows() {
  const rows = [];
  for (const v of vehicles) {
    const ev = statusOf(v);
    for (const p of ev.parts) {
      if (URGENT(p.status)) rows.push({ vehicle: v, title: p.name, status: p.status, text: p.text, kind: "part" });
    }
    for (const r of ev.reminders) {
      if (URGENT(r.status)) rows.push({ vehicle: v, title: r.name, status: r.status, text: r.text, kind: "reminder" });
    }
    for (const d of ev.documents) {
      if (d.latest && URGENT(d.status)) rows.push({ vehicle: v, title: docLabel(d.type), status: d.status, text: d.text, kind: "document" });
    }
  }
  rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));
  return rows;
}

function reportGroups(rows) {
  const kindKey = { part: "report_kind_part", reminder: "report_kind_reminder", document: "report_kind_document" };
  return vehicles
    .map((v) => ({ v, items: rows.filter((r) => r.vehicle.id === v.id) }))
    .filter((g) => g.items.length)
    .map((g) => el("div", {},
      el("h2", {}, g.v.name + " · " + fmtKm(currentKm(g.v))),
      g.items.map((r) => item(r.title, chip(r.status), [r.text, T(kindKey[r.kind])], []))));
}

function reportView() {
  const rows = reportRows();
  const overdue = rows.filter((r) => r.status === "overdue").length;
  const soon = rows.length - overdue;
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
    el("h1", {}, T("report_title")),
    el("p", { class: "vsub" }, T("report_asof", { date: todayVN() })),
    el("div", { class: "vrow vsubrow" },
      el("span", { class: "vchip vchip-overdue" }, T("report_overdue", { n: overdue })),
      el("span", { class: "vchip vchip-soon" }, T("report_soon", { n: soon }))),
    searchable("report", rows, (r) => [r.title, r.text, r.vehicle.name].join(" "),
      (shown) => reportGroups(shown), { emptyKey: "report_none" }));
}

function settingsView() {
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
    el("h1", {}, T("settings")),
    note ? el("p", { class: "vnote" }, note) : null,
    pushCard());
}

// ---- Rendering ----

function render() {
  if (view.name === "detail" || view.name === "part") {
    const v = currentVehicle();
    if (!v) view = freshView("garage");
    else if (view.name === "part" && !v.parts.some((p) => p.id === view.partId)) view = { ...view, name: "detail", partId: null };
  }
  let content;
  if (view.name === "detail") {
    content = detailView(currentVehicle());
  } else if (view.name === "part") {
    const v = currentVehicle();
    content = partDetailView(v, v.parts.find((p) => p.id === view.partId));
  } else if (view.name === "report") {
    content = reportView();
  } else if (view.name === "settings") {
    content = settingsView();
  } else {
    content = garageView();
  }
  // Slide when moving between screens. Changing tabs or refreshing data does not replay the slide.
  const nav = [view.name, view.vehicleId || "", view.partId || ""].join("|");
  if (nav !== lastNav) {
    const depth = view.name === "garage" ? 0 : view.name === "part" ? 2 : 1;
    const dir = depth > lastDepth ? "forward" : depth < lastDepth ? "back" : "fade";
    content.classList.add("vscreen-" + dir);
    lastNav = nav;
    lastDepth = depth;
  }
  root.replaceChildren(content);
  updateTabLabel();
  if (view.odoFocusPending) {
    view.odoFocusPending = false;
    const input = root.querySelector(".vodo-input");
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function show() {
  detectPush();
  refreshStatuses();
}

window.VehiclesApp = { show };
load();
