/* Vehicles tab: garage, parts, services, reminders, fuel, expenses, documents, report, notifications.
   English and Vietnamese. */
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

function freshView(name) {
  return { name, vehicleId: null, partId: null, tab: "parts", adding: false, editing: false, importing: false };
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

function currentKm(v) {
  let km = Number(v.odometer) || 0;
  for (const s of v.services) km = Math.max(km, Number(s.km) || 0);
  for (const f of v.fuel) km = Math.max(km, Number(f.km) || 0);
  for (const p of v.parts) for (const h of p.history) km = Math.max(km, Number(h.km) || 0);
  return km;
}

// Fills in fields that older saves do not have.
function migrate(v) {
  v.parts = v.parts || [];
  v.services = v.services || [];
  v.fuel = v.fuel || [];
  v.expenses = v.expenses || [];
  v.reminders = v.reminders || [];
  v.documents = v.documents || [];
  v.services.forEach((s) => { s.parts = s.parts || []; });
  v.reminders.forEach((r) => { r.link = r.link || ""; });
  v.parts.forEach((p, i) => {
    p.history = p.history || [];
    if (typeof p.order !== "number") p.order = i;
  });
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
      plate: "", odometer: 0, kmWarn: 500, parts: [], services: [], fuel: [], expenses: [],
      reminders: [rem("Engine oil change", "km", 5000), rem("Brake fluid change", "months", 24)],
      documents: docs(),
    },
    {
      id: uid(), name: "Honda SH 150i", type: "scooter", make: "Honda", model: "SH 150i", year: 2014,
      plate: "", odometer: 0, kmWarn: 200, parts: [], services: [], fuel: [], expenses: [],
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
function persist() {
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
      vehicles.forEach(migrate);
      cache();
      await persist();
      return;
    }
  } catch (e) {
    vehicles = readCache() || seed();
    note = T("showing_copy");
  }
  vehicles.forEach(migrate);
  cache();
  updateTabLabel();
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

function form(fields, submitText, onSubmit) {
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
      : el("input", { class: "vinput", type: f.type || "text", inputmode: f.inputmode, placeholder: f.placeholder });
    if (f.value != null) input.value = f.value;
    inputs[f.name] = input;
    return el("label", { class: "vfield" }, el("span", {}, f.label), input);
  });
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
  }, rows, el("button", { class: "primary", type: "submit" }, submitText));
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

function item(title, status, lines, actions) {
  return el("div", { class: "vitem" },
    el("div", { class: "vrow" }, el("strong", {}, title), status || null),
    lines.filter(Boolean).map((l) => el("div", { class: "vmuted" }, l)),
    el("div", { class: "vactions" }, actions || []));
}

const delBtn = (onDelete) => el("button", { class: "vdel", type: "button", onclick: onDelete }, T("delete"));

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
    year: toNum(vals.year) ?? "", plate: vals.plate,
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
    }, t(l, "lang_name"))));
}

