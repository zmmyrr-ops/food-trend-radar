import assert from "node:assert/strict";
import test from "node:test";
import {
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
        assert.equal(String(options?.body).includes("private-test-key"), false);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(reply) },
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
