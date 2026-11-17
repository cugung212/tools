// Service worker: shows the vehicle reminder notification when a push arrives.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(showReminders());
});

async function showReminders() {
  let items = [];
  try {
    const res = await fetch("/api/vehicles/due", { cache: "no-store" });
    items = (await res.json()).items || [];
  } catch (e) {}
  const title = items.length
    ? `${items.length} vehicle reminder${items.length === 1 ? "" : "s"}`
    : "Vehicle reminders";
  const body = items.length
    ? items.slice(0, 5).map((i) => i.text).join("\n")
    : "Open Tools to check your vehicles.";
  await self.registration.showNotification(title, {
    body,
    tag: "vehicle-reminders",
    icon: "/icon-192.png",
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => "focus" in c);
      return win ? win.focus() : self.clients.openWindow("/");
    })
  );
});
