import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  combinePicks,
  picksCsv,
  registerCouponPicks,
  selectPicks,
} from "../src/coupon-picks.js";
import { initCoupons } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";
import { createOpportunityBoard } from "../src/opportunity-board.js";
import { salesTrend } from "../src/sales-heat.js";

const now = Date.now(),
  at = new Date(now - 3600000).toISOString();
function heat(id = "1", sales = "120") {
  const points = [
    {
      run_id: "run",
      observed_at: at,
      payload: {
        monthly_sales: sales,
        platform_brand_id: "platform",
        identity: "name_match",
        price_min_fen: 800,
        price_max_fen: 800,
        name: "券",
      },
    },
    {
      run_id: "before",
      observed_at: new Date(now - 13 * 3600000).toISOString(),
      payload: {
        monthly_sales: "100",
        platform_brand_id: "platform",
        identity: "name_match",
        price_min_fen: 1000,
        price_max_fen: 1000,
        name: "券",
      },
    },
  ];
  return {
    brand_id: "brand",
    brand_name: "品牌",
    product_id: id,
    title: "券",
    price_fen: 800,
    ...salesTrend(points, now),
  };
}
const signal = {
  brand_id: "brand",
  product_id: "1",
  run_id: "run",
  observed_at: at,
  kind: "price_drop",
  disposition: "new",
  previous_price_fen: 1000,
  saving_fen: 200,
  reduction_rate: 0.2,
  reason: "票面降价，权益待核验",
};
const query = {
  view: "all" as const,
  order: "speed" as const,
  search: "",
  offset: 0,
  limit: 20,
};
test("同券同轮才关联优惠，过期/未来不进入选券，暂不考虑状态生效", () => {
  assert.equal(combinePicks([heat()], [signal], now)[0].saving_fen, 200);
  assert.equal(
    combinePicks([heat()], [{ ...signal, run_id: "different" }], now)[0]
      .saving_fen,
    null,
  );
  assert.equal(
    combinePicks(
      [heat()],
      [{ ...signal, observed_at: new Date(now).toISOString() }],
      now,
    )[0].saving_fen,
    null,
  );
  assert.deepEqual(
    combinePicks([heat()], [{ ...signal, disposition: "dismissed" }], now),
    [],
  );
  assert.deepEqual(combinePicks([heat()], [], now + 40 * 3600000), []);
  assert.deepEqual(combinePicks([heat()], [], now - 2 * 3600000), []);
});
test("筛选优惠与热度交集，未知不按零，未知速度排后", () => {
  const rows = combinePicks(
    [heat(), heat("2", "1万+"), heat("3", "99")],
    [signal],
    now,
  );
  const picked = selectPicks(rows, { ...query, view: "value_rising" });
  assert.deepEqual(
    picked.filtered.map((x) => x.product_id),
    ["1"],
  );
  assert.equal(picked.counts.all, 3);
  assert.deepEqual(
    selectPicks(rows, query).filtered.map((x) => x.product_id),
    ["1", "3", "2"],
  );
  assert.equal(
    selectPicks(rows, { ...query, search: "不存在" }).filtered.length,
    0,
  );
  assert.equal(
    selectPicks(rows, { ...query, view: "accelerating" }).filtered.length,
    0,
  );
});
test("导出保护公式与长ID，未知价格/热度保留空值", () => {
  const rows = combinePicks(
    [{ ...heat("9007199254740993", "1万+"), title: '=HYPERLINK("x")' }],
    [],
    now,
  );
  const csv = picksCsv(rows);
  assert.ok(csv.includes("'9007199254740993"));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"","","",""'));
});
test("选券API先全量筛选排序再分页，CSV包含当前筛选全部记录", async () => {
  const app = express();
  registerCouponPicks(
    app,
    async () => [heat(), heat("2", "130"), heat("3", "1万+")],
    async () => [signal],
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v3/coupon-picks`;
    const all = await (await fetch(base + "?limit=1&order=speed")).json();
    assert.equal(all.total, 3);
    assert.equal(all.items[0].product_id, "2");
    const ranked = await (await fetch(base + "?limit=1")).json();
    assert.equal(ranked.items[0].product_id, "1");
    assert.equal(ranked.model.version, "priority-v2");
    assert.equal(ranked.context, null);
    const filtered = await (
      await fetch(base + "?view=value_rising&limit=1")
    ).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].product_id, "1");
    const csv = await (await fetch(base + ".csv?limit=1")).text();
    assert.equal(csv.split("\r\n").length, 4);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("热度券无需优惠信号即可持久关注，筛选导出一致，过期可取消但不能新关注", async () => {
  const db = await openDatabase();
  await initCoupons(db);
  await createOpportunityBoard(db, async () => {});
  const brand = "11111111-1111-4111-8111-111111111111";
  let visible = true;
  const app = express();
  app.use(express.json());
  registerCouponPicks(
    app,
    async () => (visible ? [{ ...heat(), brand_id: brand }] : []),
    async () => [],
    db,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v3/coupon-picks`;
    const save = (watching: boolean, brand_id = brand) =>
      fetch(base + "/1/watch", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand_id, watching }),
      });
    assert.equal((await save(true)).status, 200);
    assert.equal((await save(true)).status, 200);
    assert.equal(
      (await db.query("SELECT * FROM coupon_dispositions")).rows.length,
      1,
    );
    const listed = await (await fetch(base + "?view=watching")).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].watching, true);
    const csv = await (await fetch(base + ".csv?view=watching")).text();
    assert.ok(csv.includes("已关注"));
    assert.equal(
      (await save(true, "22222222-2222-4222-8222-222222222222")).status,
      409,
    );
    visible = false;
    assert.equal(
      (await (await fetch(base + "?view=watching")).json()).total,
      0,
    );
    assert.equal((await save(true)).status, 409);
    assert.equal((await save(false)).status, 200);
    visible = true;
    assert.equal(
      (await (await fetch(base + "?view=watching")).json()).total,
      0,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});

