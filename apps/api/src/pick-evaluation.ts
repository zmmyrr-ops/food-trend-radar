import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import type { combinePicks } from "./coupon-picks.js";

type Pick = ReturnType<typeof combinePicks>[number];
type Entry = { rank: number; pick: Pick; outcome: Outcome | null };
type Outcome = {
  status: "measured" | "unavailable";
  reason: string;
  observed_at: string | null;
  speed: number | null;
  speed_change: number | null;
};
const hour = 3600000;
// Compare the local sales speed observed after 72h, not a fabricated 72h order count.
export function evaluatePick(
  before: Pick,
  after: Pick | undefined,
  captured: number,
  now: number,
): Outcome | null {
  if (now < captured + 72 * hour) return null;
  const at = Date.parse(after?.observed_at ?? "");
  if (
    !after ||
    at < captured + 72 * hour ||
    at > captured + 84 * hour ||
    at > now ||
    !Number.isFinite(at)
  ) {
    return now < captured + 84 * hour
      ? null
      : {
          status: "unavailable",
          reason: "72—84小时内没有可用的后续观测",
          observed_at: null,
          speed: null,
          speed_change: null,
        };
  }
  if (
    before.brand_id !== after.brand_id ||
    before.product_id !== after.product_id ||
    before.title !== after.title ||
    before.query_signature !== after.query_signature ||
    after.content_comparison === "changed" ||
    after.speed === null
  ) {
    return {
      status: "unavailable",
      reason: "券身份、内容或后续月售统计不可比",
      observed_at: after.observed_at,
      speed: null,
      speed_change: null,
    };
  }
  return {
    status: "measured",
    reason: "72小时后的采样窗口月售展示净增速度；不是72小时新增订单或因果效果",
    observed_at: after.observed_at,
    speed: after.speed,
    speed_change: before.speed === null ? null : after.speed - before.speed,
  };
}
export function evaluationSummary(entries: Entry[]) {
  return ["top20", "remaining"].map((group) => {
    const rows = entries.filter((e) =>
      group === "top20" ? e.rank <= 20 : e.rank > 20,
    );
    const measured = rows.filter((e) => e.outcome?.status === "measured");
    return {
      group,
      total: rows.length,
      measured: measured.length,
      pending: rows.filter((e) => !e.outcome).length,
      unavailable: rows.filter((e) => e.outcome?.status === "unavailable")
        .length,
      mean_speed: measured.length
        ? measured.reduce((n, e) => n + e.outcome!.speed!, 0) / measured.length
        : null,
      positive_speed_share: measured.length
        ? measured.filter((e) => e.outcome!.speed! > 0).length / measured.length
        : null,
    };
  });
}
export async function createPickEvaluation(
  db: PGlite,
  read: () => Promise<Pick[]>,
  readOutcome: () => Promise<Pick[]> = read,
) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS coupon_pick_evaluations(slot text PRIMARY KEY,captured_at timestamptz NOT NULL,version text NOT NULL,payload jsonb NOT NULL,finished boolean NOT NULL DEFAULT false)`,
  );
  async function refresh(requestedNow?: number) {
    const now = requestedNow ?? Date.now();
    const local = new Date(now + 8 * hour).toISOString();
    const slot = `${local.slice(0, 10)}T${Number(local.slice(11, 13)) < 12 ? "00" : "12"}:00+08:00`;
    const existing = (
      await db.query("SELECT slot FROM coupon_pick_evaluations WHERE slot=$1", [
        slot,
      ])
    ).rows.length;
    const pending = (
      await db.query<{ slot: string; captured_at: string; payload: Entry[] }>(
        "SELECT slot,captured_at,payload FROM coupon_pick_evaluations WHERE NOT finished AND captured_at <= $1 ORDER BY captured_at",
        [new Date(now - 72 * hour).toISOString()],
      )
    ).rows;
    if (existing && !pending.length) return;
    const picks = await read();
    if (!existing) {
      const capturedAt = requestedNow ?? Date.now();
      const ranked = picks
        .filter(
          (p) =>
            !p.use_outlook.fully_excluded &&
            p.priority.score > 0 &&
            Date.parse(p.observed_at) <= capturedAt,
        )
        .sort(
          (a, b) =>
            b.priority.score - a.priority.score ||
            `${a.brand_id}:${a.product_id}`.localeCompare(
              `${b.brand_id}:${b.product_id}`,
            ),
        );
      // Empty startup results must not consume this half-day's observation.
      if (ranked.length)
        await db.query(
          "INSERT INTO coupon_pick_evaluations(slot,captured_at,version,payload) VALUES($1,$2,'priority-v3',$3) ON CONFLICT DO NOTHING",
          [
            slot,
            new Date(capturedAt).toISOString(),
            JSON.stringify(
              ranked.map((pick, i) => ({ rank: i + 1, pick, outcome: null })),
            ),
          ],
        );
    }
    const outcomePicks = pending.length ? await readOutcome() : [];
    const byKey = new Map(
      outcomePicks.map((p) => [`${p.brand_id}:${p.product_id}`, p]),
    );
    for (const batch of pending) {
      const entries = batch.payload.map((e) => ({
        ...e,
        outcome:
          e.outcome ??
          evaluatePick(
            e.pick,
            byKey.get(`${e.pick.brand_id}:${e.pick.product_id}`),
            Date.parse(batch.captured_at),
            now,
          ),
      }));
      await db.query(
        "UPDATE coupon_pick_evaluations SET payload=$2,finished=$3 WHERE slot=$1",
        [
          batch.slot,
          JSON.stringify(entries),
          entries.every((e) => e.outcome !== null),
        ],
      );
    }
  }
  function register(app: Express) {
    app.get("/api/v3/pick-evaluation", async (_req, res) => {
      const batches = (
        await db.query<{
          slot: string;
          captured_at: string;
          version: string;
          finished: boolean;
          payload: Entry[];
        }>(
          "SELECT * FROM coupon_pick_evaluations ORDER BY captured_at DESC LIMIT 14",
        )
      ).rows;
      res.json({
        note: "每半日首次非空榜单冻结一次；72—84小时内核对后续采样窗口速度。缺失不按零，不是爆款命中率；同品牌多券并非独立样本。",
        batches: batches.map(({ payload, ...batch }) => ({
          ...batch,
          summary: evaluationSummary(payload),
          entries: payload.slice(0, 20).map((e) => ({
            rank: e.rank,
            brand_name: e.pick.brand_name,
            product_id: e.pick.product_id,
            title: e.pick.title,
            score: e.pick.priority.score,
            speed: e.pick.speed,
            outcome: e.outcome,
          })),
        })),
      });
    });
  }
  return { refresh, register };
}
