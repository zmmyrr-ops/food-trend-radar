import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { recoverInterruptedRequests } from "../src/request-recovery.js";

test("启动恢复只标记未完成请求：幂等、不伪造结束时间、不改变任务游标与重试预算", async () => {
  const db = await openDatabase();
  try {
    const brand = randomUUID(),
      run = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌','recovery','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'running')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,cursor,retries,state) VALUES($1,$2,'品牌','[]','40',2,'queued')",
      [run, brand],
    );
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, outcome] of [
      "in_flight",
      "OK",
      "NETWORK_ERROR",
    ].entries()) {
      await db.query(
        "INSERT INTO coupon_requests(id,run_id,brand_id,cursor,attempt,started_at,finished_at,outcome) VALUES($1,$2,$3,'40',3,now()-interval '1 hour',CASE WHEN $4='in_flight' THEN NULL ELSE now()-interval '59 minutes' END,$4)",
        [ids[index], run, brand, outcome],
      );
    }
    assert.equal(await recoverInterruptedRequests(db), 1);
    const recovered = (
      await db.query("SELECT * FROM coupon_requests WHERE id=$1", [ids[0]])
    ).rows[0];
    assert.equal(recovered.outcome, "INTERRUPTED");
    assert.equal(recovered.finished_at, null);
    assert.ok(recovered.recovered_at);
    assert.equal(await recoverInterruptedRequests(db), 0);
    const again = (
      await db.query("SELECT recovered_at FROM coupon_requests WHERE id=$1", [
        ids[0],
      ])
    ).rows[0];
    assert.deepEqual(again.recovered_at, recovered.recovered_at);
    assert.deepEqual(
      (
        await db.query(
          "SELECT outcome,recovered_at FROM coupon_requests WHERE id=$1",
          [ids[1]],
        )
      ).rows[0],
      { outcome: "OK", recovered_at: null },
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT cursor,retries,state FROM coupon_tasks WHERE run_id=$1",
          [run],
        )
      ).rows[0],
      { cursor: "40", retries: 2, state: "queued" },
    );
  } finally {
    await db.close();
  }
});
