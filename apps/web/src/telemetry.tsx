import { useEffect } from "react";
import { appUrl } from "./app-url";

const queue: { id: string; name: string; page: string; channel: string }[] = [];
let sending = false;
let lastPage = "",
  lastPageAt = 0;
export function track(name: string, page = currentPage()) {
  try {
    if (queue.length < 200)
      queue.push({ id: crypto.randomUUID(), name, page, channel: "web" });
  } catch {
    /* Optional analytics never interrupts the page. */
  }
}
function currentPage() {
  const p = new URLSearchParams(location.search);
  return p.get("studio") === "1"
    ? "studio"
    : ([
        "radar",
        "workspace",
        "reports",
        "brands",
        "accounts",
        "analytics",
        "events",
        "import",
        "sources",
        "admission",
      ].includes(p.get("tab") || "")
        ? p.get("tab")!
        : "radar") +
        (p.get("tab") === "workspace"
          ? "/" +
            ([
              "plans",
              "videos",
              "subscriptions",
              "blacklist",
              "account",
            ].includes(p.get("section") || "")
              ? p.get("section")!
              : "plans")
          : "");
}
async function flush() {
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, 30);
  try {
    const r = await fetch(appUrl("/api/v3/analytics/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
    if (r.status >= 500) queue.unshift(...batch.slice(0, 200 - queue.length));
  } catch {
    queue.unshift(...batch.slice(0, 200 - queue.length));
  } finally {
    sending = false;
  }
}
export function PageAnalytics() {
  useEffect(() => {
    let previous = "";
    const page = () => {
      const key = currentPage();
      if (key !== previous) {
        previous = key;
        if (key !== lastPage || Date.now() - lastPageAt > 1000) {
          lastPage = key;
          lastPageAt = Date.now();
          track("page_view", key);
        }
      }
    };
    const replace = history.replaceState,
      push = history.pushState;
    history.replaceState = function (...args) {
      replace.apply(this, args);
      page();
    };
    history.pushState = function (...args) {
      push.apply(this, args);
      page();
    };
    page();
    const timer = setInterval(() => void flush(), 15000);
    const hide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("popstate", page);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(timer);
      history.replaceState = replace;
      history.pushState = push;
      window.removeEventListener("popstate", page);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  return null;
}
