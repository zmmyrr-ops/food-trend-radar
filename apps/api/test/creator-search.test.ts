import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  createCreatorSearch,
  creatorSearchPlan,
} from "../src/creator-search.js";
import { creatorDeduction } from "../src/external-features.js";
import type { createOpportunityBoard } from "../src/opportunity-board.js";

const target = {
  brand_id: "b",
  brand_name: "绝味鸭脖",
  product_id: "123",
  revision: "v1",
  title: "120元代金券",
  current_price_fen: 11000,
  current_price_max_fen: 11000,
  observed_at: "2026-09-28T00:00:00Z",
  disposition: "new",
  kind: "price_drop",
};
test("search plan preserves voucher face value and payable price, unknown is not zero, revision updates plan", () => {
  const p = creatorSearchPlan(target);
  assert.ok(p.queries[1].keyword.includes("120元代金券 110元"));
  assert.equal(p.author_count, null);
  assert.equal(p.video_count, null);
  assert.equal(p.status, "blocked_source");
  assert.deepEqual(p.deduction, { low: 0, high: 30 });
  assert.notEqual(
    p.plan_id,
    creatorSearchPlan({ ...target, revision: "v2" }).plan_id,
  );
  assert.equal(
    creatorSearchPlan({ ...target, current_price_max_fen: 12000 }).queries
      .length,
    1,
  );
  const weird = creatorSearchPlan({ ...target, title: "套餐 #A&B?/" });
  assert.ok(
    weird.queries.every((q) => new URL(q.url).hostname === "www.douyin.com"),
  );
});
test("creator source endpoint uses only current candidates, skips dismissed and historical returns, validates brands", async () => {
  const get = (async () => [
    target,
    { ...target, product_id: "2", disposition: "dismissed" },
    { ...target, product_id: "3", kind: "reappeared" },
  ]) as unknown as Awaited<
    ReturnType<typeof createOpportunityBoard>
  >["candidates"];
  const service = createCreatorSearch(get);
  assert.equal((await service.read()).total, 1);
  assert.equal((await service.read("other")).total, 0);
  const app = express();
  service.register(app);
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "invalid" });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error();
    const base = `http://127.0.0.1:${address.port}/api/v3/creator-search`;
    const r = await (await fetch(base)).json();
    assert.equal(r.automatic_collection, false);
    assert.equal(r.items[0].author_count, null);
    assert.equal((await fetch(base + "?brand_id=bad")).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const asOf = new Date("2026-09-28T12:00:00Z");
const video = {
  videoId: "1",
  authorId: "a",
  couponVersion: "v1",
  publishedAt: "2026-09-28T10:00:00Z",
  observedAt: "2026-09-28T11:00:00Z",
};
test("creator dedup rejects conflicting author/time evidence independent of row order", () => {
  for (const conflict of [
    { ...video, authorId: "b" },
    { ...video, publishedAt: "2026-09-28T09:00:00Z" },
  ])
    for (const rows of [
      [video, conflict],
      [conflict, video],
    ]) {
      const r = creatorDeduction(rows, "v1", asOf, true);
      assert.equal(r.authors, 0);
      assert.equal(r.coverage, "partial");
    }
});
test("unresolved coupon and impossible observation cannot establish complete low saturation", () => {
  for (const v of [
    { ...video, couponVersion: null },
    { ...video, observedAt: "2026-09-27" },
    { ...video, publishedAt: "invalid" },
  ]) {
    const r = creatorDeduction([v], "v1", asOf, true);
    assert.equal(r.coverage, "partial");
    assert.equal(r.deduction.high, 30);
  }
});
test("24h counts and publication growth exclude window boundary overlap and require coverage", () => {
  const rows = [
    video,
    { ...video, videoId: "2" },
    { ...video, videoId: "3", publishedAt: "2026-09-27T12:00:00Z" },
    { ...video, videoId: "4", publishedAt: "2026-09-26T12:00:00Z" },
  ];
  const r = creatorDeduction(rows, "v1", asOf, true);
  assert.equal(r.last24h.videos, 3);
  assert.equal(r.previous24h.videos, 1);
  assert.equal(r.publishGrowth, 2);
  assert.equal(r.authors, 1);
  assert.equal(creatorDeduction(rows, "v1", asOf, false).publishGrowth, null);
  assert.equal(creatorDeduction([video], "v1", asOf, true).publishGrowth, null);
});
