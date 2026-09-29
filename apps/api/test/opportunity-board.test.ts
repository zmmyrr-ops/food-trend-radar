import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createAlerts } from "../src/alerts.js";
import { normalizeCoupon } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";
import {
  boardCandidate,
  createOpportunityBoard,
  sortCandidates,
} from "../src/opportunity-board.js";
import { createScoreHistory } from "../src/score-history.js";

const coupon = (price = 1000) =>
  normalizeCoupon(
    {
      product_id: "123",
      product_info: {
        product_name: "测试券",
        price_range: { min: price, max: price },
      },
      nearest_poi_info: { brand_data: { brand_name: "测试", brand_id: "456" } },
    },
    ["测试"],
  );
const row = () => ({
  brand_id: randomUUID(),
  brand_name: "测试",
  product_id: "123",
  run_id: randomUUID(),
  observed_at: new Date().toISOString(),
  payload: coupon(800),
  old_payload: coupon(),
  comparison_status: "COMPARABLE",
  kind: "PRICE_CHANGED_UNVERIFIED",
  score_payload: null,
  disposition: null,
  disposition_revision: null,
  identity_conflict: false,
  previously_seen: false,
  first_seen_at: new Date().toISOString(),
});
test("board excludes reset baselines and identity conflicts; range changes cannot impersonate savings", () => {
  const r = row();
  assert.equal(boardCandidate(r)?.saving_fen, 200);
  assert.equal(
    boardCandidate({ ...r, comparison_status: "STALE_BASELINE" }),
    null,
  );
  assert.equal(boardCandidate({ ...r, identity_conflict: true }), null);
  assert.equal(
    boardCandidate({ ...r, payload: { ...r.payload, price_max_fen: 1100 } }),
    null,
  );
  assert.equal(
    boardCandidate({ ...r, old_payload: null, kind: "NEW_OBSERVED" })?.kind,
    "first_observed",
  );
});
test("dispositions survive sales-count changes, reopen material revisions and preserve watch state", () => {
  const r = row(),
    revision = boardCandidate(r)!.revision;
  assert.equal(
    boardCandidate({
      ...r,
      payload: { ...r.payload, monthly_sales: "999" },
      disposition: "dismissed",
      disposition_revision: revision,
    })?.disposition,
    "dismissed",
  );
  assert.equal(
    boardCandidate({
      ...r,
      payload: coupon(700),
      disposition: "dismissed",
      disposition_revision: revision,
    })?.disposition,
    "new",
  );
  assert.equal(
    boardCandidate({
      ...r,
      payload: coupon(700),
      disposition: "watching",
      disposition_revision: revision,
    })?.disposition,
    "watching",
  );
  const newItem = boardCandidate({
    ...r,
    old_payload: null,
    kind: "NEW_OBSERVED",
  })!;
  assert.equal(
    sortCandidates([newItem, boardCandidate(r)!])[0].kind,
    "price_drop",
  );
});
test("live board API uses only fresh active baselines; filters, revision writes and digest are persistent", async () => {
  const db = await openDatabase();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const alerts = await createAlerts(db);
    const scores = await createScoreHistory(db, alerts.opportunity);
    const board = await createOpportunityBoard(db, alerts.emit);
    const r = row();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','board-test','火锅','https://example.com')",
      [r.brand_id],
    );
    await db.query(
      "INSERT INTO coupon_runs(id,status,finished_at) VALUES($1,'complete',now())",
      [r.run_id],
    );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,completed_at) VALUES($1,$2,'测试','[]','complete','COMPARABLE',now())",
      [r.run_id, r.brand_id],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      r.brand_id,
      r.run_id,
    ]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'123',$3)",
      [r.run_id, r.brand_id, JSON.stringify(r.payload)],
    );
    await db.query(
      "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,old_payload,new_payload) VALUES($1,$2,'123',$3,$4,$5)",
      [
        r.run_id,
        r.brand_id,
        r.kind,
        JSON.stringify(r.old_payload),
        JSON.stringify(r.payload),
      ],
    );
    const app = express();
    app.use(express.json());
    board.register(app);
    scores.register(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    const base = `http://127.0.0.1:${address.port}/api/v3/selection-board`;
    let response = await fetch(base),
      payload = await response.json();
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0].race_status, "unknown");
    // Concurrent callers share work, while completed reads are not cached.
    const firstRead = board.candidates();
    assert.equal(firstRead, board.candidates());
    assert.equal((await firstRead).length, 1);
    const conflictingBrand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'同名品牌','board-conflict','火锅','https://example.com')",
      [conflictingBrand],
    );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,completed_at) VALUES($1,$2,'同名品牌','[]','complete','COMPARABLE',now())",
      [r.run_id, conflictingBrand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      conflictingBrand,
      r.run_id,
    ]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'456',$3)",
      [r.run_id, conflictingBrand, JSON.stringify(r.payload)],
    );
    assert.equal(
      (await board.candidates()).length,
      0,
      "当前活跃品牌共享平台身份必须阻断",
    );
    await db.query("DELETE FROM coupon_baselines WHERE brand_id=$1", [
      conflictingBrand,
    ]);
    assert.equal(
      (await board.candidates()).length,
      1,
      "历史记录不冒充当前冲突",
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      conflictingBrand,
      r.run_id,
    ]);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [
      conflictingBrand,
    ]);
    assert.equal(
      (await board.candidates()).length,
      1,
      "停用品牌不制造当前冲突",
    );

    await scores.refresh();
    // Cached same-condition proof must disappear immediately when source evidence changes.
    await db.query(
      "UPDATE coupon_score_history SET payload=jsonb_set(payload,'{evidence,signal}','\"price_drop_same_returned_conditions\"'::jsonb)",
    );
    assert.equal((await (await fetch(base)).json()).items[0].priority, 3);
    const rankings = base.replace("selection-board", "rankings");
    assert.equal((await (await fetch(rankings)).json()).items.length, 1);
    await db.query(
      "UPDATE coupon_score_history SET payload=jsonb_set(payload,'{score,version}','\"V3.0\"'::jsonb)",
    );
    assert.equal((await (await fetch(rankings)).json()).items.length, 0);
    await db.query(
      "UPDATE coupon_score_history SET payload=jsonb_set(payload,'{score,version}','\"V4.2.sales-evidence\"'::jsonb)",
    );
    assert.equal((await (await fetch(rankings)).json()).items.length, 1);

    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,'123',$2)",
      [
        r.run_id,
        JSON.stringify({
          complete: true,
          reported_count: 1,
          stores: [{ poi_id: "9", shanghai: true }],
        }),
      ],
    );
    assert.equal((await (await fetch(base)).json()).items[0].priority, 2);
    assert.equal((await (await fetch(rankings)).json()).items.length, 0);
    await scores.refresh();
    assert.equal((await (await fetch(rankings)).json()).items.length, 1);
    await db.query("DELETE FROM coupon_store_snapshots WHERE run_id=$1", [
      r.run_id,
    ]);
    assert.equal((await (await fetch(rankings)).json()).items.length, 0);
    await scores.refresh();
    assert.equal((await (await fetch(rankings)).json()).items.length, 1);

    const state = {
      brand_id: r.brand_id,
      revision: payload.items[0].revision,
      state: "dismissed",
    };
    response = await fetch(`${base}/123/disposition`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(base)).json()).total, 0);
    assert.equal(
      (await (await fetch(`${base}?filter=dismissed`)).json()).total,
      1,
    );
    response = await fetch(`${base}/123/disposition`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state, revision: "0".repeat(64) }),
    });
    assert.equal(response.status, 409);
    await db.query("DELETE FROM coupon_dispositions");
    await board.digest();
    await board.digest();
    const notifications = (
      await db.query<{ kind: string; payload: { count: number } }>(
        "SELECT kind,payload FROM radar_alerts",
      )
    ).rows;
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, "scan_digest");
    assert.equal(notifications[0].payload.count, 1);
    await db.query(
      "UPDATE coupon_diffs SET kind='NEW_OBSERVED',old_payload=NULL",
    );
    assert.equal(
      (await (await fetch(base)).json()).items[0].kind,
      "first_observed",
    );
    const older = randomUUID();
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'partial')", [
      older,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state) VALUES($1,$2,'测试','[]','failed')",
      [older, r.brand_id],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'123',$3,now()-interval '7 days')",
      [older, r.brand_id, JSON.stringify(r.payload)],
    );
    assert.equal(
      (await (await fetch(base)).json()).items[0].kind,
      "first_observed",
    );
    await db.query("UPDATE coupon_tasks SET state='complete' WHERE run_id=$1", [
      older,
    ]);
    assert.equal((await (await fetch(base)).json()).total, 0);
    const reappeared = await (await fetch(`${base}?filter=reappeared`)).json();
    assert.equal(reappeared.total, 1);
    assert.equal(reappeared.items[0].kind, "reappeared");
    assert.ok(
      Date.parse(reappeared.items[0].first_seen_at) < Date.now() - 6 * 86400000,
    );
    await db.query(
      "UPDATE coupon_items SET observed_at=now()-interval '40 hours'",
    );
    assert.equal((await board.candidates()).length, 0);
    await db.query("UPDATE coupon_items SET observed_at=now()");
    await db.query("UPDATE brands SET active=false");
    assert.equal((await board.candidates()).length, 0);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
  }
});

