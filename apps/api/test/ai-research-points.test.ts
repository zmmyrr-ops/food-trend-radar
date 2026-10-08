import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAccounts } from "../src/accounts.js";
import { createAiRecommendations } from "../src/ai-recommendations.js";
import { combinePicks } from "../src/coupon-picks.js";
import { openDatabase } from "../src/db.js";
import { changePoints } from "../src/points.js";
import { salesTrend } from "../src/sales-heat.js";

test("researched AI charges 30 once, isolates reports and refunds failed research", async () => {
  const db = await openDatabase();
  await createAccounts(db, {});
  const owner = randomUUID(),
    other = randomUUID(),
    brand = randomUUID();
  await db.query(
    "INSERT INTO accounts(id,phone) VALUES($1,'13800008111'),($2,'13800008222')",
    [owner, other],
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS brand_blacklist(owner_id uuid,brand_id uuid)",
  );
  await db.transaction((tx) => changePoints(tx, owner, 100, "seed", "ai-seed"));
  const now = Date.now();
  const samples = [0, 12].map((h, i) => ({
    run_id: String(i),
    observed_at: new Date(now - h * 3600000).toISOString(),
    payload: {
      monthly_sales: String(400 - i * 300),
      platform_brand_id: "p",
      identity: "name_match",
      origin_price_fen: 200,
      price_min_fen: 100,
      price_max_fen: 100,
      name: "测试券",
    },
  }));
  const pick = combinePicks(
    [
      {
        brand_id: brand,
        brand_name: "品牌",
        product_id: "1",
        title: "测试券",
        price_fen: 100,
        ...salesTrend(samples, now),
      },
    ],
    [],
    now,
  )[0];
  let calls = 0;
  const options = {
    readPicks: async () => [pick],
    readContext: async () => ({ weather: "unknown" }),
    credentialPath: "unused",
    getKey: async () => "test",
    research: async () => ({
      brand: "品牌",
      summary: "来源支持的定位",
      sources: [{ title: "官方", url: "https://example.com" }],
      researched_at: new Date().toISOString(),
    }),
    fetcher: (async () => {
      calls++;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: "判断",
                recommendations: [
                  {
                    id: "C01",
                    reason: "价值",
                    angle: "角度",
                    risks: ["待确认"],
                  },
                ],
                limitations: ["非概率"],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  };
  const balance = async () =>
    (
      await db.query<{ balance: number }>(
        "SELECT balance FROM point_wallets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].balance;
  try {
    const service = await createAiRecommendations(db, options);
    assert.equal(await service.start("food", owner), "started");
    assert.equal(await service.start("food", owner), "running");
    assert.equal(await service.start("food", other), "busy");
    await service.drain();
    assert.equal(await balance(), 70);
    assert.equal(calls, 1);
    assert.ok((await service.status("food", owner)).report);
    assert.equal((await service.status("food", other)).report, null);
    const failing = await createAiRecommendations(db, {
      ...options,
      research: async () => {
        throw Error("search failed");
      },
    });
    await failing.start("food", owner);
    await failing.drain();
    assert.equal(await balance(), 70);
    assert.equal(calls, 1);
    assert.match((await failing.status("food", owner)).error || "", /联网调研/);
  } finally {
    await db.close();
  }
});
