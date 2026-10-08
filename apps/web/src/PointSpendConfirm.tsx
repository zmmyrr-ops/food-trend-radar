import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { appFetch } from "./app-url";
import { Points } from "./Points";
import "./point-spend-confirm.css";

let opened = false;
export async function confirmPointSpend(
  title: string,
  amount: number,
  note = "任务失败自动退回积分；成功后再次生成将重新计费。",
) {
  if (opened) return false;
  opened = true;
  let balance: number | null = null;
  try {
    const response = await appFetch("/api/member");
    if (response.ok) balance = (await response.json()).balance;
  } catch {
    /* The server remains authoritative when balance cannot be loaded. */
  }
  return new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const previous = document.activeElement as HTMLElement | null;
    const root = createRoot(host);
    const finish = (confirmed: boolean) => {
      root.unmount();
      host.remove();
      opened = false;
      previous?.focus();
      resolve(confirmed);
    };
    root.render(
      <SpendDialog
        title={title}
        amount={amount}
        balance={balance}
        note={note}
        finish={finish}
      />,
    );
  });
}
function SpendDialog({
  title,
  amount,
  balance,
  note,
  finish,
}: {
  title: string;
  amount: number;
  balance: number | null;
  note: string;
  finish: (confirmed: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const insufficient = balance !== null && balance < amount;
  return (
    <dialog
      className="point-spend-dialog"
      ref={ref}
      aria-labelledby="point-spend-title"
      onCancel={(e) => {
        e.preventDefault();
        finish(false);
      }}
    >
      <div className="point-spend-head">
        <span>积分使用确认</span>
        <button type="button" aria-label="关闭" onClick={() => finish(false)}>
          ×
        </button>
      </div>
      <h2 id="point-spend-title">{title}</h2>
      <div className="point-spend-amount">
        <Points amount={amount} cost />
        <span>本次消耗</span>
      </div>
      <p>
        当前余额：
        {balance === null
          ? "暂时无法读取，以服务端校验为准"
          : `${balance} 积分`}
        {balance !== null &&
          !insufficient &&
          ` · 完成后 ${balance - amount} 积分`}
      </p>
      <p className="point-spend-note">{note}</p>
      {insufficient && <p role="alert">积分不足，本次操作不会提交。</p>}
      <div className="point-spend-actions">
        <button type="button" autoFocus onClick={() => finish(false)}>
          暂不使用
        </button>
        <button
          type="button"
          disabled={insufficient}
          onClick={() => finish(true)}
        >
          确认使用 {amount} 积分
        </button>
      </div>
    </dialog>
  );
}
