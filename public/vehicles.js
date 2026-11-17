/* Vehicles tab: garage, vehicle details, services, fuel, expenses, documents, reminders, notifications.
   Shown in English or Vietnamese. */
import { t, LANGS } from "/i18n.js";

const KEY = "vehicles-v1";
const LANG_KEY = "vehicles-lang";
const DOC_TYPES = ["Registration", "Inspection", "Insurance"];
const EXP_CATS = ["Insurance", "Parking", "Washing", "Repair", "Other"];
const FUEL_TYPES = ["E10", "E5", "RON 92", "RON 95", "Other"];

const root = document.getElementById("vehicles-root");
let lang = "en";
let vehicles = [];
let statuses = {};
let pushState = "checking"; // checking | unsupported | needs-home | denied | off | on
let view = { name: "garage", vehicleId: null, tab: "reminders", adding: false, editing: false };
let note = "";
let reminderTime = "10:00";
let chain = Promise.resolve();

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
const fmtKm = (n) => fmtNum(n) + " km";
const fmtMoney = (n) => fmtNum(n) + " " + T("vnd");
const opts = (list) => list.map((x) => (typeof x === "string" ? { value: x, label: x } : x));
const docLabel = (type) => T("doc_" + type.toLowerCase());
const catLabel = (c) => T("cat_" + c.toLowerCase());
const fuelLabel = (f) => (f === "Other" ? T("fuel_other") : f);
const statusLabel = (s) => T("status_" + s);

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
  return km;
}

