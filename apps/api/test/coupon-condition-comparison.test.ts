import assert from "node:assert/strict";
import test from "node:test";
import {
  type ConditionSnapshot,
  compareConditions,
} from "../src/coupon-condition-comparison.js";
import { normalizeCoupon } from "../src/coupons.js";

const now = Date.parse("2026-09-21T08:00:00Z");
function snapshot(at: string, price: number): ConditionSnapshot {
  return {
    run_id: at,
    observed_at: at,
    payload: {
      ...normalizeCoupon(
        {
          product_id: "123",
          product_info: {
            product_name: "券",
            price_range: { min: price, max: price },
          },
          nearest_poi_info: {
            brand_data: { brand_name: "测试", brand_id: "1" },
          },
        },
        ["测试"],
      ),
    },
    rules: {
      observed_at: at,
      payload: {
        status: "received",
        groups: [
          {
            group_name: "套餐",
            item_list: [{ name: "牛肉", count: 1, unit: "份" }],
          },
        ],
        rules: [
          {
            key: "use_date",
            name: "有效期",
            value: [{ content: "购买后7天内有效" }],
          },
        ],
      },
    },
    stores: {
      observed_at: at,
      payload: {
        complete: true,
        reported_count: 1,
        stores: [{ poi_id: "9", shanghai: true }],
      },
    },
  };
}
const old = () => snapshot("2026-09-20T20:00:00Z", 10000);
const current = () => snapshot("2026-09-21T07:00:00Z", 9000);
test("same returned rules/stores can flag price clue but never verified value", () => {
  const r = compareConditions(current(), old(), "COMPARABLE", now);
  assert.equal(r.signal, "price_drop_same_returned_conditions");
  assert.equal(r.value_verdict, "unverified");
  assert.equal(r.price.delta_fen, -1000);
  assert.equal(r.current_evidence.shanghai_count, 1);
});
test("changed dates, quantity, and store scope block same-condition price clue", () => {
  const c = current();
  c.rules!.payload.rules[0].value[0].content = "购买后3天内有效";
  c.rules!.payload.groups[0].item_list[0].count = 2;
  c.stores!.payload.stores[0].poi_id = "8";
  const r = compareConditions(c, old(), "COMPARABLE", now);
  assert.deepEqual(r.rules.changes, ["套餐内容或数量", "有效期或可用日期"]);
  assert.deepEqual(r.stores.removed_ids, ["9"]);
  assert.deepEqual(r.stores.added_ids, ["8"]);
  assert.equal(r.signal, "price_drop_conditions_unverified");
});
test("missing, stale, future, and incomplete enrichment cannot grant comparison", () => {
  for (const bad of [
    null,
    { ...current().stores!, observed_at: "2026-09-21T09:00:00Z" },
    { ...current().stores!, observed_at: "2026-09-19T07:00:00Z" },
    {
      ...current().stores!,
      payload: { ...current().stores!.payload, complete: false },
    },
  ]) {
    const c = current();
    c.stores = bad;
    const r = compareConditions(c, old(), "COMPARABLE", now);
    assert.equal(r.stores.status, "unknown");
    assert.equal(r.current_evidence.shanghai_count, null);
  }
  const c = current();
  c.rules = null;
  assert.equal(
    compareConditions(c, old(), "COMPARABLE", now).rules.status,
    "unknown",
  );
  assert.equal(
    compareConditions(current(), old(), "COMPARABLE", now + 40 * 3600000)
      .signal,
    "no_confirmed_improvement",
  );
});
test("baseline reset and first baseline do not manufacture price changes", () => {
  for (const status of ["FIRST_BASELINE", "STALE_BASELINE", "QUERY_CHANGED"]) {
    const r = compareConditions(current(), old(), status, now);
    assert.equal(r.price.delta_fen, null);
    assert.equal(r.rules.status, "unknown");
  }
  assert.equal(
    compareConditions(current(), null, "COMPARABLE", now).price.delta_fen,
    null,
  );
});

test("prior enrichment captured after current price cannot be backdated", () => {
  const p = old();
  p.rules!.observed_at = "2026-09-21T07:30:00Z";
  p.stores!.observed_at = "2026-09-21T07:30:00Z";
  const r = compareConditions(current(), p, "COMPARABLE", now);
  assert.equal(r.rules.status, "unknown");
  assert.equal(r.stores.status, "unknown");
});

test("database joins exact recorded rounds and never fills prior gaps with latest evidence", async () => {
  const { openDatabase } = await import("../src/db.js");
  const { readConditionComparison } = await import(
    "../src/coupon-condition-comparison.js"
  );
  const { randomUUID } = await import("node:crypto");
  const db = await openDatabase(),
    brand = randomUUID(),
    prev = randomUUID(),
    run = randomUUID();
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','comparison-test','火锅','https://example.com')",
      [brand],
    );
    for (const id of [prev, run])
      await db.query(
        "INSERT INTO coupon_runs(id,status) VALUES($1,'complete')",
        [id],
      );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,previous_run_id) VALUES($1,$2,'测试','[]','complete','COMPARABLE',$3)",
      [run, brand, prev],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    for (const [id, s] of [
      [prev, old()],
      [run, current()],
    ] as const) {
      await db.query("INSERT INTO coupon_items VALUES($1,$2,'123',$3,$4)", [
        id,
        brand,
        JSON.stringify(s.payload),
        s.observed_at,
      ]);
    }
    const c = current();
    await db.query(
      "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'123',$2,$3)",
      [run, JSON.stringify(c.rules!.payload), c.rules!.observed_at],
    );
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'123',$2,$3)",
      [run, JSON.stringify(c.stores!.payload), c.stores!.observed_at],
    );
    const r = await readConditionComparison(db, "123", brand, now);
    assert.equal(r?.current_run_id, run);
    assert.equal(r?.previous_run_id, prev);
    assert.equal(r?.current_evidence.stores_ready, true);
    assert.equal(r?.rules.status, "unknown");
    assert.equal(r?.stores.status, "unknown");
    assert.equal(r?.signal, "price_drop_conditions_unverified");
    assert.equal(await readConditionComparison(db, "999", brand, now), null);
  } finally {
    await db.close();
  }
});

