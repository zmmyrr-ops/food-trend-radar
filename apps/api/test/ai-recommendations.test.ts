import assert from "node:assert/strict";
import test from "node:test";
import {
  aiCandidateBrief,
  aiCandidates,
  createAiRecommendations,
  validateAiOutput,
} from "../src/ai-recommendations.js";
import { combinePicks } from "../src/coupon-picks.js";
import { openDatabase } from "../src/db.js";
import { salesTrend } from "../src/sales-heat.js";

function pick() {
  const now = Date.now();
  const points = [0, 12].map((h, i) => ({
    run_id: String(i),
    observed_at: new Date(now - h * 3600000).toISOString(),
    payload: {
      monthly_sales: String(120 - i * 20),
      platform_brand_id: "p",
      identity: "name_match",
      origin_price_fen: 200,
      price_min_fen: 100,
      price_max_fen: 100,
      name: "测试券",
    },
  }));
  return combinePicks(
    [
      {
        brand_id: "b",
        brand_name: "品牌",
        product_id: "1",
        title: "测试券",
        price_fen: 100,
        ...salesTrend(points, now),
      },
    ],
    [],
    now,
  )[0];
}
const reply = {
  summary: "建议核验后拍摄",
  recommendations: [
    {
      id: "b:1",
      reason: "观察销量增长",
      angle: "实际到店测评",
      risks: ["门店未知"],
    },
  ],
  limitations: ["非爆款概率"],
};
test("AI candidates exclude stale/unusable, diversify brands, and reject invented or duplicate IDs", () => {
  const p = pick();
  const rows = aiCandidates([
    p,
    {
      ...p,
      brand_id: "weak-offer",
      priority: {
        ...p.priority,
        value_gate: { ...p.priority.value_gate, eligible: false },
      },
    },
    { ...p, product_id: "2" },
    { ...p, product_id: "3" },
    { ...p, product_id: "4" },
    { ...p, brand_id: "other" },
    {
      ...p,
      brand_id: "expired",
      observed_at: new Date(Date.now() - 37 * 3600000).toISOString(),
    },
    {
      ...p,
      brand_id: "excluded",
      use_outlook: { ...p.use_outlook, fully_excluded: true },
    },
  ]);
  assert.equal(rows.length, 4);
  assert.equal(
    validateAiOutput({ ...reply, limitations: Array(10).fill("需核验") }, rows)
      .limitations.length,
    10,
  );
  assert.equal(
    validateAiOutput(reply, rows).recommendations[0].evidence.price_fen,
    100,
  );
  assert.throws(() =>
    validateAiOutput(
      {
        ...reply,
        recommendations: [{ ...reply.recommendations[0], id: "invented" }],
      },
      rows,
    ),
  );
  assert.throws(() =>
    validateAiOutput(
      {
        ...reply,
        recommendations: [...reply.recommendations, ...reply.recommendations],
      },
      rows,
    ),
  );
});
test("AI request stays backend-only, deduplicates work and persists validated evidence", async () => {
  const db = await openDatabase();
  let calls = 0;
  try {
    const service = await createAiRecommendations(db, {
      readPicks: async () => [pick()],
      readContext: async () => ({ weather: "unknown" }),
      credentialPath: "unused",
      getKey: async () => "private-test-key",
      fetcher: async (url, options) => {
        calls++;
        assert.equal(url, "https://api.deepseek.com/chat/completions");
        assert.equal(options?.redirect, "error");
        const body = JSON.parse(String(options?.body));
        assert.equal(body.response_format.type, "json_object");
        const input = JSON.parse(body.messages[1].content);
        assert.equal(input.candidates[0].id, "C01");
        assert.equal(input.candidates[0].当前票面价格, "1.00元");
        assert.equal("price_fen" in input.candidates[0], false);
        assert.ok(body.messages[0].content.includes("禁止以分为金额单位"));
        assert.equal(String(options?.body).includes("private-test-key"), false);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    ...reply,
                    recommendations: [
                      {
                        ...reply.recommendations[0],
                        id: "C01",
                        extra: "discard",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      },
    });
    assert.equal(await service.start(), "started");
    assert.equal(await service.start(), "running");
    await service.drain();
    assert.equal(calls, 1);
    const state = await service.status();
    assert.ok(state.report);
    assert.equal(state.error, null);
    assert.equal(JSON.stringify(state).includes("private-test-key"), false);
    assert.equal(await service.start(), "cooldown");
  } finally {
    await db.close();
  }
});
test("provider failures and malformed content never replace a successful report or leak body", async () => {
  const db = await openDatabase();
  try {
    for (const response of [
      () => new Response("secret body", { status: 401 }),
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    ...reply,
                    recommendations: [
                      { ...reply.recommendations[0], id: "invented" },
                    ],
                  }),
                },
              },
            ],
          }),
        ),
    ]) {
      const service = await createAiRecommendations(db, {
        readPicks: async () => [pick()],
        readContext: async () => null,
        credentialPath: "unused",
        getKey: async () => "key",
        fetcher: async () => response(),
      });
      await db.query("INSERT INTO ai_coupon_reports(payload) VALUES($1)", [
        JSON.stringify({ summary: "prior" }),
      ]);
      await service.start();
      await service.drain();
      const status = await service.status();
      assert.equal(status.report?.summary, "prior");
      assert.ok(status.error);
      assert.equal(JSON.stringify(status).includes("secret body"), false);
    }
  } finally {
    await db.close();
  }
});