test("unchanged list fields cannot hide changed package rules; a new rule revision reopens dismissal", () => {
  const r = row();
  const rulesRow = {
    ...r,
    payload: coupon(),
    old_payload: coupon(),
    kind: "UNCHANGED",
    score_payload: {
      score: {
        gate: "watch",
        range: { low: 0, high: 89.5 },
        missing: ["value"],
      },
      evidence: {
        signal: "no_confirmed_improvement",
        blockers: ["待核验"],
        rules: { status: "changed", changes: ["套餐内容或数量"] },
        evidence_times: {
          current_rules: "2026-09-28T04:00:00Z",
          previous_rules: "2026-09-27T16:00:00Z",
        },
      },
      features: {},
    },
  };
  const first = boardCandidate(rulesRow)!;
  assert.equal(first.kind, "terms_changed");
  assert.deepEqual(first.changed_fields, ["套餐内容或数量"]);
  const next = boardCandidate({
    ...rulesRow,
    disposition: "dismissed",
    disposition_revision: first.revision,
    score_payload: {
      ...rulesRow.score_payload,
      evidence: {
        ...rulesRow.score_payload.evidence,
        evidence_times: {
          current_rules: "2026-09-28T16:00:00Z",
          previous_rules: "2026-09-28T04:00:00Z",
        },
      },
    },
  })!;
  assert.equal(next.disposition, "new");
  assert.notEqual(next.revision, first.revision);
});

