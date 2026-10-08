import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
export type PointDB = Pick<PGlite, "query">;
export async function setupPoints(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS point_wallets(owner_id uuid PRIMARY KEY REFERENCES accounts(id),balance int NOT NULL DEFAULT 0 CHECK(balance>=0));
 CREATE TABLE IF NOT EXISTS point_entries(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES accounts(id),amount int NOT NULL,reason text NOT NULL,event_key text UNIQUE NOT NULL,hidden boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS point_entries_owner ON point_entries(owner_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS point_operations(key text PRIMARY KEY,owner_id uuid NOT NULL,result jsonb,state text NOT NULL DEFAULT 'pending');
 CREATE TABLE IF NOT EXISTS account_migrations(name text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());`);
  await db.transaction(async (tx) => {
    const done = await tx.query(
      "INSERT INTO account_migrations(name) VALUES('points-existing-500-v1') ON CONFLICT DO NOTHING RETURNING name",
    );
    if (!done.rows.length) return;
    const users = await tx.query<{ id: string }>("SELECT id FROM accounts");
    for (const a of users.rows)
      await changePoints(tx, a.id, 500, "老用户初始赠送", `welcome:${a.id}`);
  });
  const pending = (
    await db.query<{ key: string }>(
      "SELECT key FROM point_operations WHERE state='pending'",
    )
  ).rows;
  for (const op of pending) {
    await refundPoints(db, op.key);
    await db.query("UPDATE point_operations SET state='failed' WHERE key=$1", [
      op.key,
    ]);
  }
  const has = (
    await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='coupon_media_jobs' AND column_name='point_charge_key'",
    )
  ).rows.length;
  if (has) {
    const jobs = (
      await db.query<{ id: string; point_charge_key: string; empty: boolean }>(
        "SELECT id,point_charge_key,jsonb_array_length(resources)<=point_before_count AS empty FROM coupon_media_jobs WHERE point_charge_key IS NOT NULL AND state NOT IN ('queued','running')",
      )
    ).rows;
    for (const job of jobs) {
      if (job.empty) await refundPoints(db, job.point_charge_key);
      await db.query(
        "UPDATE coupon_media_jobs SET point_charge_key=NULL WHERE id=$1",
        [job.id],
      );
    }
  }
}
export async function changePoints(
  tx: PointDB,
  owner: string,
  amount: number,
  reason: string,
  key: string,
  hidden = false,
) {
  await tx.query(
    "INSERT INTO point_wallets(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    [owner],
  );
  await tx.query(
    "SELECT owner_id FROM point_wallets WHERE owner_id=$1 FOR UPDATE",
    [owner],
  );
  const existing = await tx.query(
    "SELECT id FROM point_entries WHERE event_key=$1",
    [key],
  );
  if (existing.rows.length) return false;
  const out = await tx.query(
    "UPDATE point_wallets SET balance=balance+$2 WHERE owner_id=$1 AND balance+$2>=0 RETURNING balance",
    [owner, amount],
  );
  if (!out.rows.length) throw Error("POINTS_INSUFFICIENT");
  await tx.query(
    "INSERT INTO point_entries(id,owner_id,amount,reason,event_key,hidden) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), owner, amount, reason, key, hidden],
  );
  return true;
}
export async function refundPoints(db: PGlite, key: string) {
  await db.transaction(async (tx) => {
    const row = (
      await tx.query<{ owner_id: string; amount: number; reason: string }>(
        "SELECT owner_id,amount,reason FROM point_entries WHERE event_key=$1 AND amount<0",
        [key],
      )
    ).rows[0];
    if (row)
      await changePoints(
        tx,
        row.owner_id,
        -row.amount,
        `${row.reason}退回`,
        `refund:${key}`,
      );
  });
}

/** One reward per account and Shanghai calendar day, protected by the wallet lock. */
export async function grantDailyLoginPoints(
  db: PGlite,
  owner: string,
  now = new Date(),
) {
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  return db.transaction(async (tx) => {
    const awarded = await changePoints(
      tx,
      owner,
      20,
      "每日登录奖励",
      `daily-login:${owner}:${day}`,
    );
    const wallet = (
      await tx.query<{ balance: number }>(
        "SELECT balance FROM point_wallets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0];
    return { awarded, amount: awarded ? 20 : 0, balance: wallet.balance, day };
  });
}
