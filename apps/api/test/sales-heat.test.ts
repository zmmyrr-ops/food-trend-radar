import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { openDatabase } from "../src/db.js";
import { createOpportunityBoard } from "../src/opportunity-board.js";
import {
  createSalesHeat,
  parseSales,
  type SalesPoint,
  salesHeatCsv,
  salesTrend,
} from "../src/sales-heat.js";

const now = Date.parse("2026-09-28T12:00:00Z");
const point = (count: string, hours: number): SalesPoint => ({
  run_id: randomUUID(),
  observed_at: new Date(now - hours * 3600000).toISOString(),
  payload: {
    monthly_sales: count,
    platform_brand_id: "9",
    identity: "name_match",
    price_min_fen: 1000,
    price_max_fen: 1000,
    name: "测试券",
  },
});
test("sales display parser preserves ambiguous values, accepts only integer displays", () => {
  assert.equal(parseSales("月售 1,200").value, 1200);
  assert.equal(parseSales("月售 0").value, 0);
  for (const s of [
    "1万+",
    "4.8万",
    "120+",
    "已售120",
    "120件",
    "",
    "9,99",
    "9007199254740992",
  ])
    assert.equal(parseSales(s).value, null, s);
});
test("speed normalizes unequal intervals and acceleration uses interval midpoint distance", () => {
  const r = salesTrend(
    [point("月售 160", 0), point("月售 100", 6), point("月售 40", 18)],
    now,
  );
  assert.equal(r.net_change, 60);
  assert.equal(r.speed, 10);
  assert.equal(r.previous_speed, 5);
  assert.equal(r.speed_change, 5);
  assert.equal(r.acceleration, 5 / 9);
});
test("incomplete evidence and gaps do not turn into zero or compare stale brands", () => {
  for (const points of [
    [point("100", 0)],
    [point("100", 0), point("90", 40)],
    [point("100", 0), point("90+", 12)],
    [point("100", 40), point("90", 52)],
    [point("100", 0), point("90", 0.1)],
    [point("100", -1), point("90", 12)],
    [
      point("100", 0),
      {
        ...point("90", 12),
        payload: { ...point("90", 12).payload, platform_brand_id: "10" },
      },
    ],
  ])
    assert.equal(salesTrend(points, now).speed, null);
});
test("negative rolling change remains visible but does not create rebound acceleration; price change is disclosed", () => {
  const points = [point("100", 0), point("110", 12), point("90", 24)];
  points[0].payload.price_min_fen = 900;
  const r = salesTrend(points, now);
  assert.ok(r.speed! < 0);
  assert.equal(r.status, "declining");
  assert.equal(r.acceleration, null);
  assert.equal(r.price_changed, true);
  assert.equal(
    salesTrend([point("120", 0), point("100", 12), point("110", 24)], now)
      .acceleration,
    null,
  );
});
test("complete snapshots only, active baseline scope, measured ordering and API filtering", async () => {
  const db = await openDatabase();
  let server: ReturnType<typeof express.application.listen> | undefined;
  try {
    await createOpportunityBoard(db, async () => {});
    const brand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','sales-heat','火锅','https://example.com')",
      [brand],
    );
    const at = Date.now(),
      runs = Array.from({ length: 4 }, () => randomUUID());
    for (let i = 0; i < 4; i++) {
      await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,$2)", [
        runs[i],
        i === 3 ? "running" : "complete",
      ]);
      await db.query(
        "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'测试','[]',$3,$4)",
        [
          runs[i],
          brand,
          i === 3 ? "queued" : "complete",
          new Date(at - (2 - i) * 12 * 3600000).toISOString(),
        ],
      );
      for (const id of ["1", "2"]) {
        const p = point(id === "2" ? "1万+" : String(100 + i * 60), 0).payload;
        await db.query(
          "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,$3,$4,$5)",
          [
            runs[i],
            brand,
            id,
            JSON.stringify(p),
            new Date(at - (2 - i) * 12 * 3600000).toISOString(),
          ],
        );
      }
    }
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      brand,
      runs[2],
    ]);
    const service = createSalesHeat(db),
      rows = await service.read();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.product_id === "1")?.speed, 5);
    assert.equal(rows.find((x) => x.product_id === "1")?.samples.length, 3);
    assert.equal(rows.find((x) => x.product_id === "2")?.speed, null);
    const app = express();
    service.register(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error();
    const base = `http://127.0.0.1:${addr.port}/api/v3/sales-heat`;
    const result = await (await fetch(base + "?filter=rising&limit=1")).json();
    assert.equal(result.total, 1);
    assert.equal(result.items[0].product_id, "1");
    assert.equal(result.coverage.measured, 1);
    const downloaded = await fetch(
      base + ".csv?filter=rising&limit=1&offset=999",
    );
    assert.ok(
      downloaded.headers.get("content-disposition")?.includes("attachment"),
    );
    const csv = await downloaded.text();
    assert.ok(csv.includes("测试券"));
    assert.ok(!csv.includes("1万+"));
    const emptyCsv = await (await fetch(base + ".csv?min_speed=6")).text();
    assert.ok(!emptyCsv.includes("测试券"));
    assert.equal((await (await fetch(base + "?min_speed=6")).json()).total, 0);
    assert.equal((await (await fetch(base + "?min_net=61")).json()).total, 0);
    assert.equal(
      (await (await fetch(base + "?min_speed=5&min_net=60")).json()).total,
      1,
    );
    assert.equal(
      (await (await fetch(base + "?search=not-found")).json()).total,
      0,
    );
    assert.equal(
      (await (await fetch(base + "?order=lift_ratio")).json()).coverage
        .baseline_ready,
      0,
    );
    assert.equal(
      (await (await fetch(base + "?filter=unknown")).json()).total,
      1,
    );
    for (const [run, hours, fingerprint] of [
      [runs[2], 0, "new"],
      [runs[1], 11, "old"],
    ] as const)
      await db.query(
        "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'1',$2,$3)",
        [
          run,
          JSON.stringify({
            status: "received",
            commodity_fingerprint: fingerprint,
            rule_fingerprint: "terms",
          }),
          new Date(at - hours * 3600000).toISOString(),
        ],
      );
    const changed = (await service.read()).find((x) => x.product_id === "1")!;
    assert.equal(changed.content_comparison, "changed");
    assert.equal(changed.speed, null);
    assert.match(changed.reason, /套餐或条款发生变化/);
    // Historical detail fetched after the current list is not contemporaneous proof.
    await db.query(
      "UPDATE coupon_rule_snapshots SET observed_at=now() WHERE run_id=$1",
      [runs[1]],
    );
    const late = (await service.read()).find((x) => x.product_id === "1")!;
    assert.equal(late.content_comparison, "unknown");
    assert.equal(late.speed, 5);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    assert.equal((await service.read()).length, 0);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await db.close();
  }
});

