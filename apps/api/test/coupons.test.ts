import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  buildSelectionUrl,
  createCoupons,
  normalizeCoupon,
  parseLossless,
  SerialGate,
  slotAt,
} from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

function gate() {
  let now = 0;
  return new SerialGate(
    async (ms) => {
      now += ms;
    },
    () => now,
    () => 0,
  );
}
function product(price = 1200, id = "9007199254740993", brand = "品牌甲") {
  return {
    product_id: id,
    product_info: {
      product_name: "双人套餐",
      price_range: { min: price, max: price },
      origin_price: 0,
      status: 1,
    },
    nearest_poi_info: {
      brand_data: { brand_name: brand, brand_id: "9999999999999999" },
      poi_id: "123",
      poi_name: "上海店",
    },
  };
}
test("保留大整数、未知原价；牛New不匹配其他寿喜烧商家", () => {
  assert.deepEqual(parseLossless('{"id":9007199254740993,"price":1200}'), {
    id: "9007199254740993",
    price: 1200,
  });
  const c = normalizeCoupon(product(), ["品牌甲"]);
  assert.equal(c.origin_price_fen, null);
  assert.equal(c.identity, "name_match");
  assert.equal(
    normalizeCoupon(product(1200, "123", "大志"), ["牛New"]).identity,
    "unresolved",
  );
  assert.equal(
    slotAt(new Date("2026-09-20T16:01:00Z")),
    "2026-09-21T00:00:00+08:00",
  );
  assert.equal(
    slotAt(new Date("2026-09-21T04:00:00Z")),
    "2026-09-21T12:00:00+08:00",
  );
});
test("并发调用和失败重试都按完成时间间隔至少1秒串行", async () => {
  let clock = 0,
    active = 0,
    peak = 0;
  const starts: number[] = [];
  const ends: number[] = [];
  const g = new SerialGate(
    async (ms) => {
      clock += ms;
    },
    () => clock,
    () => 0.5,
  );
  await Promise.allSettled(
    [0, 1, 2].map((i) =>
      g.run(async () => {
        starts.push(clock);
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        clock += 20;
        active--;
        ends.push(clock);
        if (i === 1) throw new Error("error");
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(starts[1] - ends[0], 1500);
  assert.equal(starts[2] - ends[1], 1500);
});
test("完整基线、价格变化、部分失败不覆盖基线、暂停与恢复", async () => {
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','test','火锅','https://example.com')",
    [id],
  );
  let price = 1200,
    fail = false,
    calls = 0;
  const service = createCoupons(db, {
    gate: gate(),
    retryDelayMs: 0,
    fetchPage: async (_name, cursor) => {
      calls++;
      if (fail && cursor === "12") throw new Error("NETWORK_ERROR");
      return {
        status_code: 0,
        cursor: cursor === "0" ? 12 : 24,
        has_more: cursor === "0",
        product_list: [product(price, cursor === "0" ? "123" : "456")],
      };
    },
  });
  try {
    const first = await service.start([id]);
    await service.drain();
    assert.equal(calls, 2);
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM coupon_diffs WHERE kind='BASELINE'",
        )
      ).rows[0].n,
      2,
    );
    price = 1000;
    await service.start([id]);
    await service.drain();
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM coupon_diffs WHERE kind='PRICE_CHANGED_UNVERIFIED'",
        )
      ).rows[0].n,
      2,
    );
    const base = (
      await db.query<{ run_id: string }>("SELECT run_id FROM coupon_baselines")
    ).rows[0].run_id;
    assert.notEqual(base, first);
    fail = true;
    await service.start([id]);
    await service.drain();
    assert.equal(
      (
        await db.query<{ run_id: string }>(
          "SELECT run_id FROM coupon_baselines",
        )
      ).rows[0].run_id,
      base,
    );
    const auth = createCoupons(db, {
      gate: gate(),
      retryDelayMs: 0,
      fetchPage: async () => {
        throw new Error("AUTH_EXPIRED");
      },
    });
    await auth.start([id]);
    await auth.drain();
    assert.equal(
      (
        await db.query<{ pause_reason: string }>(
          "SELECT pause_reason FROM coupon_settings",
        )
      ).rows[0].pause_reason,
      "AUTH_EXPIRED",
    );
    fail = false;
    await db.exec("UPDATE coupon_settings SET pause_reason=NULL");
    service.kick();
    await service.drain();
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM coupon_runs WHERE status='running'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await service.stop();
    await db.close();
  }
});
test("重复游标不提交基线，定时轮次幂等", async () => {
  const db = await openDatabase(),
    id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'甲','a','火锅','https://example.com')",
    [id],
  );
  const s = createCoupons(db, {
    gate: gate(),
    retryDelayMs: 0,
    fetchPage: async () => ({
      status_code: 0,
      cursor: 0,
      has_more: true,
      product_list: [product()],
    }),
  });
  try {
    await s.start([id], "slot");
    await s.drain();
    assert.equal(
      (await db.query("SELECT * FROM coupon_baselines")).rows.length,
      0,
    );
    assert.equal(await s.start([id], "slot"), null);
  } finally {
    await s.stop();
    await db.close();
  }
});

