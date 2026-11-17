// Service worker: shows the vehicle reminder notification when a push arrives.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(showReminders());
});

async function showReminders() {
  let data = { title: "Vehicle reminders", body: "" };
  try {
    const res = await fetch("/api/vehicles/due", { cache: "no-store" });
    if (res.ok) data = await res.json();
  } catch (e) {}
  await self.registration.showNotification(data.title, {
    body: data.body,
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
