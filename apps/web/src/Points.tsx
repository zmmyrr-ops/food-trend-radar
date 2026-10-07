import { useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";
export function Points({
  amount,
  cost = false,
}: {
  amount: number | string;
  cost?: boolean;
}) {
  return (
    <span className={`points-badge${cost ? " points-cost" : ""}`}>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
        <path d="m13 6-5 7h4l-1 5 5-7h-4z" fill="currentColor" />
      </svg>
      <span>
        {cost ? "−" : ""}
        {amount}
        <small>积分</small>
      </span>
    </span>
  );
}
export function PointsBalance() {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void appFetch("/api/member")
        .then(async (r) => {
          if (r.ok) {
            const d = await r.json();
            if (live) setBalance(d.balance);
          }
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("points-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("points-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return (
    <a
      className="points-balance-link"
      href={appUrl("/?tab=workspace&section=member")}
      aria-label={`可用积分 ${balance ?? "加载中"}`}
    >
      <Points amount={balance ?? "—"} />
    </a>
  );
}