test("a watched coupon with unchanged price remains in the watch list without posing as a new clue", () => {
  const r = row();
  const result = boardCandidate({
    ...r,
    payload: coupon(),
    old_payload: coupon(),
    kind: "UNCHANGED",
    disposition: "watching",
  });
  assert.equal(result?.kind, "watched");
  assert.equal(result?.disposition, "watching");
  assert.equal(
    boardCandidate({
      ...r,
      payload: coupon(),
      old_payload: coupon(),
      kind: "UNCHANGED",
    }),
    null,
  );
});

test("ordinary metadata changes do not enter the opportunity board at an unchanged price", () => {
  const r = row();
  for (const change of [
    { sale_end: "1799999999" },
    { name: "改个标题" },
    { status: 2 },
  ]) {
    const current = { ...coupon(), ...change };
    assert.equal(
      boardCandidate({
        ...r,
        payload: current,
        old_payload: coupon(),
        kind: "TERMS_CHANGED_UNVERIFIED",
      }),
      null,
    );
  }
  const lower = boardCandidate({
    ...r,
    payload: { ...coupon(800), sale_end: "1799999999" },
    old_payload: coupon(),
    kind: "PRICE_CHANGED_UNVERIFIED",
  });
  assert.equal(lower?.kind, "price_drop");
  assert.ok(lower?.changed_fields.includes("销售截止时间"));
});

test("a coupon seen in an earlier complete snapshot is reappearance, not first discovery", () => {
  const r = { ...row(), kind: "NEW_OBSERVED", old_payload: null };
  assert.equal(boardCandidate(r)?.kind, "first_observed");
  const result = boardCandidate({
    ...r,
    previously_seen: true,
    first_seen_at: "2026-09-20T00:00:00Z",
  });
  assert.equal(result?.kind, "reappeared");
  assert.equal(result?.first_seen_at, "2026-09-20T00:00:00Z");
  assert.equal(
    boardCandidate({ ...row(), previously_seen: true })?.kind,
    "price_drop",
  );
});