test("优先券排除72小时全部禁用；部分禁用保留原文，缺失与错轮规则不伪装可用", () => {
  const rules = [
    {
      run_id: "run",
      product_id: "1",
      observed_at: at,
      rules: [
        {
          key: "use_date",
          name: "日期",
          value: [
            { content: "不可用日期：周一、周二、周三、周四、周五、周六、周日" },
          ],
        },
      ],
    },
  ];
  const blocked = combinePicks([heat()], [signal], now, [], rules);
  assert.equal(blocked[0].use_outlook.fully_excluded, true);
  assert.equal(
    selectPicks(blocked, { ...query, view: "recommended" }).filtered.length,
    0,
  );
  assert.equal(selectPicks(blocked, query).filtered.length, 1);
  assert.ok(picksCsv(blocked).includes("明确全部不可用"));
  const partial = combinePicks(
    [heat()],
    [signal],
    now,
    [],
    [
      {
        ...rules[0],
        rules: [
          {
            key: "use_date",
            name: "日期",
            value: [
              {
                content: `不可用日期：${blocked[0].use_outlook.days[0].weekday}`,
              },
            ],
          },
        ],
      },
    ],
  );
  assert.equal(partial[0].use_outlook.has_explicit_exclusion, true);
  assert.equal(partial[0].use_outlook.fully_excluded, false);
  assert.equal(
    selectPicks(partial, { ...query, view: "recommended" }).filtered.length,
    1,
  );

  const unmatched = combinePicks(
    [heat()],
    [signal],
    now,
    [],
    [{ ...rules[0], run_id: "old" }],
  );
  assert.equal(unmatched[0].use_outlook.evidence_status, "missing_or_stale");
  assert.equal(
    selectPicks(unmatched, { ...query, view: "recommended" }).filtered.length,
    1,
  );
  const zero = combinePicks([heat("1", "100")], [], now);
  assert.equal(
    selectPicks(zero, { ...query, view: "recommended" }).filtered.length,
    0,
  );
});