function garageView() {
  return el("div", {},
    el("h1", {}, T("vehicles_title")),
    el("div", { class: "vrow vsubrow" },
      el("p", { class: "vsub" }, vehicles.length === 1 ? T("vehicle_one") : T("vehicles_many", { n: vehicles.length })),
      languageSwitch()),
    note ? el("p", { class: "vnote" }, note) : null,
    pushCard(),
    el("div", { class: "vreport-row" },
      el("button", { class: "vreport", type: "button", onclick: openReport }, reportIcon(), T("report_open"))),
    vehicles.map((v) => el("button", {
      class: "vcard vcar", type: "button",
      onclick: () => goDetail(v.id, "parts"),
    },
      el("div", { class: "vrow" }, el("strong", {}, v.name), chip(vehicleStatus(v))),
      el("div", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ")),
      el("div", { class: "vmuted" }, fmtKm(currentKm(v))))),
    addBlock(T("add_vehicle"), vehicleFields(null), T("save_vehicle"), addVehicle));
}

function reportIcon() {
  const span = document.createElement("span");
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>';
  return span;
}

// ---- Navigation ----

function goGarage() {
  view = freshView("garage");
  note = "";
  render();
}

function goDetail(id, tab) {
  view = { ...freshView("detail"), vehicleId: id, tab: tab || "parts" };
  note = "";
  render();
  window.scrollTo(0, 0);
}

function openPart(id) {
  view = { ...view, name: "part", partId: id, adding: false, editing: false, importing: false };
  note = "";
  render();
  window.scrollTo(0, 0);
}

function openReport() {
  view = freshView("report");
  note = "";
  render();
  window.scrollTo(0, 0);
}

function currentVehicle() {
  return vehicles.find((x) => x.id === view.vehicleId);
}

function detailView(v) {
  const tabs = ["parts", "services", "reminders", "fuel", "expenses", "documents"];
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
    el("h1", {}, v.name),
    el("div", { class: "vrow vsubrow" },
      el("span", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ") + " · " + fmtKm(currentKm(v))),
      chip(vehicleStatus(v))),
    note ? el("p", { class: "vnote" }, note) : null,
    el("div", { class: "vtabs" }, tabs.map((key) => el("button", {
      type: "button", class: "vtab", "aria-pressed": String(view.tab === key),
      onclick: () => { view.tab = key; view.adding = false; view.importing = false; note = ""; render(); },
    }, T("tab_" + key)))),
    tabBody(v),
    vehicleDetailsBlock(v));
}

function tabBody(v) {
  if (view.tab === "services") return visitsTab(v);
  if (view.tab === "reminders") return remindersTab(v);
  if (view.tab === "fuel") return fuelTab(v);
  if (view.tab === "expenses") return expensesTab(v);
  if (view.tab === "documents") return documentsTab(v);
  return partsTab(v);
}

// ---- Parts ----

function partsSorted(v) {
  return [...v.parts].sort((a, b) => ((b.priority ? 1 : 0) - (a.priority ? 1 : 0)) || (a.order - b.order));
}

function lastEntry(p) {
  let best = null;
  for (const h of p.history) {
    if (!best || h.date > best.date || (h.date === best.date && Number(h.km) > Number(best.km))) best = h;
  }
  return best;
}

function partFields(p) {
  return [
    { name: "name", label: T("f_name"), placeholder: T("ph_part_name"), value: p ? p.name : "" },
    { name: "description", label: T("f_description"), value: p ? p.description : "" },
    { name: "oem", label: T("f_oem"), value: p ? p.oem : "" },
    { name: "brand", label: T("f_brand"), value: p ? p.brand : "" },
    { name: "lifeKm", label: T("f_life_km"), type: "number", inputmode: "numeric", value: p ? p.lifeKm : "" },
    { name: "lifeMonths", label: T("f_life_months"), type: "number", inputmode: "numeric", value: p ? p.lifeMonths : "" },
    { name: "lifeText", label: T("f_life_text"), value: p ? p.lifeText : "" },
    { name: "defaultAction", label: T("f_default_action"), options: actionOptions(), value: p ? p.defaultAction : "Replaced" },
  ];
}

function addPart(v, vals) {
  if (!vals.name) return T("err_name_part");
  v.parts.push({
    id: uid(), name: vals.name, description: vals.description || "", oem: vals.oem || "", brand: vals.brand || "",
    lifeKm: toNum(vals.lifeKm) ?? "", lifeMonths: toNum(vals.lifeMonths) ?? "", lifeText: vals.lifeText || "",
    defaultAction: vals.defaultAction || "Replaced", priority: false, order: v.parts.length, history: [],
  });
  persist();
  return "";
}

function updatePart(p, vals) {
  if (!vals.name) return T("err_name_part");
  Object.assign(p, {
    name: vals.name, description: vals.description || "", oem: vals.oem || "", brand: vals.brand || "",
    lifeKm: toNum(vals.lifeKm) ?? "", lifeMonths: toNum(vals.lifeMonths) ?? "", lifeText: vals.lifeText || "",
    defaultAction: vals.defaultAction || "Replaced",
  });
  view.editing = false;
  persist();
  return "";
}

// One tap: log this part as done today at the current mileage, using its usual action.
function quickDone(v, p) {
  p.history.push({
    id: uid(), date: todayVN(), km: currentKm(v), action: p.defaultAction || "Replaced",
    cost: "", shop: "", notes: "", visitId: "",
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

function partRow(v, p) {
  const st = statusOf(v).parts.find((x) => x.id === p.id) || { status: "unknown", text: T("no_record") };
  const last = lastEntry(p);
  return el("li", { class: "vpart" + (p.priority ? " priority" : ""), "data-pid": p.id },
    el("div", { class: "vrow" },
      el("span", { class: "vleft" },
        handle(p.id),
        starBtn(p),
        el("button", { class: "vlink", type: "button", onclick: () => openPart(p.id) }, p.name)),
      chip(st.status)),
    el("div", { class: "vmuted" }, last
      ? T("last_done", { action: actionLabel(last.action), date: last.date, km: fmtKm(last.km) })
      : T("part_no_history")),
    el("div", { class: "vmuted" }, st.text),
    el("div", { class: "vactions" },
      el("button", { type: "button", onclick: () => quickDone(v, p) }, T("done_today"))));
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
    list.length
      ? el("p", { class: "vmuted" }, T("reorder_hint"))
      : el("p", { class: "vmuted" }, T("no_parts_yet")),
    list.length ? el("ul", { class: "vlist" }, list.map((p) => partRow(v, p))) : null,
    importBtn,
    add);
}

function partDetailView(v, p) {
  const st = statusOf(v).parts.find((x) => x.id === p.id) || { status: "unknown", text: T("no_record") };
  const entries = [...p.history].sort((a, b) => (a.date < b.date ? 1 : -1));
  const shops = p.history
    .filter((h) => h.shop && toNum(h.cost) != null)
    .sort((a, b) => toNum(a.cost) - toNum(b.cost));
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: () => goDetail(v.id, "parts") }, T("back_parts")),
    el("h1", {}, p.name),
    el("div", { class: "vrow vsubrow" }, el("span", { class: "vmuted" }, st.text), chip(st.status)),
    note ? el("p", { class: "vnote" }, note) : null,
    el("div", { class: "vcard" },
      el("h2", {}, T("part_details")),
      [
        p.description,
        p.oem ? T("f_oem") + ": " + p.oem : "",
        p.brand ? T("f_brand") + ": " + p.brand : "",
        p.lifeText ? T("f_life_text") + ": " + p.lifeText : "",
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
    el("h2", {}, T("part_history")),
    entries.length
      ? entries.map((h) => item(
          actionLabel(h.action) + " · " + h.date,
          null,
          [fmtKm(h.km), h.cost !== "" && h.cost != null && toNum(h.cost) ? fmtMoney(h.cost) : "", h.shop, h.notes],
          [delBtn(() => { p.history = p.history.filter((x) => x.id !== h.id); render(); persist(); })]))
      : el("p", { class: "vmuted" }, T("part_no_history")),
    shops.length
      ? el("div", {},
          el("h2", {}, T("part_prices")),
          shops.map((h) => item(h.shop, el("span", { class: "vmuted" }, fmtMoney(h.cost)), [h.date], [])))
      : null,
    addBlock(T("add_entry"), entryFields(v, p), T("save_entry"), (vals) => addEntry(v, p, vals)));
}

function entryFields(v, p) {
  return [
    { name: "action", label: T("f_action"), options: actionOptions(), value: p.defaultAction || "Replaced" },
    { name: "date", label: T("f_date"), type: "date", value: todayVN() },
    { name: "km", label: T("f_km"), type: "number", inputmode: "numeric", value: currentKm(v) },
    { name: "cost", label: T("f_cost"), type: "number", inputmode: "numeric" },
    { name: "shop", label: T("f_shop") },
    { name: "notes", label: T("f_notes") },
  ];
}

function addEntry(v, p, vals) {
  if (!vals.date) return T("err_entry");
  p.history.push({
    id: uid(), date: vals.date, km: toNum(vals.km) ?? "", action: vals.action || "Replaced",
    cost: toNum(vals.cost) ?? "", shop: vals.shop || "", notes: vals.notes || "", visitId: "",
  });
  persist();
  return "";
}

// Drag and drop reordering. Drags stay inside the same priority group.
function handle(pid) {
  return el("span", {
    class: "handle", title: T("reorder_hint"), "aria-label": T("reorder_hint"),
    onpointerdown: (e) => startDrag(e, pid),
    onpointermove: moveDrag,
    onpointerup: (e) => endDrag(e, true),
    onpointercancel: (e) => endDrag(e, false),
  }, "⠿");
}

function startDrag(e, pid) {
  const v = currentVehicle();
  if (!v) return;
  const list = partsSorted(v);
  const idx = list.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const me = list[idx];
  let lo = idx;
  let hi = idx;
  while (lo > 0 && !!list[lo - 1].priority === !!me.priority) lo--;
  while (hi < list.length - 1 && !!list[hi + 1].priority === !!me.priority) hi++;
  const groupIds = new Set(list.slice(lo, hi + 1).map((p) => p.id));
  const li = e.currentTarget.closest("li");
  const others = [...root.querySelectorAll("li[data-pid]")]
    .filter((r) => r.dataset.pid !== pid && groupIds.has(r.dataset.pid));
  const rect = li.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(li.parentElement).rowGap) || 10;
  drag = {
    pid, li, pointerId: e.pointerId, startY: e.clientY,
    centerY: rect.top + rect.height / 2, step: rect.height + gap,
    lo, f: idx - lo, others,
    mids: others.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }),
    k: null, list,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
  others.forEach((r) => r.classList.add("shift"));
  e.preventDefault();
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dy = e.clientY - drag.startY;
  drag.li.style.transform = `translateY(${dy}px)`;
  const y = drag.centerY + dy;
  let k = 0;
  drag.mids.forEach((m) => { if (m < y) k++; });
  drag.k = k;
  // Other rows slide one slot to open a gap where the dragged row will land
  drag.others.forEach((r, j) => {
    const newSlot = j < k ? j : j + 1;
    const oldSlot = j < drag.f ? j : j + 1;
    const shift = newSlot > oldSlot ? drag.step : newSlot < oldSlot ? -drag.step : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
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
  const moved = d.list.find((p) => p.id === d.pid);
  const rest = d.list.filter((p) => p.id !== d.pid);
  rest.splice(d.lo + d.k, 0, moved);
  rest.forEach((p, i) => { p.order = i; });
  render();
  persist();
}

// ---- Import from spreadsheet (copy of columns A to I from Google Sheets) ----

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

const lines = (s) => (s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const oneLine = (s) => lines(s).join(" ");

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
  const count = Math.max(dates.length, odos.length, prices.length);
  const history = [];
  for (let i = 0; i < count; i++) {
    const date = dates.length === 1 ? dates[0] : dates[i];
    if (!date) continue;
    const km = odos.length === 1 ? odos[0] : odos[i];
    const price = prices.length === 1 ? prices[0] : prices[i];
    history.push({
      id: uid(), date, km: km ?? "", action, cost: price ?? "", shop: "", notes: "", visitId: "",
    });
  }
  return {
    id: uid(), name, description: oneLine(c[1]), oem: oneLine(c[2]), brand: lines(c[3]).join(" / "),
    lifeKm: life.km, lifeMonths: life.months, lifeText: life.text,
    defaultAction: action, priority: false, order: 0, history,
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
      class: "vinput", rows: 8, "aria-label": T("import_help"),
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
            p.name + " · " + p.history.length + " · " + (p.lifeText || "—"))),
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

// Ticked parts get a history entry, so the Parts tab stays up to date.
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
    if (p) {
      p.history.push({
        id: uid(), date: visit.date, km: visit.km, action: visit.action,
        cost: "", shop: "", notes: visit.notes, visitId: visit.id,
      });
    }
  }
  persist();
  return "";
}