test("网络失败最多重试两次，审计脱敏，分页不截断商品", async () => {
  const { default: express } = await import("express");
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','retry','火锅','https://example.com')",
    [id],
  );
  let calls = 0;
  let mode = "recover";
  const service = createCoupons(db, {
    gate: gate(),
    retryDelayMs: 0,
    fetchPage: async () => {
      calls++;
      if (mode === "fail" || (mode === "recover" && calls < 3))
        throw new Error("NETWORK_ERROR");
      if (mode === "limit") throw new Error("RATE_LIMITED");
      return {
        status_code: 0,
        cursor: 101,
        has_more: false,
        product_list: Array.from({ length: 101 }, (_, i) =>
          product(1200, String(i + 1)),
        ),
      };
    },
  });
  const app = express();
  service.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/v3`;
  try {
    const run = await service.start([id]);
    await service.drain();
    assert.equal(calls, 3);
    const audit = await (await fetch(`${root}/runs/${run}/requests`)).json();
    assert.equal(audit.summary.total, 3);
    assert.deepEqual(
      audit.items.map((x: { outcome: string }) => x.outcome),
      ["NETWORK_ERROR", "NETWORK_ERROR", "OK"],
    );
    assert.ok(audit.items.every((x: { finished_at: string }) => x.finished_at));
    const pages = [];
    for (const offset of [0, 50, 100]) {
      const page = await (
        await fetch(
          `${root}/opportunities?view=matched&brand_id=${id}&offset=${offset}`,
        )
      ).json();
      assert.equal(page.total, 101);
      pages.push(...page.items);
    }
    assert.equal(new Set(pages.map((x) => x.product_id)).size, 101);
    const history = await (
      await fetch(`${root}/coupons/1/history?brand_id=${id}`)
    ).json();
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].comparison_status, "FIRST_BASELINE");
    const other = await (
      await fetch(`${root}/coupons/1/history?brand_id=${randomUUID()}`)
    ).json();
    assert.equal(other.items.length, 0);
    mode = "fail";
    calls = 0;
    await service.start([id]);
    await service.drain();
    assert.equal(calls, 3);
    assert.equal(
      (
        await db.query<{ run_id: string }>(
          "SELECT run_id FROM coupon_baselines",
        )
      ).rows[0].run_id,
      run,
    );
    mode = "limit";
    calls = 0;
    await service.start([id]);
    await service.drain();
    assert.equal(calls, 1);
    assert.equal(
      (
        await db.query<{ pause_reason: string }>(
          "SELECT pause_reason FROM coupon_settings",
        )
      ).rows[0].pause_reason,
      "RATE_LIMITED",
    );
  } finally {
    await service.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await db.close();
  }
});

test("未见记录可查询；陈旧、旧版和不同查询口径只重建基线", async () => {
  const { default: express } = await import("express");
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','baseline-guard','火锅','https://example.com')",
    [id],
  );
  let products = [product()];
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async () => ({
      status_code: 0,
      cursor: 12,
      has_more: false,
      product_list: products,
    }),
  });
  const app = express();
  service.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/v3`;
  async function scan() {
    const run = await service.start([id]);
    await service.drain();
    return run;
  }
  async function resetExpected(status: string) {
    const run = await scan();
    assert.equal(
      (
        await db.query<{ comparison_status: string }>(
          "SELECT comparison_status FROM coupon_tasks WHERE run_id=$1",
          [run],
        )
      ).rows[0].comparison_status,
      status,
    );
    const diffs = (
      await db.query<{ kind: string; old_payload: unknown }>(
        "SELECT kind,old_payload FROM coupon_diffs WHERE run_id=$1",
        [run],
      )
    ).rows;
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].kind, "BASELINE_RESET");
    assert.equal(diffs[0].old_payload, null);
  }
  try {
    await scan();
    products = [];
    await scan();
    const missing = await (
      await fetch(`${root}/opportunities?view=not_seen`)
    ).json();
    assert.equal(missing.total, 1);
    assert.equal(missing.items[0].historical_only, true);
    assert.equal(missing.items[0].assessment.delta_fen, null);
    const current = await (
      await fetch(`${root}/opportunities?view=all`)
    ).json();
    assert.equal(current.total, 0);
    products = [product(1000)];
    await scan();
    await db.exec(
      "UPDATE coupon_tasks SET completed_at=now()-interval '37 hours' WHERE state='complete'",
    );
    await resetExpected("STALE_BASELINE");
    await db.query("UPDATE brands SET aliases=$2 WHERE id=$1", [
      id,
      JSON.stringify(["品牌新别名"]),
    ]);
    await resetExpected("QUERY_CHANGED");
    await db.exec(
      "UPDATE coupon_tasks SET query_signature=NULL WHERE state='complete'",
    );
    await resetExpected("LEGACY_BASELINE");
    const changes = await (
      await fetch(`${root}/opportunities?view=changes`)
    ).json();
    assert.equal(changes.total, 0);
  } finally {
    await service.stop();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});

