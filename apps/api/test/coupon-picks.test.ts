import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  combinePicks,
  isHotPick,
  picksCsv,
  priorityAdmission,
  registerCouponPicks,
  selectPicks,
} from "../src/coupon-picks.js";
import { initCoupons } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";
import { createOpportunityBoard } from "../src/opportunity-board.js";
import { salesTrend } from "../src/sales-heat.js";

const now = Date.now(),
  at = new Date(now - 3600000).toISOString();
function heat(id = "1", sales = "120", original?: number) {
  const points = [
    {
      run_id: "run",
      observed_at: at,
      payload: {
        monthly_sales: sales,
        platform_brand_id: "platform",
        identity: "name_match",
        origin_price_fen: original,
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
    assert.equal(ranked.model.version, "priority-v7");
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
    0,
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
    0,
  );
  const zero = combinePicks([heat("1", "100")], [], now);
  assert.equal(
    selectPicks(zero, { ...query, view: "recommended" }).filtered.length,
    0,
  );
});

test("已有快照原价传入评分和CSV，不依赖历史降价事件", () => {
  const pick = combinePicks([heat("1", "120", 1600)], [], now)[0];
  assert.equal(pick.origin_price_fen, 1600);
  assert.equal(pick.discount.rate, 0.5);
  assert.equal(
    pick.priority.parts.find((p) => p.name === "原价折扣")?.value,
    25,
  );
  const lines = picksCsv([pick]).split("\r\n");
  assert.equal(lines[0].split(",").length, lines[1].split(",").length);
});

test("弱优惠即使热销也不进入优先券，仍可在全部券查看", () => {
  const item = combinePicks([heat("1", "120", 808)], [signal], now)[0];
  assert.equal(item.priority.value_gate.eligible, false);
  assert.ok(item.priority.score < 5);
  assert.equal(
    selectPicks([item], { ...query, view: "recommended" }).filtered.length,
    0,
  );
  assert.equal(
    selectPicks([item], { ...query, view: "all" }).filtered.length,
    1,
  );
});

test("业态筛选不混入其他分类，仍保留完整券列表", () => {
  const rows = combinePicks([heat("1"), heat("2")], []);
  rows[0].category = "亲子乐园";
  rows[1].category = "茶饮果饮";
  const result = selectPicks(rows, { ...query, category: "亲子乐园" });
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0].product_id, "1");
  assert.equal(result.counts.all, 1);
});

test("美食游玩在排名、统计及筛选前隔离，不被另一频道前500挤掉", () => {
  const [food, leisure] = combinePicks([heat("food"), heat("play")], []);
  food.category = "其他餐饮";
  leisure.category = "亲子乐园";
  for (const p of [food, leisure]) {
    p.priority.value_gate.eligible = true;
    p.priority.score = 80;
    p.priority.value_gate.rate = 0.4;
    p.use_outlook.fully_excluded = false;
  }
  const rows = [
    ...Array.from({ length: 510 }, (_, i) => ({
      ...food,
      brand_id: `brand${i}`,
      product_id: `f${i}`,
    })),
    leisure,
  ];
  const play = selectPicks(rows, {
    ...query,
    channel: "leisure",
    view: "recommended",
  });
  assert.equal(play.counts.all, 1);
  assert.deepEqual(
    play.filtered.map((p) => p.product_id),
    ["play"],
  );
  const dining = selectPicks(rows, { ...query, channel: "food", view: "all" });
  assert.equal(dining.filtered.length, 510);
  assert.equal(dining.counts.recommended, 500);
  assert.equal(
    selectPicks(rows, { ...query, channel: "food", category: "亲子乐园" })
      .filtered.length,
    0,
  );
});

test("新上保留24小时，后续无变化轮次仍保留，临界点自动撤销加分", async () => {
  const { updatePoolClock } = await import("../src/coupon-pool.js");
  const discovery = {
    brand_id: "brand",
    product_id: "1",
    discovered_at: new Date(now - 23 * 3600000).toISOString(),
  };
  const regular = combinePicks([heat("1", "120", 1600)], [], now)[0];
  const fresh = combinePicks(
    [heat("1", "120", 1600)],
    [],
    now,
    [],
    [],
    [],
    [],
    [discovery],
  )[0];
  assert.equal(fresh.is_new, true);
  assert.equal(fresh.priority.score, regular.priority.score + 12.5);
  assert.equal(
    selectPicks([fresh], { ...query, view: "new" }).filtered.length,
    1,
  );
  const expired = updatePoolClock(fresh, now + 3600000);
  assert.equal(expired.is_new, false);
  assert.equal(expired.priority.score, regular.priority.score);
  assert.equal(
    selectPicks([expired], { ...query, view: "new" }).filtered.length,
    0,
  );
  const future = combinePicks(
    [heat()],
    [],
    now,
    [],
    [],
    [],
    [],
    [{ ...discovery, discovered_at: new Date(now + 1).toISOString() }],
  )[0];
  assert.equal(future.is_new, false);
});

