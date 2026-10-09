import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";
import { initSubscriptionMessages } from "./brand-subscriptions.js";
import { changePoints } from "./points.js";

export async function initBrandBoost(db: PGlite) {
  await initSubscriptionMessages(db);
  await db.exec(`CREATE TABLE IF NOT EXISTS brand_boost_jobs(
    id uuid PRIMARY KEY,brand_id uuid NOT NULL,run_id uuid NOT NULL,
    votes int NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'queued',
    created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz);
    CREATE UNIQUE INDEX IF NOT EXISTS brand_boost_active ON brand_boost_jobs(brand_id) WHERE state IN ('queued','running');
    CREATE TABLE IF NOT EXISTS brand_boost_requests(
    id uuid PRIMARY KEY,owner_id uuid NOT NULL,brand_id uuid NOT NULL,job_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'charged',created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS brand_boost_daily ON brand_boost_requests(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS coupon_tasks_boost_cooldown ON coupon_tasks(brand_id,completed_at DESC) WHERE state='complete';`);
}

export function createBrandBoost(
  db: PGlite,
  signature: (name: string, aliases: string[], category: string) => string,
  kick: () => void,
) {
  async function settle() {
    await db.transaction(async (tx) => {
      const rows = (
        await tx.query<any>(`SELECT j.*,t.state AS task_state,b.active,b.name AS brand_name,s.pause_reason
        FROM brand_boost_jobs j JOIN coupon_tasks t ON t.run_id=j.run_id AND t.brand_id=j.brand_id
        JOIN brands b ON b.id=j.brand_id CROSS JOIN coupon_settings s
        WHERE j.state IN ('queued','running') AND (t.state<>'queued' OR NOT b.active OR s.pause_reason IS NOT NULL)`)
      ).rows;
      for (const j of rows) {
        const ok = j.task_state === "complete";
        if (!ok) {
          const requests = (
            await tx.query<any>(
              "SELECT * FROM brand_boost_requests WHERE job_id=$1 AND state='charged'",
              [j.id],
            )
          ).rows;
          for (const r of requests)
            await changePoints(
              tx,
              r.owner_id,
              20,
              "品牌加速未完成，退回积分",
              `boost-refund:${r.id}`,
            );
        }
        const count = ok
          ? (
              await tx.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM coupon_diffs WHERE run_id=$1 AND brand_id=$2 AND kind='NEW_OBSERVED' AND new_payload->>'identity'='name_match'",
                [j.run_id, j.brand_id],
              )
            ).rows[0].n
          : 0;
        const title = ok
          ? count > 0
            ? `加速刷新完成，发现${count}张新券，点击查看。`
            : "加速刷新完成，暂无新券，点击查看品牌最新券信息。"
          : "本次加速未完成，20积分及使用次数已退回。";
        const recipients = (
          await tx.query<{ owner_id: string }>(
            "SELECT DISTINCT owner_id FROM brand_boost_requests WHERE job_id=$1 AND state='charged'",
            [j.id],
          )
        ).rows;
        for (const r of recipients)
          await tx.query(
            "INSERT INTO subscription_messages(id,owner_id,brand_id,product_id,kind,event_key,brand_name,title) VALUES($1,$2,$3,'',$4,$5,$6,$7) ON CONFLICT DO NOTHING",
            [
              randomUUID(),
              r.owner_id,
              j.brand_id,
              ok ? "boost_complete" : "boost_failed",
              `boost:${j.id}`,
              j.brand_name,
              title,
            ],
          );
        await tx.query(
          "UPDATE brand_boost_requests SET state=$2 WHERE job_id=$1",
          [j.id, ok ? "complete" : "refunded"],
        );
        await tx.query("UPDATE brand_boost_jobs SET state=$2 WHERE id=$1", [
          j.id,
          ok ? "complete" : "failed",
        ]);
      }
    });
  }
  async function enqueue(owner: string, brand: string, requestId: string) {
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [owner]);
      const duplicate = (
        await tx.query<any>("SELECT * FROM brand_boost_requests WHERE id=$1", [
          requestId,
        ])
      ).rows[0];
      if (duplicate) {
        if (duplicate.owner_id !== owner || duplicate.brand_id !== brand)
          throw Error("请求标识无效");
        return { job_id: duplicate.job_id, duplicate: true };
      }
      const settings = (
        await tx.query<any>("SELECT * FROM coupon_settings WHERE id=1")
      ).rows[0];
      if (!settings?.enabled || settings.pause_reason)
        throw Error("采集暂不可用，请稍后再试");
      const b = (
        await tx.query<any>(
          "SELECT * FROM brands WHERE id=$1 AND active=true FOR UPDATE",
          [brand],
        )
      ).rows[0];
      if (!b) throw Error("品牌不存在或未启用");
      const fresh = (
        await tx.query(
          "SELECT 1 FROM coupon_tasks WHERE brand_id=$1 AND state='complete' AND completed_at>now()-interval '30 minutes' LIMIT 1",
          [brand],
        )
      ).rows.length;
      if (fresh) throw Error("已经是最新数据，半小时内无需加速");
      const used = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM brand_boost_requests WHERE owner_id=$1 AND state<>'refunded' AND created_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
          [owner],
        )
      ).rows[0].n;
      if (used >= 2) throw Error("今天已使用2次品牌加速，请明天再试");
      let job = (
        await tx.query<any>(
          "SELECT * FROM brand_boost_jobs WHERE brand_id=$1 AND state IN ('queued','running')",
          [brand],
        )
      ).rows[0];
      if (job) {
        if (job.state === "running") throw Error("品牌正在刷新，请稍候");
        const own = (
          await tx.query(
            "SELECT 1 FROM brand_boost_requests WHERE job_id=$1 AND owner_id=$2 AND state='charged'",
            [job.id, owner],
          )
        ).rows.length;
        if (own) throw Error("你已加速该品牌，请等待刷新完成");
        await tx.query(
          "UPDATE brand_boost_jobs SET votes=votes+1 WHERE id=$1",
          [job.id],
        );
      } else {
        // Reuse an untouched scheduled task. Never create a second collector.
        let task = (
          await tx.query<any>(
            `SELECT t.run_id FROM coupon_tasks t JOIN coupon_runs r ON r.id=t.run_id WHERE t.brand_id=$1 AND t.state='queued' AND r.status='running' ORDER BY r.started_at LIMIT 1`,
            [brand],
          )
        ).rows[0];
        if (!task) {
          const run = randomUUID();
          await tx.query(
            "INSERT INTO coupon_runs(id,status) VALUES($1,'running')",
            [run],
          );
          await tx.query(
            "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,category,query_signature,position) VALUES($1,$2,$3,$4,$5,$6,-1)",
            [
              run,
              brand,
              b.name,
              JSON.stringify(b.aliases),
              b.category,
              signature(b.name, b.aliases, b.category),
            ],
          );
          task = { run_id: run };
        }
        job = { id: randomUUID(), run_id: task.run_id };
        await tx.query(
          "INSERT INTO brand_boost_jobs(id,brand_id,run_id) VALUES($1,$2,$3)",
          [job.id, brand, task.run_id],
        );
      }
      await changePoints(
        tx,
        owner,
        -20,
        `品牌加速刷新 · ${b.name}`,
        `boost:${requestId}`,
      );
      await tx.query(
        "INSERT INTO brand_boost_requests(id,owner_id,brand_id,job_id) VALUES($1,$2,$3,$4)",
        [requestId, owner, brand, job.id],
      );
      return { job_id: job.id, remaining: 1 - used };
    });
  }
  function register(app: Express) {
    app.post("/api/v3/brand-boost", async (req, res) => {
      const v = z
        .object({ brand_id: z.uuid(), request_id: z.uuid() })
        .strict()
        .parse(req.body);
      try {
        const result = await enqueue(ownerOf(req), v.brand_id, v.request_id);
        kick();
        res.status(202).json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : "暂时无法加速";
        res.status(409).json({
          error: {
            message:
              message === "POINTS_INSUFFICIENT"
                ? "积分不足，需要20积分"
                : message,
          },
        });
      }
    });
    app.get("/api/v3/brand-boost", async (req, res) => {
      const owner = ownerOf(req);
      const used = (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM brand_boost_requests WHERE owner_id=$1 AND state<>'refunded' AND created_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
          [owner],
        )
      ).rows[0].n;
      const jobs = (
        await db.query(
          `SELECT j.brand_id,j.state,j.votes,
        row_number() OVER(ORDER BY (j.state='running') DESC,j.votes DESC,j.created_at,j.id)::int AS position,
        EXISTS(SELECT 1 FROM brand_boost_requests r WHERE r.job_id=j.id AND r.owner_id=$1 AND r.state='charged') AS mine
        FROM brand_boost_jobs j WHERE j.state IN ('queued','running') ORDER BY position`,
          [owner],
        )
      ).rows;
      res.json({ remaining: Math.max(0, 2 - used), jobs });
    });
  }
  return { register, settle, enqueue };
}