test("historical median excludes present spike and normalizes differing intervals", () => {
  const rows = [
    point("400", 0),
    point("160", 12),
    point("100", 24),
    point("70", 30),
    point("40", 36),
    point("10", 42),
  ];
  const r = salesTrend(rows, now);
  assert.equal(r.speed, 20);
  assert.equal(r.baseline_windows, 4);
  assert.equal(r.baseline_speed, 5);
  assert.equal(r.lift_ratio, 4);
});
test("baseline does not bridge broken windows or insufficient duration", () => {
  const rows = [
    point("500", 0),
    point("260", 12),
    point("200", 24),
    point("140", 36),
    point("80", 48),
    point("20", 60),
  ];
  assert.equal(salesTrend(rows.slice(0, 5), now).lift_ratio, null);
  const abbreviated = structuredClone(rows);
  abbreviated[3].payload.monthly_sales = "1万+";
  assert.equal(salesTrend(abbreviated, now).lift_ratio, null);
  assert.equal(
    salesTrend(
      [
        point("100", 0),
        point("90", 1),
        point("80", 2),
        point("70", 3),
        point("60", 4),
        point("50", 5),
      ],
      now,
    ).lift_ratio,
    null,
  );
});
test("zero baseline and negative current windows never produce infinite or misleading lift", () => {
  const rows = [
    point("100", 0),
    point("10", 12),
    point("10", 24),
    point("10", 36),
    point("10", 48),
    point("10", 60),
  ];
  const r = salesTrend(rows, now);
  assert.equal(r.baseline_speed, 0);
  assert.equal(r.lift_ratio, null);
  rows[0].payload.monthly_sales = "0";
  assert.equal(salesTrend(rows, now).lift_ratio, null);
});

test("CSV protects text formulas and long IDs while preserving negatives and unknowns", () => {
  const csv = salesHeatCsv([
    {
      brand_name: "=CMD()",
      product_id: "7603658142592895026",
      title: '标题,"测试"\n第二行',
      price_fen: 1200,
      speed: -2,
      net_change: -24,
      hours: 12,
      acceleration: null,
      lift_ratio: null,
      reason: "证据不足",
      samples: [],
    },
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'=CMD()"'));
  assert.ok(csv.includes('"\'7603658142592895026"'));
  assert.ok(csv.includes('"-2"'));
  assert.ok(csv.includes('标题,""测试""'));
  assert.ok(!csv.includes("undefined"));
});

