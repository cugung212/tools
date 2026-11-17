// Cloudflare Worker: serves the API. Everything else is the page in public/.
// Needs in the project settings (see wrangler.toml):
//   - KV namespace binding TODOS
//   - Variables VAPID_PUBLIC_KEY and VAPID_SUBJECT
//   - Secret VAPID_PRIVATE_JWK
// Cron trigger runs daily at 03:00 UTC (10:00 in Vietnam).
import { computeStatuses, notificationSummary } from "./reminders.js";
import { LANGS } from "../public/i18n.js";

const MAX_BYTES = 1024 * 1024;
const MAX_VEHICLE_BYTES = 2 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function todayVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function validTasks(list) {
  return (
    Array.isArray(list) &&
    list.length <= 5000 &&
    list.every(
      (t) =>
        t &&
        typeof t.id === "string" && t.id.length <= 64 &&
        typeof t.text === "string" && t.text.length <= 500 &&
        typeof t.done === "boolean" &&
        (t.priority === undefined || typeof t.priority === "boolean") &&
        (t.doneAt === null || typeof t.doneAt === "number")
    )
  );
}

function validPickCount(n) {
  return Number.isInteger(n) && n >= 1 && n <= 999;
}

function validVehicles(list) {
  return (
    Array.isArray(list) &&
    list.length <= 50 &&
    list.every(
      (v) =>
        v &&
        typeof v.id === "string" && v.id.length <= 64 &&
        typeof v.name === "string" && v.name.length <= 80 &&
        Array.isArray(v.services) && Array.isArray(v.fuel) && Array.isArray(v.expenses) &&
        Array.isArray(v.reminders) && Array.isArray(v.documents)
    )
  );
}

async function loadVehicles(env) {
  const raw = await env.TODOS.get("vehicles");
  return raw ? JSON.parse(raw) : [];
}

async function loadLang(env) {
  const raw = await env.TODOS.get("lang");
  return LANGS.includes(raw) ? raw : "en";
}

async function loadSubs(env) {
  const raw = await env.TODOS.get("push:subs");
  return raw ? JSON.parse(raw) : [];
}

async function handleTodos(request, env) {
  if (request.method === "GET") {
    const raw = await env.TODOS.get("list");
    const pick = await env.TODOS.get("pickCount");
    return json({ tasks: raw ? JSON.parse(raw) : [], pickCount: pick ? Number(pick) : null });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: "too large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: "invalid json" }, 400); }
    if (!validTasks(body && body.tasks)) return json({ error: "invalid list" }, 400);
    if (body.pickCount !== undefined && !validPickCount(body.pickCount)) return json({ error: "invalid pick count" }, 400);
    await env.TODOS.put("list", JSON.stringify(body.tasks));
    if (body.pickCount !== undefined) await env.TODOS.put("pickCount", String(body.pickCount));
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

async function handleVehicles(request, env) {
  if (request.method === "GET") return json({ vehicles: await loadVehicles(env), lang: await loadLang(env) });
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_VEHICLE_BYTES) return json({ error: "too large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: "invalid json" }, 400); }
    if (!validVehicles(body && body.vehicles)) return json({ error: "invalid vehicles" }, 400);
    if (body.lang !== undefined && !LANGS.includes(body.lang)) return json({ error: "invalid language" }, 400);
    await env.TODOS.put("vehicles", JSON.stringify(body.vehicles));
    if (body.lang !== undefined) await env.TODOS.put("lang", body.lang);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

async function handleSubscribe(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "invalid json" }, 400); }
  const s = body && body.subscription;
  if (
    !s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") ||
    !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string"
  ) {
    return json({ error: "invalid subscription" }, 400);
  }
  const subs = await loadSubs(env);
  if (!subs.some((x) => x.endpoint === s.endpoint) && subs.length < 50) {
    subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  }
  await env.TODOS.put("push:subs", JSON.stringify(subs));
  return json({ ok: true });
}

// ---- Web Push (empty messages: the phone fetches the reminder text itself) ----

function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlText = (text) => b64urlBytes(new TextEncoder().encode(text));

async function vapidAuthorization(endpoint, env) {
  const header = b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64urlText(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  }));
  const key = await crypto.subtle.importKey(
    "jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)
  );
  return `vapid t=${header}.${payload}.${b64urlBytes(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function pushEmpty(endpoint, env) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { TTL: "86400", Urgency: "normal", Authorization: await vapidAuthorization(endpoint, env) },
    });
    return res.status;
  } catch (e) {
    console.error("Push failed", e);
    return 0;
  }
}

async function sendDailyReminders(env) {
  const summary = notificationSummary(await loadVehicles(env), todayVN(), await loadLang(env));
  const items = summary.items;
  if (!items.length) return;
  const subs = await loadSubs(env);
  const keep = [];
  for (const sub of subs) {
    const status = await pushEmpty(sub.endpoint, env);
    if (status !== 404 && status !== 410) keep.push(sub); // remove subscriptions that no longer work
  }
  if (keep.length !== subs.length) await env.TODOS.put("push:subs", JSON.stringify(keep));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/todos") return handleTodos(request, env);
    if (url.pathname === "/api/vehicles") return handleVehicles(request, env);
    if (url.pathname === "/api/vehicles/status" && request.method === "GET") {
      return json({ statuses: computeStatuses(await loadVehicles(env), todayVN(), await loadLang(env)) });
    }
    if (url.pathname === "/api/vehicles/due" && request.method === "GET") {
      return json(notificationSummary(await loadVehicles(env), todayVN(), await loadLang(env)));
    }
    if (url.pathname === "/api/push/key" && request.method === "GET") {
      return json({ key: env.VAPID_PUBLIC_KEY || "" });
    }
    if (url.pathname === "/api/push/subscribe") return handleSubscribe(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  },
};