function deleteVisit(v, id) {
  v.services = v.services.filter((s) => s.id !== id);
  v.parts.forEach((p) => { p.history = p.history.filter((h) => h.visitId !== id); });
  persist();
}

function visitsTab(v) {
  const list = [...v.services].sort((a, b) => (a.date < b.date ? 1 : -1)).map((s) => item(
    s.type || "—",
    s.cost ? el("span", { class: "vmuted" }, fmtMoney(s.cost)) : null,
    [
      s.date,
      actionLabel(s.action),
      fmtKm(s.km),
      (s.parts || []).map((pid) => (v.parts.find((x) => x.id === pid) || {}).name).filter(Boolean).join(", "),
      s.notes,
    ],
    [delBtn(() => deleteVisit(v, s.id))]));
  return el("div", {},
    list,
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

function remindersTab(v) {
  const ev = statusOf(v).reminders;
  const list = v.reminders.map((r) => {
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
      st.text,
      every,
      r.link ? T("link_follows", { x: linkLabel(v, r.link) }) : "",
    ], actions);
  });
  return el("div", {},
    list,
    addBlock(T("add_reminder"), reminderFields(v), T("save_reminder"), (vals) => addReminder(v, vals)));
}

// ---- Fuel ----

function fuelTab(v) {
  const sorted = [...v.fuel].sort((a, b) => Number(a.km) - Number(b.km));
  const cons = {};
  for (let i = 1; i < sorted.length; i++) {
    const diff = Number(sorted[i].km) - Number(sorted[i - 1].km);
    const litres = Number(sorted[i].liters);
    if (diff > 0 && litres > 0) cons[sorted[i].id] = (litres / diff) * 100;
  }
  const list = [...sorted].reverse().map((f) => item(
    f.date + " · " + fmtKm(f.km),
    null,
    [
      fmtNum(f.liters) + " L · " + fmtMoney(f.cost) + " · " + fuelLabel(f.fuelType) +
        (cons[f.id] ? " · " + fmtNum(cons[f.id].toFixed(1)) + " L/100 km" : ""),
      f.note,
    ],
    [delBtn(() => { v.fuel = v.fuel.filter((x) => x.id !== f.id); persist(); })]));
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
  return el("div", {}, el("p", { class: "vmuted" }, T("consumption_note")), list, add);
}