test("结束页重复已采商品也不能发布完整基线", async () => {
  const db = await openDatabase(),
    id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','repeat-final','火锅','https://example.com')",
    [id],
  );
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async (_name, cursor) => ({
      status_code: 0,
      cursor: cursor === "0" ? 12 : 24,
      has_more: cursor === "0",
      product_list: [product()],
    }),
  });
  try {
    await service.start([id]);
    await service.drain();
    assert.equal(
      (await db.query("SELECT * FROM coupon_baselines")).rows.length,
      0,
    );
    const task = (
      await db.query<{ state: string; error_code: string }>(
        "SELECT state,error_code FROM coupon_tasks",
      )
    ).rows[0];
    assert.equal(task.state, "partial");
    assert.equal(task.error_code, "PAGINATION_INVALID");
  } finally {
    await service.stop();
    await db.close();
  }
});

test("选品查询限定美食且不锁定仅直播，中文关键词正确编码", () => {
  const url = buildSelectionUrl("牛New寿喜烧", "12");
  assert.equal(url.origin, "https://eos.douyin.com");
  assert.equal(url.searchParams.get("first_category"), "1000000");
  assert.equal(url.searchParams.get("city"), "310000");
  assert.equal(url.searchParams.has("scene"), false);
  assert.equal(url.searchParams.get("key_word"), "牛New寿喜烧");
  assert.equal(url.searchParams.get("cursor"), "12");
});

test("sales provenance retains bounded primitive count fields without treating them as validated sales", () => {
  const raw = product();
  Object.assign(raw.product_info, {
    sold_count_display: "1万+",
    sold_count: 12345,
    sales_count_detail: { secret: "excluded" },
    cookie: "excluded",
  });
  const c = normalizeCoupon(raw, ["品牌甲"]);
  const evidence = c.source_evidence?.sales as {
    raw: string;
    semantics: string;
    observed_count_fields: Record<string, unknown>;
  };
  assert.equal(c.monthly_sales, "1万+");
  assert.equal(evidence.raw, "1万+");
  assert.equal(evidence.semantics, "unverified");
  assert.deepEqual(evidence.observed_count_fields, {
    sold_count_display: "1万+",
    sold_count: 12345,
  });
});