// Starting data: the two vehicles. Reminder intervals are placeholders; check them against your manuals.
function seed() {
  const docs = () => DOC_TYPES.map((x) => ({ id: uid(), type: x, issued: "", expires: "", note: "" }));
  const rem = (name, mode, interval) => ({
    id: uid(), name, mode,
    intervalKm: mode === "km" ? interval : "",
    intervalMonths: mode === "months" ? interval : "",
    lastKm: "", lastDate: "",
  });
  return [
    {
      id: uid(), name: "Kia Cerato", type: "car", make: "Kia", model: "Cerato 2.0", year: 2017,
      plate: "", odometer: 0, kmWarn: 500, services: [], fuel: [], expenses: [],
      reminders: [rem("Engine oil change", "km", 5000), rem("Brake fluid change", "months", 24)],
      documents: docs(),
    },
    {
      id: uid(), name: "Honda SH 150i", type: "scooter", make: "Honda", model: "SH 150i", year: 2014,
      plate: "", odometer: 0, kmWarn: 200, services: [], fuel: [], expenses: [],
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

// Saves are queued one at a time; each sends the latest list and language.
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
      cache();
      await persist();
      return;
    }
  } catch (e) {
    vehicles = readCache() || seed();
    note = T("showing_copy");
  }
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

const statusOf = (v) => statuses[v.id] || { reminders: [], documents: [] };

function worstStatus(list) {
  const order = ["overdue", "soon", "ok", "unknown"];
  let best = "unknown";
  for (const s of list) if (order.indexOf(s) < order.indexOf(best)) best = s;
  return best;
}
function vehicleStatus(v) {
  const ev = statusOf(v);
  return worstStatus([
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
    persist();
    render();
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
    services: [], fuel: [], expenses: [], reminders: [],
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
    el("button", { class: "vadd", type: "button", onclick: openReport }, T("report_open")),
    vehicles.map((v) => el("button", {
      class: "vcard vcar", type: "button",
      onclick: () => openVehicle(v.id),
    },
      el("div", { class: "vrow" }, el("strong", {}, v.name), chip(vehicleStatus(v))),
      el("div", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ")),
      el("div", { class: "vmuted" }, fmtKm(currentKm(v))))),
    addBlock(T("add_vehicle"), vehicleFields(null), T("save_vehicle"), addVehicle));
}

// ---- Vehicle details ----

function openVehicle(id) {
  view = { name: "detail", vehicleId: id, tab: "reminders", adding: false, editing: false };
  note = "";
  render();
  window.scrollTo(0, 0);
}

function goGarage() {
  view = { name: "garage", vehicleId: null, tab: "reminders", adding: false, editing: false };
  note = "";
  render();
}

function detailView() {
  const v = vehicles.find((x) => x.id === view.vehicleId);
  const tabs = ["reminders", "services", "fuel", "expenses", "documents"];
  return el("div", {},
    el("button", { class: "vback", type: "button", onclick: goGarage }, T("back")),
    el("h1", {}, v.name),
    el("div", { class: "vrow vsubrow" },
      el("span", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ") + " · " + fmtKm(currentKm(v))),
      chip(vehicleStatus(v))),
    note ? el("p", { class: "vnote" }, note) : null,
    el("div", { class: "vtabs" }, tabs.map((key) => el("button", {
      type: "button", class: "vtab", "aria-pressed": String(view.tab === key),
      onclick: () => { view.tab = key; view.adding = false; note = ""; render(); },
    }, T("tab_" + key)))),
    tabBody(v),
    vehicleDetailsBlock(v));
}

function tabBody(v) {
  if (view.tab === "services") return servicesTab(v);
  if (view.tab === "fuel") return fuelTab(v);
  if (view.tab === "expenses") return expensesTab(v);
  if (view.tab === "documents") return documentsTab(v);
  return remindersTab(v);
}

function remindersTab(v) {
  const ev = statusOf(v);
  const list = v.reminders.map((r) => {
    const st = ev.reminders.find((x) => x.id === r.id) || { status: "unknown", text: T("no_record") };
    const every = r.mode === "km" ? T("every_km", { n: fmtNum(r.intervalKm) }) : T("every_months", { n: r.intervalMonths });
    return item(r.name, chip(st.status), [st.text, every], [
      el("button", {
        type: "button",
        onclick: () => {
          r.lastDate = todayVN();
          if (r.mode === "km") r.lastKm = currentKm(v);
          persist();
        },
      }, T("done_today")),
      delBtn(() => { v.reminders = v.reminders.filter((x) => x.id !== r.id); persist(); }),
    ]);
  });
  const add = addBlock(T("add_reminder"), [
    { name: "name", label: T("f_name"), placeholder: T("ph_reminder_name") },
    { name: "mode", label: T("f_repeat_by"), options: [{ value: "km", label: T("f_repeat_km") }, { value: "months", label: T("f_repeat_months") }] },
    { name: "intervalKm", label: T("f_every_km"), type: "number", inputmode: "numeric" },
    { name: "intervalMonths", label: T("f_every_months"), type: "number", inputmode: "numeric" },
    { name: "lastDate", label: T("f_last_done_date"), type: "date" },
    { name: "lastKm", label: T("f_last_done_km"), type: "number", inputmode: "numeric" },
  ], T("save_reminder"), (vals) => {
    if (!vals.name) return T("err_name_reminder");
    if (vals.mode === "km" && toNum(vals.intervalKm) == null) return T("err_km_interval");
    if (vals.mode === "months" && toNum(vals.intervalMonths) == null) return T("err_month_interval");
    v.reminders.push({
      id: uid(), name: vals.name, mode: vals.mode,
      intervalKm: toNum(vals.intervalKm) ?? "", intervalMonths: toNum(vals.intervalMonths) ?? "",
      lastDate: vals.lastDate, lastKm: toNum(vals.lastKm) ?? "",
    });
    persist();
    return "";
  });
  return el("div", {}, list, add);
}

function servicesTab(v) {
  const list = [...v.services].sort((a, b) => (a.date < b.date ? 1 : -1)).map((s) => item(
    s.type,
    s.cost ? el("span", { class: "vmuted" }, fmtMoney(s.cost)) : null,
    [s.date, s.km !== "" && s.km != null ? fmtKm(s.km) : "", s.notes],
    [delBtn(() => { v.services = v.services.filter((x) => x.id !== s.id); persist(); })]
  ));
  const add = addBlock(T("add_service"), [
    { name: "date", label: T("f_date"), type: "date", value: todayVN() },
    { name: "type", label: T("f_what_done"), placeholder: T("ph_service_name") },
    { name: "km", label: T("f_km"), type: "number", inputmode: "numeric" },
    { name: "cost", label: T("f_cost"), type: "number", inputmode: "numeric" },
    { name: "reminder", label: T("f_update_reminder"), options: [{ value: "", label: T("not_linked") }, ...v.reminders.map((r) => ({ value: r.id, label: r.name }))] },
    { name: "notes", label: T("f_notes") },
  ], T("save_service"), (vals) => {
    if (!vals.date || !vals.type) return T("err_service");
    const km = toNum(vals.km);
    v.services.push({ id: uid(), date: vals.date, type: vals.type, km: km ?? "", cost: toNum(vals.cost) ?? 0, notes: vals.notes });
    if (km != null) v.odometer = Math.max(Number(v.odometer) || 0, km);
    const r = vals.reminder ? v.reminders.find((x) => x.id === vals.reminder) : null;
    if (r) {
      r.lastDate = vals.date;
      if (km != null) r.lastKm = km;
    }
    persist();
    return "";
  });
  return el("div", {}, list, add);
}

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
    [delBtn(() => { v.fuel = v.fuel.filter((x) => x.id !== f.id); persist(); })]
  ));
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
    v.fuel.push({ id: uid(), date: vals.date, km, liters, cost: toNum(vals.cost) ?? 0, fuelType: vals.fuelType, note: vals.note });
    v.odometer = Math.max(Number(v.odometer) || 0, km);
    persist();
    return "";
  });
  return el("div", {},
    el("p", { class: "vmuted" }, T("consumption_note")),
    list, add);
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
  const list = [...v.expenses].sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => item(
    catLabel(e.category),
    el("span", { class: "vmuted" }, fmtMoney(e.amount)),
    [e.date, e.note],
    [delBtn(() => { v.expenses = v.expenses.filter((x) => x.id !== e.id); persist(); })]
  ));
  const add = addBlock(T("add_expense"), [
    { name: "date", label: T("f_date"), type: "date", value: today },
    { name: "category", label: T("f_category"), options: EXP_CATS.map((c) => ({ value: c, label: catLabel(c) })) },
    { name: "amount", label: T("f_amount"), type: "number", inputmode: "numeric" },
    { name: "note", label: T("f_notes") },
  ], T("save_expense"), (vals) => {
    const amount = toNum(vals.amount);
    if (!vals.date || amount == null) return T("err_amount");
    v.expenses.push({ id: uid(), date: vals.date, category: vals.category, amount, note: vals.note });
    persist();
    return "";
  });
  return el("div", {},
    el("p", { class: "vmuted" }, T("this_month", { m: fmtMoney(monthTotal), y: fmtMoney(yearTotal) })),
    list, add);
}

