import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAlerts } from "../src/alerts.js";
import { normalizeCoupon } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";
import { createScoreHistory } from "../src/score-history.js";

test("actual evidence saves revisions, unknown inputs stay unknown and do not alert", async () => {
  const db = await openDatabase(),
    brand = randomUUID(),
    run = randomUUID();
  try {
    const alerts = await createAlerts(db),
      history = await createScoreHistory(db, alerts.opportunity);
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','score-test','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status) VALUES($1,$2,'测试','[]','complete','FIRST_BASELINE')",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    const p = normalizeCoupon(
      {
        product_id: "123",
        product_info: {
          product_name: "测试券",
          price_range: { min: 100, max: 100 },
        },
        nearest_poi_info: {
          brand_data: { brand_name: "测试", brand_id: "456" },
        },
      },
      ["测试"],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'123',$3)",
      [run, brand, JSON.stringify(p)],
    );
    assert.equal((await history.refresh()).inserted, 1);
    assert.equal((await history.refresh()).inserted, 0);
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,'123',$2)",
      [
        run,
        JSON.stringify({
          complete: true,
          reported_count: 1,
          stores: [{ poi_id: "9", shanghai: true }],
        }),
      ],
    );
    assert.equal((await history.refresh()).inserted, 1);
    const rows = (
      await db.query<{
        payload: {
          score: {
            version: string;
            score_status: string;
            missing: string[];
            gate: string;
          };
          features: { heat: null };
        };
      }>("SELECT payload FROM coupon_score_history ORDER BY scored_at DESC")
    ).rows;
    assert.equal(rows[0].payload.score.gate, "watch");
    assert.equal(rows[0].payload.score.version, "V4.2.sales-evidence");
    assert.equal(rows[0].payload.score.score_status, "not_calibrated");
    assert.equal(
      rows[0].payload.score.missing.some((x) => /creator/i.test(x)),
      false,
    );
    assert.ok(rows[0].payload.score.missing.includes("salesHistory"));
    assert.equal(rows[0].payload.features.heat, null);
    assert.equal(rows[0].payload.score.missing.includes("shanghai"), false);
    assert.equal(rows[1].payload.score.missing.includes("shanghai"), true);
    const previous = randomUUID();
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      previous,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state) VALUES($1,$2,'测试','[]','complete')",
      [previous, brand],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) SELECT $1,brand_id,product_id,jsonb_set(payload,'{monthly_sales}','\"100\"'),observed_at-interval '12 hours' FROM coupon_items WHERE run_id=$2",
      [previous, run],
    );
    await db.query(
      "UPDATE coupon_items SET payload=jsonb_set(payload,'{monthly_sales}','\"220\"') WHERE run_id=$1",
      [run],
    );
    assert.equal((await history.refresh()).inserted, 1);
    const measured = (
      await db.query<{
        payload: {
          features: { sales_heat: { speed: number; samples: unknown[] } };
          score: { missing: string[] };
        };
      }>(
        "SELECT payload FROM coupon_score_history ORDER BY scored_at DESC LIMIT 1",
      )
    ).rows[0].payload;
    assert.equal(measured.features.sales_heat.speed, 10);
    assert.equal(measured.features.sales_heat.samples.length, 2);
    assert.equal(measured.score.missing.includes("salesHistory"), false);
    await db.query("DELETE FROM coupon_store_snapshots WHERE run_id=$1", [run]);
    assert.equal((await history.refresh()).inserted, 1);
    assert.equal((await db.query("SELECT * FROM radar_alerts")).rows.length, 0);
  } finally {
    await db.close();
  }
});

test("newly collected evidence refreshes before untouched coupons, with an ordinary fourth batch", async () => {
  const db = await openDatabase(),
    brand = randomUUID(),
    run = randomUUID();
  try {
    const alerts = await createAlerts(db),
      scores = await createScoreHistory(db, alerts.opportunity);
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','dirty-evidence','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status) VALUES($1,$2,'测试','[]','complete','FIRST_BASELINE')",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    const coupon = normalizeCoupon(
      {
        product_id: "1",
        product_info: {
          product_name: "测试券",
          price_range: { min: 100, max: 100 },
        },
        nearest_poi_info: { brand_data: { brand_name: "测试", brand_id: "9" } },
      },
      ["测试"],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'1',$3)",
      [run, brand, JSON.stringify(coupon)],
    );
    await scores.refresh(1);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'2',$3)",
      [run, brand, JSON.stringify({ ...coupon, product_id: "2" })],
    );
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,'1',$2)",
      [
        run,
        JSON.stringify({
          complete: true,
          reported_count: 1,
          stores: [{ poi_id: "9", shanghai: true }],
        }),
      ],
    );
    await scores.refresh(1);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='1'",
        )
      ).rows.length,
      2,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='2'",
        )
      ).rows.length,
      0,
    );
    await scores.refresh(1);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='2'",
        )
      ).rows.length,
      1,
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'3',$3)",
      [run, brand, JSON.stringify({ ...coupon, product_id: "3" })],
    );
    await db.query(
      "UPDATE coupon_store_snapshots SET observed_at=now() WHERE product_id='1'",
    );
    await scores.refresh(1);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='3'",
        )
      ).rows.length,
      1,
    );
    const previous = randomUUID();
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      previous,
    ]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'1',$3,now()-interval '1 hour')",
      [previous, brand, JSON.stringify(coupon)],
    );
    await db.query(
      "UPDATE coupon_tasks SET previous_run_id=$1 WHERE run_id=$2",
      [previous, run],
    );
    await scores.refresh(100);
    const before = (
      await db.query("SELECT * FROM coupon_score_history WHERE product_id='1'")
    ).rows.length;
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'4',$3)",
      [run, brand, JSON.stringify({ ...coupon, product_id: "4" })],
    );
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,'1',$2)",
      [
        previous,
        JSON.stringify({
          complete: true,
          reported_count: 1,
          stores: [{ poi_id: "9", shanghai: true }],
        }),
      ],
    );
    await scores.refresh(1);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='1'",
        )
      ).rows.length,
      before + 1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM coupon_score_history WHERE product_id='4'",
        )
      ).rows.length,
      0,
    );
    assert.equal((await db.query("SELECT * FROM radar_alerts")).rows.length, 0);
  } finally {
    await db.close();
  }
});
