import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { sourceDiagnostics } from "../src/source-diagnostics.js";

test("source diagnostics distinguishes unrecorded evidence and current retry/final states without network calls", async () => {
  const db = await openDatabase();
  try {
    const brand = randomUUID(),
      run = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','source-audit','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'测试','[]','complete',now())",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    for (const [id, payload] of [
      ["1", { identity: "name_match", monthly_sales: "123" }],
      [
        "2",
        {
          identity: "name_match",
          monthly_sales: "1万+",
          source_evidence: {
            sales: {
              semantics: "unverified",
              observed_count_fields: {
                sold_count_display: "1万+",
                sold_count: 12000,
              },
            },
          },
        },
      ],
    ] as const)
      await db.query(
        "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,$3,$4)",
        [run, brand, id, JSON.stringify(payload)],
      );
    await db.query(
      "INSERT INTO coupon_rule_tasks(run_id,brand_id,product_id,state,retries,retry_at,error_code) VALUES($1,$2,'1','queued',1,now()+interval '1 hour','NETWORK_ERROR'),($1,$2,'2','failed',2,NULL,'NETWORK_ERROR')",
      [run, brand],
    );
    await db.query(
      "INSERT INTO coupon_store_tasks(run_id,brand_id,product_id,state,scope,cursor,error_code) VALUES($1,$2,'1','incomplete',$3,2,'STORE_COUNT_MISMATCH')",
      [
        run,
        brand,
        JSON.stringify({
          count: 10,
          ids: ["11", "12"],
          consistent: false,
          lookup_allowed: true,
        }),
      ],
    );
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,'1',$2)",
      [
        run,
        JSON.stringify({
          matched_count: 2,
          complete: false,
          shanghai_count: 2,
        }),
      ],
    );
    const d = await sourceDiagnostics(db);
    assert.equal(d.store_coverage.total, 1);
    assert.equal(d.store_coverage.with_shanghai_evidence, 1);
    assert.equal(d.store_coverage.partial_with_shanghai_evidence, 1);
    assert.equal(
      d.store_coverage.groups[0].examples[0].snapshot_complete,
      false,
    );
    assert.equal(d.store_coverage.groups[0].reason, "scope_truncated");
    assert.equal(d.store_coverage.groups[0].source_id_gap, 8);
    assert.equal(d.store_coverage.groups[0].lookup_gap, 0);
    assert.equal(d.store_coverage.groups[0].examples[0].product_id, "1");
    assert.equal(d.sales.coupons, 2);
    assert.equal(d.sales.provenance_captured, 1);
    assert.deepEqual(d.sales.fields, [
      { field: "sold_count", coupons: 1 },
      { field: "sold_count_display", coupons: 1 },
    ]);
    assert.equal(d.sales.verification.exact_count_field, "unverified");
    assert.ok(
      d.queue.some(
        (x) =>
          x.state === "queued" && x.waiting_backoff === 1 && x.retrying === 1,
      ),
    );
    assert.ok(d.queue.some((x) => x.state === "failed" && x.max_retries === 2));
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    const inactive = await sourceDiagnostics(db);
    assert.equal(inactive.sales.coupons, 0);
    assert.deepEqual(inactive.queue, []);
    assert.equal(inactive.store_coverage.total, 0);
  } finally {
    await db.close();
  }
});