function documentsTab(v) {
  const ev = statusOf(v);
  const list = v.documents.map((d) => {
    const st = ev.documents.find((x) => x.id === d.id) || { status: "unknown", text: "", latest: false };
    return item(
      docLabel(d.type),
      chip(st.latest ? st.status : "unknown", st.latest ? null : T("status_older")),
      [
        T("issued_line", { issued: d.issued || T("dash"), expires: d.expires || T("dash") }),
        st.latest ? st.text : "",
      ],
      [delBtn(() => { v.documents = v.documents.filter((x) => x.id !== d.id); persist(); })]
    );
  });
  const add = addBlock(T("add_document"), [
    { name: "type", label: T("f_document"), options: DOC_TYPES.map((x) => ({ value: x, label: docLabel(x) })) },
    { name: "issued", label: T("f_issued_date"), type: "date" },
    { name: "expires", label: T("f_expiry_date"), type: "date" },
    { name: "note", label: T("f_notes") },
  ], T("save_document"), (vals) => {
    if (!vals.type) return T("err_doc_type");
    v.documents.push({ id: uid(), type: vals.type, issued: vals.issued, expires: vals.expires, note: vals.note });
    persist();
    return "";
  });
  return el("div", {}, list, add);
}

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

function openReport() {
  view = { name: "report", vehicleId: null, tab: "reminders", adding: false, editing: false };
  note = "";
  render();
  window.scrollTo(0, 0);
}

function reportRows() {
  const rows = [];
  for (const v of vehicles) {
    const ev = statusOf(v);
    for (const r of ev.reminders) {
      if (r.status === "overdue" || r.status === "soon") {
        rows.push({ vehicle: v, title: r.name, status: r.status, text: r.text, kind: "reminder" });
      }
    }
    for (const d of ev.documents) {
      if (d.latest && (d.status === "overdue" || d.status === "soon")) {
        rows.push({ vehicle: v, title: docLabel(d.type), status: d.status, text: d.text, kind: "document" });
      }
    }
  }
  rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));
  return rows;
}

function reportView() {
  const rows = reportRows();
  const overdue = rows.filter((r) => r.status === "overdue").length;
  const soon = rows.length - overdue;
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
          g.items.map((r) => item(r.title, chip(r.status), [
            r.text,
            T(r.kind === "reminder" ? "report_kind_reminder" : "report_kind_document"),
          ], []))))
      : el("p", { class: "vmuted" }, T("report_none")));
}

function render() {
  if (view.name === "detail" && !vehicles.some((x) => x.id === view.vehicleId)) {
    view = { name: "garage", vehicleId: null, tab: "reminders", adding: false, editing: false };
  }
  root.replaceChildren(view.name === "detail" ? detailView() : view.name === "report" ? reportView() : garageView());
  updateTabLabel();
}

function show() {
  detectPush();
  refreshStatuses();
}

window.VehiclesApp = { show };
load();
