import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createAlerts } from "../src/alerts.js";
import type { ConditionSnapshot } from "../src/coupon-condition-comparison.js";
import { normalizeCoupon, slotAt } from "../src/coupons.js";
import { crossCouponMatches, returnedPackageKey } from "../src/cross-coupon.js";
import { openDatabase } from "../src/db.js";
import { createOpportunityBoard } from "../src/opportunity-board.js";
import { createScoreHistory } from "../src/score-history.js";
import { briefMarkdown, createSelectionBrief } from "../src/selection-brief.js";
import { stabilityReport } from "../src/stability.js";

const now = Date.parse("2026-09-28T10:00:00Z");
function snap(id: string, price: number, before = false): ConditionSnapshot {
  const at = new Date(now - (before ? 3600000 : 600000)).toISOString();
  return {
    run_id: randomUUID(),
    observed_at: at,
    payload: normalizeCoupon(
      {
        product_id: id,
        product_info: {
          product_name: "测试券",
          price_range: { min: price, max: price },
        },
        nearest_poi_info: { brand_data: { brand_name: "测试", brand_id: "9" } },
      },
      ["测试"],
    ),
    rules: {
      observed_at: at,
      payload: {
        status: "received",
        groups: [
          {
            group_name: "套餐",
            item_list: [{ name: "牛肉", count: 2, unit: "份" }],
          },
        ],
        rules: [
          {
            key: "use_date",
            name: "可用日期",
            value: [{ content: "购买后15天内有效" }],
          },
        ],
      },
    },
    stores: {
      observed_at: at,
      payload: {
        complete: true,
        reported_count: 1,
        stores: [{ poi_id: "1", shanghai: true }],
      },
    },
  };
}
const entries = (current: ConditionSnapshot, previous: ConditionSnapshot[]) => [
  {
    brand_id: "brand",
    brand_name: "测试",
    side: "current" as const,
    snapshot: current,
  },
  ...previous.map((snapshot) => ({
    brand_id: "brand",
    brand_name: "测试",
    side: "previous" as const,
    snapshot,
  })),
];
test("cross ID comparison uses lowest matching prior price and does not call it verified value", () => {
  const current = snap("3", 9000),
    old = snap("1", 10000, true),
    expensive = snap("2", 12000, true);
  const [match] = crossCouponMatches(entries(current, [expensive, old]), now);
  assert.equal(match.previous_product_id, "1");
  assert.equal(match.saving_fen, 1000);
  assert.equal(match.reference_count, 2);
  assert.equal(match.store_status, "same_returned_stores");
  assert.equal(
    crossCouponMatches(entries(snap("3", 11000), [expensive, old]), now).length,
    0,
  );
  assert.equal(
    crossCouponMatches(entries(current, [old, snap("3", 9500, true)]), now)
      .length,
    0,
  );
});
test("cross ID comparison rejects incompatible quantities, rules, stores, brands and time leakage", () => {
  const current = snap("2", 9000),
    old = snap("1", 10000, true);
  const variants = [
    structuredClone(old),
    structuredClone(old),
    structuredClone(old),
    structuredClone(old),
    structuredClone(old),
  ];
  variants[0].rules!.payload.groups[0].item_list[0].count = 1;
  variants[1].rules!.payload.rules[0].value[0].content = "仅限新客";
  variants[2].stores!.payload.stores[0].poi_id = "2";
  variants[3].payload.platform_brand_id = "10";
  variants[4].rules!.observed_at = new Date(now).toISOString();
  for (const value of variants)
    assert.equal(crossCouponMatches(entries(current, [value]), now).length, 0);
  assert.equal(
    crossCouponMatches(entries(current, [old]), now + 37 * 3600000).length,
    0,
  );
  assert.equal(
    crossCouponMatches(entries(current, [old]), now - 3600000).length,
    0,
  );
  old.stores = null;
  assert.equal(
    crossCouponMatches(entries(current, [old]), now)[0].store_status,
    "unknown",
  );
});
test("package signatures reject missing units and choice groups and tolerate text ordering", () => {
  const s = snap("1", 10000),
    p = s.rules!.payload;
  const key = returnedPackageKey(p.groups, p.rules);
  assert.ok(key);
  assert.equal(
    returnedPackageKey(
      [{ ...p.groups[0], option_count: 1, total_count: 2 }],
      p.rules,
    ),
    null,
  );
  assert.equal(
    returnedPackageKey([{ item_list: [{ name: "牛肉", count: 2 }] }], p.rules),
    null,
  );
  assert.equal(returnedPackageKey(p.groups, []), null);
  assert.equal(returnedPackageKey(p.groups, [...p.rules, ...p.rules]), key);
});
test("stability requires fourteen closed scheduled slots, not manual runs or future completion", () => {
  const boundary = Date.parse(slotAt(new Date(now))),
    half = 12 * 3600000;
  const runs = Array.from({ length: 14 }, (_, i) => {
    const start = boundary - (14 - i) * half;
    return {
      id: randomUUID(),
      slot: slotAt(new Date(start)),
      status: "complete",
      started_at: new Date(start + 60000).toISOString(),
      finished_at: new Date(start + 3600000).toISOString(),
      tasks: 308,
      completed: 308,
      short_gaps: 0,
      failures: 1,
    };
  });
  assert.equal(stabilityReport(runs, now).complete, true);
  assert.equal(stabilityReport(runs.slice(1), now).passed, 13);
  assert.equal(
    stabilityReport([...runs, { ...runs[0], slot: slotAt(new Date(now)) }], now)
      .passed,
    14,
  );
  const bad = structuredClone(runs);
  bad[0].short_gaps = 1;
  bad[1].completed = 307;
  bad[2].finished_at = new Date(now + 3600000).toISOString();
  const result = stabilityReport(bad, now);
  assert.equal(result.passed, 11);
  assert.deepEqual(
    result.slots.slice(0, 3).map((x) => x.status),
    ["interval_violation", "incomplete", "late_or_incomplete"],
  );
});
test("brief routes, cross ID provenance, filter thresholds and markdown export use the actual database", async () => {
  const db = await openDatabase();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const alerts = await createAlerts(db);
    await createScoreHistory(db, alerts.opportunity);
    const board = await createOpportunityBoard(db, alerts.emit),
      brief = createSelectionBrief(db, board.candidates);
    const brand = randomUUID(),
      previous = snap("1", 10000, true),
      current = snap("2", 9000);
    const shift = Date.now() - now;
    for (const s of [previous, current]) {
      s.observed_at = new Date(Date.parse(s.observed_at) + shift).toISOString();
      s.rules!.observed_at = s.observed_at;
      s.stores!.observed_at = s.observed_at;
    }
    current.payload.name = "测试 [图片](https://example.com) <script>";
    previous.payload.name = current.payload.name;
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','brief-test','火锅','https://example.com')",
      [brand],
    );
    for (const s of [previous, current]) {
      await db.query(
        "INSERT INTO coupon_runs(id,status,finished_at) VALUES($1,'complete',now())",
        [s.run_id],
      );
      await db.query(
        "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,completed_at,previous_run_id) VALUES($1,$2,'测试','[]','complete','COMPARABLE',now(),$3)",
        [s.run_id, brand, s === current ? previous.run_id : null],
      );
      await db.query(
        "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,$3,$4,$5)",
        [
          s.run_id,
          brand,
          s.payload.product_id,
          JSON.stringify(s.payload),
          s.observed_at,
        ],
      );
      await db.query(
        "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload,observed_at) VALUES($1,$2,$3,$4)",
        [
          s.run_id,
          s.payload.product_id,
          JSON.stringify(s.rules!.payload),
          s.rules!.observed_at,
        ],
      );
      await db.query(
        "INSERT INTO coupon_store_snapshots(run_id,product_id,payload,observed_at) VALUES($1,$2,$3,$4)",
        [
          s.run_id,
          s.payload.product_id,
          JSON.stringify(s.stores!.payload),
          s.stores!.observed_at,
        ],
      );
    }
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      brand,
      current.run_id,
    ]);
    await db.query(
      "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,new_payload) VALUES($1,$2,'2','NEW_OBSERVED',$3)",
      [current.run_id, brand, JSON.stringify(current.payload)],
    );
    const b = await brief.read();
    assert.equal(b.cross.length, 1);
    assert.equal(b.items.length, 0);
    assert.equal(b.cross[0].previous_run_id, previous.run_id);
    const markdown = briefMarkdown(b);
    assert.ok(markdown.includes("券月售净增速度 Top 10"));
    assert.ok(!b.missing_sources.some((x) => x.includes("达人")));
    assert.equal(b.sales_summary.total >= b.sales_summary.measured, true);
    assert.ok(markdown.includes("\\[图片\\]"));
    assert.ok(!markdown.includes("<script>"));
    const app = express();
    app.use(express.json());
    brief.register(app);
    board.register(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error();
    const base = `http://127.0.0.1:${address.port}/api/v3`;
    assert.equal(
      (await (await fetch(base + "/cross-coupon-opportunities")).json()).total,
      1,
    );
    assert.equal(
      (await (await fetch(base + "/selection-board?search=not-found")).json())
        .total,
      0,
    );
    assert.equal(
      (await (await fetch(base + "/selection-board?min_saving_fen=1")).json())
        .total,
      0,
    );
    const dropped = {
      ...current.payload,
      product_id: "3",
      name: "明显降价",
      price_min_fen: 8000,
      price_max_fen: 8000,
    };
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'3',$3)",
      [current.run_id, brand, JSON.stringify(dropped)],
    );
    await db.query(
      "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,new_payload,old_payload) VALUES($1,$2,'3','PRICE_CHANGED_UNVERIFIED',$3,$4)",
      [
        current.run_id,
        brand,
        JSON.stringify(dropped),
        JSON.stringify({
          ...dropped,
          price_min_fen: 10000,
          price_max_fen: 10000,
        }),
      ],
    );
    assert.equal(
      (
        await (
          await fetch(
            base +
              "/selection-board?min_saving_fen=2000&min_drop_percent=20&order=saving",
          )
        ).json()
      ).total,
      1,
    );
    assert.equal(
      (
        await (
          await fetch(base + "/selection-board?min_saving_fen=2001")
        ).json()
      ).total,
      0,
    );
    assert.equal(
      (
        await (
          await fetch(base + "/selection-board?min_drop_percent=21")
        ).json()
      ).total,
      0,
    );
    await db.query(
      "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'3',$2,now())",
      [
        current.run_id,
        JSON.stringify({
          groups: [],
          rules: [
            {
              key: "use_date",
              name: "可用日期",
              value: [{ content: "不可用日期：周一至周日" }],
            },
          ],
        }),
      ],
    );
    const limited = await (
      await fetch(base + "/selection-board?usage=has_exclusions")
    ).json();
    assert.equal(limited.total, 1);
    assert.equal(limited.items[0].use_outlook.fully_excluded, true);
    const allowed = await (
      await fetch(base + "/selection-board?usage=not_fully_excluded")
    ).json();
    assert.ok(
      !allowed.items.some((x: { product_id: string }) => x.product_id === "3"),
    );
    await db.query(
      "DELETE FROM coupon_rule_snapshots WHERE run_id=$1 AND product_id='3'",
      [current.run_id],
    );
    assert.equal(
      (
        await (
          await fetch(base + "/selection-board?usage=has_exclusions")
        ).json()
      ).total,
      0,
    );
    const download = await fetch(base + "/selection-brief.md");
    assert.ok(
      download.headers.get("content-disposition")?.includes("attachment"),
    );
    assert.ok((await download.text()).includes("跨券"));
    assert.equal((await (await fetch(base + "/stability")).json()).passed, 0);
    const conflictBrand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'冲突品牌','brief-conflict','火锅','https://example.com')",
      [conflictBrand],
    );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,completed_at) VALUES($1,$2,'冲突品牌','[]','complete','FIRST_BASELINE',now())",
      [current.run_id, conflictBrand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      conflictBrand,
      current.run_id,
    ]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'4',$3)",
      [
        current.run_id,
        conflictBrand,
        JSON.stringify({ ...current.payload, product_id: "4" }),
      ],
    );
    assert.equal((await brief.read()).cross.length, 0);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [
      conflictBrand,
    ]);
    assert.equal((await brief.read()).cross.length, 1);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    assert.equal((await brief.read()).cross.length, 0);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
  }
});

