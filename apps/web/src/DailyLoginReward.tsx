import { useEffect, useRef, useState } from "react";
import { appFetch, appUrl } from "./app-url";
import "./daily-login-reward.css";

export function DailyLoginReward() {
  const [reward, setReward] = useState<{
    amount: number;
    balance: number;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let inFlight = false;
    let checkedDay = "";
    let alive = true;
    const check = async () => {
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (
        document.visibilityState === "hidden" ||
        inFlight ||
        checkedDay === day
      )
        return;
      inFlight = true;
      try {
        const response = await appFetch("/api/member/daily-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok) return;
        const result = await response.json();
        checkedDay = result.day;
        window.dispatchEvent(new Event("points-changed"));
        if (alive && result.awarded) setReward(result);
      } catch {
        /* A reward check must not block the user's session. Retry on focus. */
      } finally {
        inFlight = false;
      }
    };
    const initial = window.setTimeout(() => {
      void check();
    }, 0);
    const resume = () => {
      void check();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(initial);
      alive = false;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    if (reward && !dialog.current?.open) dialog.current?.showModal();
  }, [reward]);
  if (!reward) return null;
  const close = () => setReward(null);
  return (
    <dialog
      ref={dialog}
      className="daily-login-reward"
      aria-labelledby="daily-reward-title"
      onCancel={close}
    >
      <button
        className="daily-reward-close"
        aria-label="关闭奖励提示"
        onClick={close}
      >
        ×
      </button>
      <div className="daily-reward-art">
        <img src={appUrl("/branding/points-token-v2.png")} alt="" />
      </div>
      <p className="daily-reward-eyebrow">每天来逛逛，灵感有奖励</p>
      <h2 id="daily-reward-title">今日登录奖励</h2>
      <div className="daily-reward-amount">
        +{reward.amount}
        <span>积分</span>
      </div>
      <p className="daily-reward-description">
        已存入你的账户，可用于素材与创作
      </p>
      <div className="daily-reward-balance">
        当前可用 <strong>{reward.balance}</strong> 积分
      </div>
      <button className="daily-reward-confirm" onClick={close}>
        开心收下
      </button>
      <small>每日首次登录可获 20 积分 · 北京时间</small>
    </dialog>
  );
}