test("黑名单在前500排名之前排除，全部券保留，移除后恢复推荐", () => {
  const [item] = combinePicks([heat()], []);
  item.priority.value_gate.eligible = true;
  item.priority.score = 80;
  item.priority.value_gate.rate = 0.4;
  item.use_outlook.fully_excluded = false;
  const rows = Array.from({ length: 510 }, (_, i) => ({
    ...item,
    brand_id: `brand${i}`,
    product_id: `${i}`,
  }));
  const blocked = new Set(rows.slice(0, 10).map((r) => r.brand_id));
  const q = { ...query, view: "recommended" as const };
  const selected = selectPicks(rows, q, blocked);
  assert.equal(selected.filtered.length, 500);
  assert.equal(selected.counts.recommended, 500);
  assert.ok(selected.filtered.every((r) => !blocked.has(r.brand_id)));
  assert.equal(selectPicks(rows, query, blocked).filtered.length, 510);
  assert.equal(selectPicks([rows[0]], q, blocked).filtered.length, 0);
  assert.equal(selectPicks([rows[0]], q).filtered.length, 1);
});

test("优先券质量门槛、新券独立入选、品牌配额与热角标", () => {
  const item = combinePicks([heat()], [], now)[0];
  item.priority.value_gate = {
    rate: 0.4,
    factor: 1,
    eligible: true,
    reason: "test",
  };
  item.priority.score = 45;
  item.speed = 6;
  item.net_change = 12;
  item.previous_speed = 3;
  item.hours = 1;
  item.acceleration = 1;
  assert.equal(priorityAdmission(item), true);
  assert.equal(isHotPick(item), true);
  assert.equal(isHotPick({ ...item, acceleration: 0 }), false);
  assert.equal(priorityAdmission({ ...item, speed: null }), false);
  assert.equal(
    priorityAdmission({ ...item, priority: { ...item.priority, score: 39 } }),
    false,
  );
  assert.equal(
    priorityAdmission({
      ...item,
      is_new: true,
      speed: null,
      priority: { ...item.priority, score: 30 },
    }),
    true,
  );
  assert.equal(
    priorityAdmission({
      ...item,
      is_new: true,
      speed: null,
      priority: { ...item.priority, score: 29 },
    }),
    false,
  );
  assert.equal(
    priorityAdmission({
      ...item,
      speed: null,
      kind: "price_drop",
      reduction_rate: 0.15,
      saving_fen: 1000,
    }),
    true,
  );
  assert.equal(
    priorityAdmission({
      ...item,
      speed: null,
      kind: "price_drop",
      reduction_rate: 0.15,
      saving_fen: 100,
    }),
    false,
  );
  assert.equal(
    priorityAdmission({
      ...item,
      priority: {
        ...item.priority,
        value_gate: { ...item.priority.value_gate, rate: 0.19 },
      },
    }),
    false,
  );
  const rows = Array.from({ length: 6 }, (_, i) => ({
    ...item,
    product_id: String(i),
  }));
  assert.equal(
    selectPicks(rows, { ...query, view: "recommended" }).filtered.length,
    3,
  );
  assert.equal(selectPicks(rows, query).filtered.length, 6);
});

test("明显增长加快排除微涨、低基数和不可比窗口", () => {
  const item = {
    ...combinePicks([heat()], [], now)[0],
    speed: 13,
    previous_speed: 10,
    acceleration: 1,
    net_change: 26,
    hours: 2,
  };
  assert.equal(isHotPick(item), true);
  for (const change of [
    { speed: 12.9 },
    { speed: 5, previous_speed: 4 },
    { net_change: 9 },
    { previous_speed: null },
    { previous_speed: -1 },
    { speed: 9, previous_speed: 0 },
    { acceleration: 0 },
    { hours: 0.5 },
  ]) {
    const row = { ...item, ...change };
    assert.equal(isHotPick(row), false, JSON.stringify(change));
    assert.equal(
      selectPicks([row], { ...query, view: "accelerating" }).filtered.length,
      0,
    );
  }
  assert.equal(isHotPick({ ...item, speed: 10, previous_speed: 0 }), true);
  assert.equal(
    selectPicks([item], { ...query, view: "accelerating" }).counts.accelerating,
    1,
  );
});

test("新上默认按发现时间倒序，刷新时间不改变上新顺序", () => {
  const rows = combinePicks([heat("1"), heat("2")], []);
  rows[0].is_new = true;
  rows[1].is_new = true;
  rows[0].discovered_at = new Date(now - 7200000).toISOString();
  rows[1].discovered_at = new Date(now - 3600000).toISOString();
  rows[0].observed_at = new Date(now).toISOString();
  const q = { view: "new" as const, search: "", offset: 0, limit: 20 };
  assert.deepEqual(
    selectPicks(rows, q).filtered.map((x) => x.product_id),
    ["2", "1"],
  );
  assert.deepEqual(
    selectPicks(rows, { ...q, order: "newest" }).filtered.map(
      (x) => x.product_id,
    ),
    ["2", "1"],
  );
});