test("generic package rows cannot equate different sizes, eligibility or delivery titles", () => {
  for (const [before, after] of [
    ["草莓蛋糕6寸", "草莓蛋糕4寸"],
    ["双人套餐", "单人套餐"],
    ["代金券", "【新客专享】代金券"],
    ["双人餐（堂食）", "双人餐（外带）"],
    ["大杯奶茶", "中杯奶茶"],
    ["", ""],
  ]) {
    const old = snap("old", 14800, true),
      current = snap("new", 11800);
    old.payload.name = before;
    current.payload.name = after;
    assert.equal(
      crossCouponMatches(entries(current, [old]), now).length,
      0,
      `${before} vs ${after}`,
    );
  }
  const old = snap("old", 14800, true),
    current = snap("new", 11800);
  old.payload.name = "蛋糕６寸";
  current.payload.name = " 蛋糕6寸 ";
  assert.equal(crossCouponMatches(entries(current, [old]), now).length, 1);
});

test("跨券相同条款存在费用冲突也不能作为比价线索", () => {
  const old = snap("1", 10000, true),
    current = snap("2", 9000);
  for (const s of [old, current])
    s.rules!.payload.rules.push({
      key: "other_rules",
      name: "费用",
      value: [{ content: "无附加费" }, { content: "服务费10元/人" }],
    });
  assert.equal(crossCouponMatches(entries(current, [old]), now).length, 0);
});
