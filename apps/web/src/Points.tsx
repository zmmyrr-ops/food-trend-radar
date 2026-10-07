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
      <img
        className="points-icon"
        src={appUrl("/branding/points-token-v2.png")}
        width="22"
        height="22"
        alt=""
        aria-hidden="true"
      />
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
