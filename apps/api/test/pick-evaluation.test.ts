import assert from "node:assert/strict";
import test from "node:test";
import { combinePicks } from "../src/coupon-picks.js";
import { openDatabase } from "../src/db.js";
import {
  createPickEvaluation,
  evaluatePick,
  evaluationSummary,
} from "../src/pick-evaluation.js";
import { salesTrend } from "../src/sales-heat.js";

const hour = 3600000;
const now = Date.parse("2026-09-29T06:00:00Z");
function pick(at = now) {
  const points = [0, 12].map((h, i) => ({
    run_id: String(i),
    observed_at: new Date(at - h * hour).toISOString(),
    query_signature: "query1",
    payload: {
      monthly_sales: String(120 - i * 20),
      platform_brand_id: "p",
      identity: "name_match",
      origin_price_fen: 200,
      price_min_fen: 100,
      price_max_fen: 100,
      name: "测试券",
    },
  }));
  return combinePicks(
    [
      {
        brand_id: "b",
        brand_name: "品牌",
        product_id: "1",
        title: "测试券",
        price_fen: 100,
        ...salesTrend(points, at),
      },
    ],
    [],
    at,
  )[0];
}
test("forward evaluation waits, rejects late/missing/changed evidence and preserves negative sales", () => {
  const before = pick();
  assert.equal(
    evaluatePick(before, pick(now + 71 * hour), now, now + 71 * hour),
    null,
  );
  assert.equal(evaluatePick(before, undefined, now, now + 73 * hour), null);
  assert.equal(
    evaluatePick(before, undefined, now, now + 85 * hour)?.status,
    "unavailable",
  );
  assert.equal(
    evaluatePick(before, pick(now + 85 * hour), now, now + 85 * hour)?.status,
    "unavailable",
  );
  const future = pick(now + 73 * hour);
  assert.equal(
    evaluatePick(
      before,
      { ...future, query_signature: "changed" },
      now,
      now + 73 * hour,
    )?.status,
    "unavailable",
  );
  assert.equal(
    evaluatePick(before, { ...future, speed: null }, now, now + 73 * hour)
      ?.status,
    "unavailable",
  );
  const outcome = evaluatePick(
    before,
    { ...future, speed: -2 },
    now,
    now + 73 * hour,
  )!;
  assert.equal(outcome.speed, -2);
  const summary = evaluationSummary([
    { rank: 1, pick: before, outcome },
    { rank: 2, pick: before, outcome: null },
  ]);
  assert.equal(summary[0].measured, 1);
  assert.equal(summary[0].pending, 1);
  assert.equal(summary[0].positive_speed_share, 0);
  assert.equal(summary[1].mean_speed, null);
});
test("automatic half-day samples freeze scores, survive restart and finish only after future evidence", async () => {
  const db = await openDatabase();
  let rows = [pick()];
  try {
    const service = await createPickEvaluation(db, async () => rows);
    await service.refresh(now);
    rows = [{ ...pick(), priority: { ...pick().priority, score: 99 } }];
    await service.refresh(now + hour);
    const frozen = (
      await db.query<{ payload: { pick: ReturnType<typeof pick> }[] }>(
        "SELECT payload FROM coupon_pick_evaluations",
      )
    ).rows[0].payload;
    assert.equal(frozen[0].pick.priority.score, pick().priority.score);
    rows = [pick(now + 73 * hour)];
    const restarted = await createPickEvaluation(db, async () => rows);
    await restarted.refresh(now + 73 * hour);
    const saved = (
      await db.query<{
        finished: boolean;
        payload: { outcome: { status: string } }[];
      }>(
        "SELECT finished,payload FROM coupon_pick_evaluations ORDER BY captured_at",
      )
    ).rows;
    assert.equal(saved.length, 2);
    assert.equal(saved[0].finished, true);
    assert.equal(saved[0].payload[0].outcome.status, "measured");
    assert.equal(saved[1].finished, false);
  } finally {
    await db.close();
  }
});

test("pending backtests skip ranking reads and unchanged payload writes", async () => {
  const db = await openDatabase();
  let rankingReads = 0;
  const service = await createPickEvaluation(
    db,
    async () => {
      rankingReads++;
      return [pick()];
    },
    async () => [],
  );
  try {
    await service.refresh(now);
    await service.refresh(now + 73 * hour);
    rankingReads = 0;
    const before = (
      await db.query(
        "SELECT slot,ctid::text FROM coupon_pick_evaluations ORDER BY slot",
      )
    ).rows;
    await service.refresh(now + 73 * hour + 1000);
    assert.equal(rankingReads, 0);
    assert.deepEqual(
      (
        await db.query(
          "SELECT slot,ctid::text FROM coupon_pick_evaluations ORDER BY slot",
        )
      ).rows,
      before,
    );
  } finally {
    await db.close();
  }
});