test("same-price listed quantity increase is a clue only; changed restrictions prevent it", () => {
  const p = old(),
    c = current();
  c.payload.price_min_fen = 10000;
  c.payload.price_max_fen = 10000;
  c.rules!.payload.groups[0].item_list[0].count = 2;
  const result = compareConditions(c, p, "COMPARABLE", now);
  assert.equal(result.signal, "listed_quantity_increase_same_price");
  assert.equal(result.value_verdict, "unverified");
  assert.equal(result.quantity_changes[0].after, 2);
  c.rules!.payload.rules[0].value[0].content = "购买后1天内有效";
  assert.equal(
    compareConditions(c, p, "COMPARABLE", now).signal,
    "no_confirmed_improvement",
  );
});

test("voucher text without package items can be compared but cannot establish equal full entitlements", () => {
  const p = old(),
    c = current();
  for (const x of [p, c]) {
    x.rules!.payload.groups = [];
    x.rules!.payload.status = "incomplete";
  }
  c.rules!.payload.rules[0].value[0].content = "购买后1天内有效";
  const result = compareConditions(c, p, "COMPARABLE", now);
  assert.equal(result.current_evidence.rule_text_ready, true);
  assert.equal(result.current_evidence.rules_ready, false);
  assert.equal(result.rules.scope, "text_only");
  assert.equal(result.rules.status, "changed");
  assert.equal(result.rule_differences[0].after[0], "购买后1天内有效");
  assert.equal(result.signal, "price_drop_conditions_unverified");
  assert.equal(result.value_verdict, "unverified");
  c.rules!.payload.rules = p.rules!.payload.rules;
  assert.equal(
    compareConditions(c, p, "COMPARABLE", now).rules.status,
    "same_returned_text",
  );
  c.rules!.observed_at = "2026-09-19T00:00:00Z";
  assert.equal(
    compareConditions(c, p, "COMPARABLE", now).rule_differences.length,
    0,
  );
});

test("same coupon size change exposes before/after and cannot be same-condition discount", () => {
  const before = old(),
    after = current();
  before.payload.name = "草莓蛋糕6寸";
  after.payload.name = "草莓蛋糕4寸";
  const result = compareConditions(after, before, "COMPARABLE", now);
  assert.equal(result.signal, "price_drop_conditions_unverified");
  assert.deepEqual(result.coupon_differences, [
    {
      field: "name",
      label: "商品名称",
      before: "草莓蛋糕6寸",
      after: "草莓蛋糕4寸",
    },
  ]);
});

test("expiry-only change at identical price is not an improvement and shows exact change", () => {
  const before = old(),
    after = current();
  after.payload.price_min_fen = before.payload.price_min_fen;
  after.payload.price_max_fen = before.payload.price_max_fen;
  before.payload.sale_end = "2026-09-30";
  after.payload.sale_end = "2026-10-31";
  const result = compareConditions(after, before, "COMPARABLE", now);
  assert.equal(result.signal, "no_confirmed_improvement");
  assert.equal(result.price.delta_fen, 0);
  assert.deepEqual(result.coupon_differences, [
    {
      field: "sale_end",
      label: "销售截止时间",
      before: "2026-09-30",
      after: "2026-10-31",
    },
  ]);
  assert.deepEqual(
    compareConditions(after, before, "UNAVAILABLE", now).coupon_differences,
    [],
  );
});

test("降价但新增资格、费用上涨、仅堂食会给出前后风险证据", () => {
  const before = old(),
    after = current();
  const rule = (content: string, key = "other_rules") => ({
    key,
    name: key,
    value: [{ content }],
  });
  before.rules!.payload.rules.push(
    rule("新老用户均可使用"),
    rule("服务费5元/人"),
    rule("堂食或餐前外带均可", "food_consumption_rule"),
  );
  after.rules!.payload.rules.push(
    rule("仅限新客"),
    rule("服务费10元/人"),
    rule("仅堂食", "food_consumption_rule"),
  );
  const result = compareConditions(after, before, "COMPARABLE", now);
  assert.deepEqual(
    result.condition_risks.map((x) => x.kind),
    ["eligibility", "fees", "usage"],
  );
  assert.deepEqual(result.condition_risks[1].before, ["服务费5元/人"]);
  assert.equal(result.signal, "price_drop_conditions_unverified");
  assert.deepEqual(
    compareConditions(after, before, "UNAVAILABLE", now).condition_risks,
    [],
  );
});
test("相同但冲突的费用条款不能支持同条件降价或同价增量", () => {
  const before = old(),
    after = current();
  for (const s of [before, after])
    s.rules!.payload.rules.push({
      key: "other_rules",
      name: "费用",
      value: [{ content: "无附加费" }, { content: "服务费10元/人" }],
    });
  assert.equal(
    compareConditions(after, before, "COMPARABLE", now).signal,
    "price_drop_conditions_unverified",
  );
  after.payload.price_min_fen = after.payload.price_max_fen =
    before.payload.price_min_fen;
  after.rules!.payload.groups[0].item_list[0].count = 2;
  const result = compareConditions(after, before, "COMPARABLE", now);
  assert.equal(result.signal, "no_confirmed_improvement");
  assert.equal(result.condition_risks[0].kind, "conflict");
});