test("new scheduled slots queue independently during an unfinished scan, deduplicate and execute serially", async () => {
  const db = await openDatabase(),
    id = randomUUID();
  let calls = 0,
    active = 0,
    peak = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','slot-overrun','火锅','https://example.com')",
    [id],
  );
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 1) {
        entered();
        await hold;
      }
      if (calls === 2) {
        const previous = (
          await db.query<{ status: string; finished_at: string | null }>(
            "SELECT status,finished_at FROM coupon_runs WHERE slot='2026-09-29T00:00:00+08:00'",
          )
        ).rows[0];
        assert.equal(previous.status, "complete");
        assert.ok(previous.finished_at);
      }
      active--;
      return {
        status_code: 0,
        cursor: "0",
        has_more: false,
        product_list: [product()],
      };
    },
  });
  try {
    const morning = await service.start([id], "2026-09-29T00:00:00+08:00");
    await started;
    const noon = await service.start([id], "2026-09-29T12:00:00+08:00");
    assert.ok(noon);
    assert.notEqual(noon, morning);
    assert.equal(await service.start([id], "2026-09-29T12:00:00+08:00"), null);
    assert.equal(await service.start([id], "2026-09-29T00:00:00+08:00"), null);
    assert.equal(await service.start([id]), morning);
    assert.equal(calls, 1);
    assert.equal((await db.query("SELECT * FROM coupon_tasks")).rows.length, 2);
    release();
    await service.drain();
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    const rows = (
      await db.query<{ status: string }>("SELECT status FROM coupon_runs")
    ).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === "complete"));
    assert.equal(
      (
        await db.query<{ run_id: string }>(
          "SELECT run_id FROM coupon_baselines",
        )
      ).rows[0].run_id,
      noon,
    );
  } finally {
    release();
    await service.stop();
    await db.close();
  }
});

test("scheduler resumes persisted current-slot work without creating a duplicate run", async () => {
  const db = await openDatabase(),
    id = randomUUID();
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    return {
      status_code: 0,
      cursor: "0",
      has_more: false,
      product_list: [product()],
    };
  };
  const first = createCoupons(db, { gate: gate(), fetchPage });
  let resumed: ReturnType<typeof createCoupons> | undefined;
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','slot-resume','火锅','https://example.com')",
      [id],
    );
    await db.query(
      "UPDATE coupon_settings SET enabled=true,pause_reason='USER_PAUSED'",
    );
    await first.start([id], slotAt(new Date()));
    await first.drain();
    await first.stop();
    assert.equal(calls, 0);
    await db.query("UPDATE coupon_settings SET pause_reason=NULL");
    resumed = createCoupons(db, { gate: gate(), fetchPage });
    await resumed.schedule();
    await resumed.drain();
    assert.equal(calls, 1);
    assert.equal((await db.query("SELECT * FROM coupon_runs")).rows.length, 1);
    await resumed.schedule();
    await resumed.drain();
    assert.equal(calls, 1);
  } finally {
    await first.stop();
    await resumed?.stop();
    await db.close();
  }
});

test("请求超时全局暂停、不重试且保留原游标供恢复", async () => {
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','deadline','火锅','https://example.com')",
    [id],
  );
  let calls = 0;
  const cursors: string[] = [];
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async (_, cursor) => {
      calls++;
      cursors.push(cursor);
      if (calls === 1) throw new Error("REQUEST_TIMEOUT");
      return { status_code: 0, cursor: 0, has_more: false, product_list: [] };
    },
  });
  try {
    await service.start([id]);
    await service.drain();
    assert.equal(calls, 1);
    assert.equal(
      (await db.query("SELECT pause_reason FROM coupon_settings")).rows[0]
        .pause_reason,
      "REQUEST_TIMEOUT",
    );
    const task = (
      await db.query(
        "SELECT state,retries,cursor FROM coupon_tasks WHERE brand_id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(task.state, "queued");
    assert.equal(task.retries, 0);
    const audit = (
      await db.query("SELECT outcome,finished_at FROM coupon_requests")
    ).rows[0];
    assert.equal(audit.outcome, "REQUEST_TIMEOUT");
    assert.ok(audit.finished_at);
    await db.exec("UPDATE coupon_settings SET pause_reason=NULL");
    service.kick();
    await service.drain();
    assert.deepEqual(cursors, [task.cursor, task.cursor]);
    assert.equal(
      (await db.query("SELECT state FROM coupon_tasks WHERE brand_id=$1", [id]))
        .rows[0].state,
      "complete",
    );
  } finally {
    await service.stop();
    await db.close();
  }
});

