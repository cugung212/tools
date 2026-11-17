/* Vehicles tab: garage, vehicle details, services, fuel, expenses, documents, reminders and notifications */
(function () {
  "use strict";

  const KEY = "vehicles-v1";
  const DOC_TYPES = ["Registration", "Inspection", "Insurance"];
  const EXP_CATS = ["Insurance", "Parking", "Washing", "Repair", "Other"];
  const FUEL_TYPES = ["E10", "E5", "RON 92", "RON 95", "Other"];
  const LABEL = { overdue: "Overdue", soon: "Due soon", ok: "OK", unknown: "No record" };
  const PUSH_TEXT = {
    checking: "Checking notification status…",
    unsupported: "Notifications are not available in this browser. Reminders still show on this tab.",
    "needs-home": "To get notifications on iPhone: tap Share, then Add to Home Screen, and open Tools from the Home Screen.",
    denied: "Notifications are blocked for Tools. Turn them on in iPhone Settings, then Notifications, then Tools.",
    off: "Turn on notifications to get a message at 10:00 each day when a reminder is due soon or overdue.",
    on: "On. You get a message at 10:00 each day when a reminder is due soon or overdue.",
  };

  const root = document.getElementById("vehicles-root");
  let vehicles = [];
  let statuses = {};
  let pushState = "checking"; // checking | unsupported | needs-home | denied | off | on
  let view = { name: "garage", vehicleId: null, tab: "reminders", adding: false, editing: false };
  let note = "";
  let chain = Promise.resolve();

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const todayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const toNum = (s) => {
    if (s === "" || s == null) return null;
    const n = Number(String(s).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const fmtKm = (n) => (Number(n) || 0).toLocaleString("en-US") + " km";
  const fmtVND = (n) => (Number(n) || 0).toLocaleString("en-US") + " VND";
  const opts = (list) => list.map((x) => (typeof x === "string" ? { value: x, label: x } : x));

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
    const docs = () => DOC_TYPES.map((t) => ({ id: uid(), type: t, issued: "", expires: "", note: "" }));
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
    try { localStorage.setItem(KEY, JSON.stringify(vehicles)); } catch (e) {}
  }

  async function refreshStatuses() {
    try {
      const res = await fetch("/api/vehicles/status", { cache: "no-store" });
      if (res.ok) statuses = (await res.json()).statuses || {};
    } catch (e) {}
    render();
  }

  // Saves are queued one at a time; each sends the latest list.
  function persist() {
    cache();
    chain = chain
      .then(() => fetch("/api/vehicles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicles }),
      }))
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        note = "";
        return refreshStatuses();
      })
      .catch(() => {
        note = "Saved on this device. Could not reach the server yet.";
        render();
      });
    return chain;
  }

  async function load() {
    try {
      const res = await fetch("/api/vehicles", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const list = (await res.json()).vehicles || [];
      if (list.length) {
        vehicles = list;
      } else {
        vehicles = readCache() || seed();
        await persist();
        return;
      }
    } catch (e) {
      vehicles = readCache() || seed();
      note = "Showing this device's copy.";
    }
    cache();
    refreshStatuses();
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
    return el("span", { class: "vchip vchip-" + status }, label || LABEL[status]);
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
        note = "Could not turn on notifications. Try again.";
        render();
      });
  }

  function pushCard() {
    const children = [el("h2", {}, "Notifications"), el("p", { class: "vmuted" }, PUSH_TEXT[pushState])];
    if (pushState === "off") {
      children.push(el("button", { class: "primary", type: "button", onclick: enablePush }, "Turn on notifications"));
    }
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

  const delBtn = (onDelete) => el("button", { class: "vdel", type: "button", onclick: onDelete }, "Delete");

  // ---- Garage ----

  function vehicleFields(v) {
    return [
      { name: "type", label: "Type", options: [{ value: "car", label: "Car" }, { value: "scooter", label: "Scooter" }], value: v ? v.type : "car" },
      { name: "name", label: "Name", placeholder: "e.g. Kia Cerato", value: v ? v.name : "" },
      { name: "make", label: "Make", value: v ? v.make : "" },
      { name: "model", label: "Model", value: v ? v.model : "" },
      { name: "year", label: "Year", type: "number", inputmode: "numeric", value: v ? v.year : "" },
      { name: "plate", label: "Plate number", value: v ? v.plate : "" },
      { name: "odometer", label: "Current odometer (km)", type: "number", inputmode: "numeric", value: v ? v.odometer : "" },
      { name: "kmWarn", label: "Warn when within (km)", type: "number", inputmode: "numeric", value: v ? v.kmWarn : 500 },
    ];
  }

  function addVehicle(vals) {
    if (!vals.name) return "Enter a name for the vehicle.";
    vehicles.push({
      id: uid(), name: vals.name, type: vals.type || "car", make: vals.make, model: vals.model,
      year: toNum(vals.year) ?? "", plate: vals.plate,
      odometer: toNum(vals.odometer) ?? 0, kmWarn: toNum(vals.kmWarn) ?? 500,
      services: [], fuel: [], expenses: [], reminders: [],
      documents: DOC_TYPES.map((t) => ({ id: uid(), type: t, issued: "", expires: "", note: "" })),
    });
    persist();
    return "";
  }

  function garageView() {
    return el("div", {},
      el("h1", {}, "Vehicles"),
      el("p", { class: "vsub" }, vehicles.length + (vehicles.length === 1 ? " vehicle" : " vehicles")),
      note ? el("p", { class: "vnote" }, note) : null,
      pushCard(),
      vehicles.map((v) => el("button", {
        class: "vcard vcar", type: "button",
        onclick: () => openVehicle(v.id),
      },
        el("div", { class: "vrow" }, el("strong", {}, v.name), chip(vehicleStatus(v))),
        el("div", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ")),
        el("div", { class: "vmuted" }, fmtKm(currentKm(v))))),
      addBlock("Add vehicle", vehicleFields(null), "Save vehicle", addVehicle));
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
    const tabs = [["reminders", "Reminders"], ["services", "Services"], ["fuel", "Fuel"], ["expenses", "Expenses"], ["documents", "Documents"]];
    return el("div", {},
      el("button", { class: "vback", type: "button", onclick: goGarage }, "← Garage"),
      el("h1", {}, v.name),
      el("div", { class: "vrow vsubrow" },
        el("span", { class: "vmuted" }, [v.make, v.model, v.year, v.plate].filter(Boolean).join(" · ") + " · " + fmtKm(currentKm(v))),
        chip(vehicleStatus(v))),
      note ? el("p", { class: "vnote" }, note) : null,
      el("div", { class: "vtabs" }, tabs.map(([key, label]) => el("button", {
        type: "button", class: "vtab", "aria-pressed": String(view.tab === key),
        onclick: () => { view.tab = key; view.adding = false; note = ""; render(); },
      }, label))),
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
      const st = ev.reminders.find((x) => x.id === r.id) || { status: "unknown", text: "No record yet" };
      const every = r.mode === "km" ? "Every " + fmtKm(r.intervalKm) : "Every " + r.intervalMonths + " months";
      return item(r.name, chip(st.status), [st.text, every], [
        el("button", {
          type: "button",
          onclick: () => {
            r.lastDate = todayVN();
            if (r.mode === "km") r.lastKm = currentKm(v);
            persist();
          },
        }, "Done today"),
        delBtn(() => { v.reminders = v.reminders.filter((x) => x.id !== r.id); persist(); }),
      ]);
    });
    const add = addBlock("Add reminder", [
      { name: "name", label: "Name", placeholder: "e.g. Engine oil change" },
      { name: "mode", label: "Repeat by", options: [{ value: "km", label: "Kilometres" }, { value: "months", label: "Months" }] },
      { name: "intervalKm", label: "Every (km)", type: "number", inputmode: "numeric" },
      { name: "intervalMonths", label: "Every (months)", type: "number", inputmode: "numeric" },
      { name: "lastDate", label: "Last done date", type: "date" },
      { name: "lastKm", label: "Last done at (km)", type: "number", inputmode: "numeric" },
    ], "Save reminder", (vals) => {
      if (!vals.name) return "Enter a name for the reminder.";
      if (vals.mode === "km" && toNum(vals.intervalKm) == null) return "Enter how many km between each time.";
      if (vals.mode === "months" && toNum(vals.intervalMonths) == null) return "Enter how many months between each time.";
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
      s.cost ? el("span", { class: "vmuted" }, fmtVND(s.cost)) : null,
      [s.date, s.km !== "" && s.km != null ? fmtKm(s.km) : "", s.notes],
      [delBtn(() => { v.services = v.services.filter((x) => x.id !== s.id); persist(); })]
    ));
    const add = addBlock("Add service", [
      { name: "date", label: "Date", type: "date", value: todayVN() },
      { name: "type", label: "What was done", placeholder: "e.g. Engine oil change" },
      { name: "km", label: "Odometer (km)", type: "number", inputmode: "numeric" },
      { name: "cost", label: "Cost (VND)", type: "number", inputmode: "numeric" },
      { name: "reminder", label: "Update reminder", options: [{ value: "", label: "Not linked" }, ...v.reminders.map((r) => ({ value: r.id, label: r.name }))] },
      { name: "notes", label: "Notes" },
    ], "Save service", (vals) => {
      if (!vals.date || !vals.type) return "Enter the date and what was done.";
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
        f.liters + " L · " + fmtVND(f.cost) + " · " + f.fuelType + (cons[f.id] ? " · " + cons[f.id].toFixed(1) + " L/100 km" : ""),
        f.note,
      ],
      [delBtn(() => { v.fuel = v.fuel.filter((x) => x.id !== f.id); persist(); })]
    ));
    const add = addBlock("Add fuel", [
      { name: "date", label: "Date", type: "date", value: todayVN() },
      { name: "km", label: "Odometer (km)", type: "number", inputmode: "numeric" },
      { name: "liters", label: "Litres", type: "number", inputmode: "decimal" },
      { name: "cost", label: "Total cost (VND)", type: "number", inputmode: "numeric" },
      { name: "fuelType", label: "Fuel type", options: FUEL_TYPES },
      { name: "note", label: "Notes" },
    ], "Save fuel", (vals) => {
      const km = toNum(vals.km);
      const liters = toNum(vals.liters);
      if (!vals.date || km == null || liters == null) return "Enter the date, odometer and litres.";
      v.fuel.push({ id: uid(), date: vals.date, km, liters, cost: toNum(vals.cost) ?? 0, fuelType: vals.fuelType, note: vals.note });
      v.odometer = Math.max(Number(v.odometer) || 0, km);
      persist();
      return "";
    });
    return el("div", {},
      el("p", { class: "vmuted" }, "Consumption assumes the tank was filled full each time."),
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
      e.category,
      el("span", { class: "vmuted" }, fmtVND(e.amount)),
      [e.date, e.note],
      [delBtn(() => { v.expenses = v.expenses.filter((x) => x.id !== e.id); persist(); })]
    ));
    const add = addBlock("Add expense", [
      { name: "date", label: "Date", type: "date", value: today },
      { name: "category", label: "Category", options: EXP_CATS },
      { name: "amount", label: "Amount (VND)", type: "number", inputmode: "numeric" },
      { name: "note", label: "Notes" },
    ], "Save expense", (vals) => {
      const amount = toNum(vals.amount);
      if (!vals.date || amount == null) return "Enter the date and amount.";
      v.expenses.push({ id: uid(), date: vals.date, category: vals.category, amount, note: vals.note });
      persist();
      return "";
    });
    return el("div", {},
      el("p", { class: "vmuted" }, "This month: " + fmtVND(monthTotal) + " · This year: " + fmtVND(yearTotal)),
      list, add);
  }

  function documentsTab(v) {
    const ev = statusOf(v);
    const list = v.documents.map((d) => {
      const st = ev.documents.find((x) => x.id === d.id) || { status: "unknown", text: "", latest: false };
      return item(
        d.type,
        chip(st.latest ? st.status : "unknown", st.latest ? null : "Older"),
        ["Issued: " + (d.issued || "—") + " · Expires: " + (d.expires || "—"), st.latest ? st.text : ""],
        [delBtn(() => { v.documents = v.documents.filter((x) => x.id !== d.id); persist(); })]
      );
    });
    const add = addBlock("Add document", [
      { name: "type", label: "Document", options: DOC_TYPES },
      { name: "issued", label: "Issued date", type: "date" },
      { name: "expires", label: "Expiry date", type: "date" },
      { name: "note", label: "Notes" },
    ], "Save document", (vals) => {
      if (!vals.type) return "Choose a document type.";
      v.documents.push({ id: uid(), type: vals.type, issued: vals.issued, expires: vals.expires, note: vals.note });
      persist();
      return "";
    });
    return el("div", {}, list, add);
  }

  function vehicleDetailsBlock(v) {
    if (!view.editing) {
      return el("div", { class: "vactions vdetails" },
        el("button", { type: "button", onclick: () => { view.editing = true; note = ""; render(); } }, "Edit vehicle details"));
    }
    return el("div", {},
      el("h2", {}, "Vehicle details"),
      form(vehicleFields(v), "Save details", (vals) => {
        if (!vals.name) return "Enter a name for the vehicle.";
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
          if (!confirm("Delete " + v.name + " and all its records?")) return;
          vehicles = vehicles.filter((x) => x.id !== v.id);
          goGarage();
          persist();
        },
      }, "Delete vehicle"));
  }

  function render() {
    if (view.name === "detail" && !vehicles.some((x) => x.id === view.vehicleId)) {
      view = { name: "garage", vehicleId: null, tab: "reminders", adding: false, editing: false };
    }
    root.replaceChildren(view.name === "detail" ? detailView() : garageView());
  }

  function show() {
    detectPush();
    refreshStatuses();
  }

  window.VehiclesApp = { show };
  load();
})();