// ---- Expenses ----

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
  const list = [...v.expenses].sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => item(
    catLabel(e.category),
    el("span", { class: "vmuted" }, fmtMoney(e.amount)),
    [e.date, e.note],
    [delBtn(() => { v.expenses = v.expenses.filter((x) => x.id !== e.id); persist(); })]));
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
    list, add);
}

// ---- Documents ----

function documentsTab(v) {
  const ev = statusOf(v).documents;
  const list = v.documents.map((d) => {
    const st = ev.find((x) => x.id === d.id) || { status: "unknown", text: "", latest: false };
    return item(
      docLabel(d.type),
      chip(st.latest ? st.status : "unknown", st.latest ? null : T("status_older")),
      [T("issued_line", { issued: d.issued || T("dash"), expires: d.expires || T("dash") }), st.latest ? st.text : ""],
      [delBtn(() => { v.documents = v.documents.filter((x) => x.id !== d.id); persist(); })]);
  });
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
  return el("div", {}, list, add);
}

// ---- Vehicle details ----

function vehicleDetailsBlock(v) {
  if (!view.editing) {
    return el("div", { class: "vactions vdetails" },
      el("button", { type: "button", onclick: () => { view.editing = true; note = ""; render(); } }, T("edit_details")));
  }
  return el("div", {},
    el("h2", {}, T("vehicle_details")),
    form(vehicleFields(v), T("save_details"), (vals) => {
      if (!vals.name) return T("err_name_vehicle");
      Object.assign(v, {
        type: vals.type || v.type,
        name: vals.name,
        make: vals.make,
        model: vals.model,
        year: toNum(vals.year) ?? "",
        plate: vals.plate,
        kmWarn: toNum(vals.kmWarn) ?? 500,
      });
      const odometer = toNum(vals.odometer);
      if (odometer != null) v.odometer = odometer;
      view.editing = false;
      persist();
      return "";
    }),
    el("button", {
      class: "vdel vdelete", type: "button",
      onclick: () => {
        if (!confirm(T("delete_confirm", { name: v.name }))) return;
        vehicles = vehicles.filter((x) => x.id !== v.id);
        goGarage();
        persist();
      },
    }, T("delete_vehicle")));
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

function reportView() {
  const rows = reportRows();
  const overdue = rows.filter((r) => r.status === "overdue").length;
  const soon = rows.length - overdue;
  const kindKey = { part: "report_kind_part", reminder: "report_kind_reminder", document: "report_kind_document" };
  const groups = vehicles
    .map((v) => ({ v, items: rows.filter((r) => r.vehicle.id === v.id) }))
    .filter((g) => g.items.length);
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
    el("h1", {}, T("report_title")),
    el("p", { class: "vsub" }, T("report_asof", { date: todayVN() })),
    el("div", { class: "vrow vsubrow" },
      el("span", { class: "vchip vchip-overdue" }, T("report_overdue", { n: overdue })),
      el("span", { class: "vchip vchip-soon" }, T("report_soon", { n: soon }))),
    groups.length
      ? groups.map((g) => el("div", {},
          el("h2", {}, g.v.name + " · " + fmtKm(currentKm(g.v))),
          g.items.map((r) => item(r.title, chip(r.status), [r.text, T(kindKey[r.kind])], []))))
      : el("p", { class: "vmuted" }, T("report_none")));
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
  } else {
    content = garageView();
  }
  root.replaceChildren(content);
  updateTabLabel();
}

function show() {
  detectPush();
  refreshStatuses();
}

window.VehiclesApp = { show };
load();