test("暂停接口不等待未结束请求，返回排空状态且不启动下一页", async () => {
  const { default: express } = await import("express");
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','pause-deadline','火锅','https://example.com')",
    [id],
  );
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async () => {
      calls++;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const app = express();
  app.use(express.json());
  service.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await service.start([id]);
    await started;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v3/settings`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
        signal: AbortSignal.timeout(2000),
      },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.pause_reason, "USER_PAUSED");
    assert.equal(result.worker_active, true);
    release({
      status_code: 0,
      cursor: 1,
      has_more: true,
      product_list: [product()],
    });
    await service.drain();
    assert.equal(calls, 1);
  } finally {
    release?.({ status_code: 0, cursor: 0, has_more: false, product_list: [] });
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test("failed previous slot closes as partial before the next slot starts", async () => {
  const db = await openDatabase();
  const id = randomUUID();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  let priorClosed = false;
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','partial-slot','火锅','https://example.com')",
    [id],
  );
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async () => {
      if (++calls === 1) {
        entered();
        await hold;
        throw new Error("INVALID_PRODUCT");
      }
      const row = (
        await db.query<{ status: string; finished_at: string | null }>(
          "SELECT status,finished_at FROM coupon_runs WHERE slot='2026-09-29T00:00:00+08:00'",
        )
      ).rows[0];
      priorClosed = row.status === "partial" && !!row.finished_at;
      return {
        status_code: 0,
        cursor: "0",
        has_more: false,
        product_list: [product()],
      };
    },
  });
  try {
    await service.start([id], "2026-09-29T00:00:00+08:00");
    await started;
    await service.start([id], "2026-09-29T12:00:00+08:00");
    release();
    await service.drain();
    assert.equal(priorClosed, true);
    assert.equal(calls, 2);
  } finally {
    release();
    await service.stop();
    await db.close();
  }
});

test("低匹配查询三页止损，保留历史基线且不产生下架结论", async () => {
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','low-yield','火锅','https://example.com')",
    [id],
  );
  let baseline = true;
  let calls = 0;
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async (_name, cursor) => {
      calls++;
      return {
        status_code: 0,
        cursor: Number(cursor) + 12,
        has_more: !baseline,
        product_list: [product(1200, `item-${cursor}`, "其他品牌")],
      };
    },
  });
  try {
    const first = await service.start([id]);
    await service.drain();
    baseline = false;
    calls = 0;
    const second = await service.start([id]);
    await service.drain();
    assert.equal(calls, 3);
    const task = (
      await db.query(
        "SELECT state,pages,error_code,comparison_status FROM coupon_tasks WHERE run_id=$1",
        [second],
      )
    ).rows[0];
    assert.deepEqual(task, {
      state: "partial",
      pages: 3,
      error_code: "NO_BRAND_MATCH",
      comparison_status: "INCOMPLETE",
    });
    assert.equal(
      (
        await db.query(
          "SELECT run_id FROM coupon_baselines WHERE brand_id=$1",
          [id],
        )
      ).rows[0].run_id,
      first,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM coupon_diffs WHERE run_id=$1",
          [second],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await service.stop();
    await db.close();
  }
});

test("第三页命中继续翻页；有历史匹配的品牌不触发低匹配止损", async () => {
  const db = await openDatabase();
  const id = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','matched-pagination','火锅','https://example.com')",
    [id],
  );
  let historical = false;
  let calls = 0;
  const service = createCoupons(db, {
    gate: gate(),
    fetchPage: async (_name, cursor) => {
      calls++;
      const page = Number(cursor) / 12;
      return {
        status_code: 0,
        cursor: Number(cursor) + 12,
        has_more: page < 4,
        product_list: [
          product(
            1200,
            `item-${page}`,
            !historical && page === 2 ? "品牌甲" : "其他品牌",
          ),
        ],
      };
    },
  });
  try {
    await service.start([id]);
    await service.drain();
    assert.equal(calls, 5);
    historical = true;
    calls = 0;
    const run = await service.start([id]);
    await service.drain();
    assert.equal(calls, 5);
    assert.equal(
      (await db.query("SELECT state FROM coupon_tasks WHERE run_id=$1", [run]))
        .rows[0].state,
      "complete",
    );
  } finally {
    await service.stop();
    await db.close();
  }
});