test("short references resolve to stored IDs; extra model fields never override evidence", () => {
  const candidates = aiCandidates([pick()]);
  const result = validateAiOutput(
    {
      ...reply,
      score: 99,
      recommendations: [
        {
          ...reply.recommendations[0],
          id: " C01 ",
          price_fen: 1,
          evidence: { price_fen: 1 },
          score: 100,
        },
      ],
    },
    candidates,
  );
  assert.equal(result.recommendations[0].id, "b:1");
  assert.equal(result.recommendations[0].evidence.price_fen, 100);
  assert.equal("score" in result, false);
  assert.equal("price_fen" in result.recommendations[0], false);
  for (const id of ["C02", "1", "invented"]) {
    assert.throws(() =>
      validateAiOutput(
        { ...reply, recommendations: [{ ...reply.recommendations[0], id }] },
        candidates,
      ),
    );
  }
  assert.throws(() =>
    validateAiOutput(
      {
        ...reply,
        recommendations: [
          reply.recommendations[0],
          { ...reply.recommendations[0], id: "C01" },
        ],
      },
      candidates,
    ),
  );
  assert.throws(() =>
    validateAiOutput(
      { ...reply, recommendations: [{ id: "C01", reason: "缺少角度和风险" }] },
      candidates,
    ),
  );
});

test("AI brief converts every money field exactly once and preserves unknown prices", () => {
  const c = aiCandidates([pick()])[0];
  const brief = aiCandidateBrief(
    {
      ...c,
      price_fen: 1990,
      origin_price_fen: 3000,
      previous_price_fen: 2500,
      saving_fen: 510,
    },
    0,
  );
  assert.equal(brief.当前票面价格, "19.90元");
  assert.equal(brief.平台原价, "30.00元");
  assert.equal(brief.上次票面价格, "25.00元");
  assert.equal(brief.较上次节省, "5.10元");
  assert.equal(
    aiCandidateBrief({ ...c, price_fen: null }, 0).当前票面价格,
    "未知",
  );
  assert.equal(
    aiCandidateBrief({ ...c, saving_fen: 0 }, 0).较上次节省,
    "0.00元",
  );
  assert.equal(JSON.stringify(brief).includes("price_fen"), false);
  assert.equal(JSON.stringify(brief).includes("no_verified_change"), false);
});

test("AI频道筛选先于候选截取，报告独立保存，旧综合报告不混入", async () => {
  const db = await openDatabase();
  try {
    const food = { ...pick(), category: "其他餐饮", brand_name: "美食样例" };
    const play = {
      ...pick(),
      category: "亲子乐园",
      brand_id: "play",
      brand_name: "游玩样例",
    };
    let got = "";
    const service = await createAiRecommendations(db, {
      credentialPath: "unused",
      getKey: async () => "test",
      readPicks: async () => [food, play],
      readContext: async () => null,
      fetcher: async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        got = body.messages[1].content;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    ...reply,
                    recommendations: [
                      { ...reply.recommendations[0], id: "C01" },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      },
    });
    await db.query("INSERT INTO ai_coupon_reports(payload) VALUES($1)", [
      JSON.stringify({ summary: "旧综合报告" }),
    ]);
    assert.equal((await service.status("leisure")).report, null);
    await service.start("leisure");
    assert.equal(await service.start("food"), "busy");
    await service.drain();
    assert.ok(got.includes("游玩样例"));
    assert.ok(!got.includes("美食样例"));
    assert.equal((await service.status("leisure")).report?.channel, "leisure");
    assert.equal((await service.status("food")).report, null);
    assert.equal((await service.status()).report?.summary, "旧综合报告");
  } finally {
    await db.close();
  }
});