test("complete missing snapshots break speed, acceleration and baseline without treating partial scans as absence", async () => {
  const db = await openDatabase();
  try {
    const brand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'连续性','continuity','火锅','https://example.com')",
      [brand],
    );
    const at = Date.now() - 1000;
    const runs = Array.from({ length: 7 }, () => randomUUID());
    for (let i = 0; i < runs.length; i++) {
      const observed = new Date(at - i * 6 * 3600000).toISOString();
      await db.query(
        "INSERT INTO coupon_runs(id,status) VALUES($1,'complete')",
        [runs[i]],
      );
      await db.query(
        "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at,query_signature) VALUES($1,$2,'连续性','[]','complete',$3,'scope-a')",
        [runs[i], brand, observed],
      );
      for (const id of ["1", "2", "3", "4"]) {
        if (
          (id === "1" && i === 1) ||
          (id === "2" && i === 2) ||
          (id === "3" && i === 4)
        )
          continue;
        await db.query(
          "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,$3,$4,$5)",
          [
            runs[i],
            brand,
            id,
            JSON.stringify(point(String(500 - i * 60), 0).payload),
            observed,
          ],
        );
      }
    }
    const partial = randomUUID();
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'running')", [
      partial,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'连续性','[]','queued',$3)",
      [partial, brand, new Date(at - 3 * 3600000).toISOString()],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      brand,
      runs[0],
    ]);
    const service = createSalesHeat(db);
    const rows = await service.read();
    const item = (id: string) => rows.find((x) => x.product_id === id)!;
    assert.equal(item("1").speed, null);
    assert.match(item("1").reason, /完整扫描未见/);
    assert.equal(item("1").samples[1].missing, true);
    assert.equal(item("1").samples[1].parsed_value, null);
    assert.equal(item("2").speed, 10);
    assert.equal(item("2").acceleration, null);
    assert.match(item("2").acceleration_reason, /完整扫描未见/);
    assert.equal(item("3").speed, 10);
    assert.equal(item("3").acceleration, 0);
    assert.equal(item("3").baseline_windows, 2);
    assert.equal(item("3").lift_ratio, null);
    assert.match(item("3").baseline_reason, /完整扫描未见/);
    assert.equal(item("4").baseline_speed, 10);
    assert.equal(item("4").lift_ratio, 1);
    assert.equal(
      item("4").samples.some((x) => x.run_id === partial),
      false,
    );
    // When the next complete snapshot returns the coupon, only the new adjacent window recovers.
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) SELECT run_id,brand_id,'1',payload,observed_at FROM coupon_items WHERE run_id=$1 AND product_id='4'",
      [runs[1]],
    );
    assert.equal(
      (await service.read()).find((x) => x.product_id === "1")?.speed,
      10,
    );
    await db.query(
      "UPDATE coupon_items SET payload=jsonb_set(payload,'{name}','\"新版套餐\"') WHERE run_id=$1 AND product_id='4'",
      [runs[0]],
    );
    assert.match(
      (await service.read()).find((x) => x.product_id === "4")!.reason,
      /套餐描述已变化/,
    );
    await db.query(
      "UPDATE coupon_tasks SET query_signature='scope-b' WHERE run_id=$1",
      [runs[0]],
    );
    assert.match(
      (await service.read()).find((x) => x.product_id === "2")!.reason,
      /查询口径不同/,
    );
  } finally {
    await db.close();
  }
});

test("unchanged titles do not bridge known content revisions, missing evidence stays explicit", () => {
  const rows = [point("220", 0), point("100", 12), point("40", 24)];
  const details = (p: SalesPoint, commodity: string, rule = "terms") => ({
    observed_at: p.observed_at,
    status: "received",
    commodity_fingerprint: commodity,
    rule_fingerprint: rule,
  });
  rows.forEach((p) => {
    p.rules = details(p, "same");
  });
  assert.equal(
    salesTrend(rows, now).content_comparison,
    "same_returned_content",
  );
  assert.equal(salesTrend(rows, now).speed, 10);
  rows[0].rules = details(rows[0], "new package");
  assert.equal(salesTrend(rows, now).speed, null);
  rows[0].rules = details(rows[0], "same", "new terms");
  assert.equal(salesTrend(rows, now).speed, null);
  rows[0].rules = details(rows[0], "same");
  rows[2].rules = details(rows[2], "previous package");
  assert.equal(salesTrend(rows, now).speed, 10);
  assert.equal(salesTrend(rows, now).acceleration, null);
  assert.match(salesTrend(rows, now).acceleration_reason, /套餐或条款/);
  rows[0].rules = null;
  assert.equal(salesTrend(rows, now).content_comparison, "unknown");
  assert.equal(salesTrend(rows, now).speed, 10);
  rows[0].rules = { ...details(rows[0], "different"), status: "incomplete" };
  assert.equal(salesTrend(rows, now).content_comparison, "unknown");
  rows[0].rules = {
    ...details(rows[0], "different"),
    observed_at: new Date(now + 1000).toISOString(),
  };
  assert.equal(salesTrend(rows, now).content_comparison, "unknown");
});
