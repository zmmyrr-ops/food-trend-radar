import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStudioCopy, studioCouponFacts } from "../src/studio-copy.js";

test("returns exactly three distinct titles", () => {
  assert.deepEqual(
    parseStudioCopy(
      JSON.stringify({ titles: ["标题一", "标题二", "标题三", "标题四"] }),
      "titles",
    ),
    ["标题一", "标题二", "标题三"],
  );
  assert.throws(() =>
    parseStudioCopy(
      JSON.stringify({ titles: ["重复", "重复", "重复"] }),
      "titles",
    ),
  );
});
test("locked topics survive refresh and total remains ten", () => {
  const locked = ["上海探店", "亲子游玩"];
  const fresh = Array.from({ length: 10 }, (_, i) => `#话题${i}`);
  const topics = parseStudioCopy(
    JSON.stringify({ topics: [...locked, ...fresh] }),
    "topics",
    locked,
  );
  assert.equal(topics.length, 10);
  assert.deepEqual(topics.slice(0, 2), locked);
  assert.equal(new Set(topics).size, 10);
  assert.equal(
    topics
      .map((v) => `#${v}`)
      .join(" ")
      .startsWith("#上海探店 #亲子游玩 "),
    true,
  );
});
test("rejects incomplete or invalid model responses", () => {
  assert.throws(() => parseStudioCopy("{}", "topics"));
  assert.throws(() => parseStudioCopy('{"topics":["#"]}', "topics"));
  assert.throws(() => parseStudioCopy("not json", "titles"));
});

test("prices are converted from fen and starting prices never become fixed prices", () => {
  assert.equal(
    studioCouponFacts({
      payload: { price_min_fen: 40000, price_max_fen: 40000 },
    }).price_label,
    "400元",
  );
  assert.equal(
    studioCouponFacts({
      payload: { price_min_fen: 39990, price_max_fen: 79900 },
    }).price_label,
    "399.9元起",
  );
  assert.equal(
    studioCouponFacts({ payload: { price_min_fen: 40000 } }).price_label,
    "400元起",
  );
  assert.equal(
    studioCouponFacts({ payload: { price_min_fen: null } }).price_label,
    null,
  );
});
