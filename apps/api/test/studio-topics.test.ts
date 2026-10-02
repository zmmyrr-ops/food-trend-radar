import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recommendStudioTopics,
  selectHotTopics,
} from "../src/studio-topics.js";
import type { TopicPlay } from "../src/topic-plays.js";

const item = (topic: string, count: number): TopicPlay => ({
  topic,
  display: String(count),
  view_count: count,
  url: "https://www.douyin.com/hashtag/1",
  checked_at: "2026-10-02",
  status: "ok",
});
test("only real relevant candidates are ranked by plays; locked topics remain", () => {
  const result = selectHotTopics(
    [
      item("无关热点", 999999),
      item("上海探店", 100),
      item("自助餐", 300),
      item("上海探店", 100),
    ],
    [1, 2, 3, 99],
    ["已锁定"],
    [],
  );
  assert.deepEqual(result.items, ["已锁定", "自助餐", "上海探店"]);
  assert.equal(result.metrics.自助餐.view_count, 300);
});
test("refresh prefers unseen candidates and never fabricates to fill ten", () => {
  const pool = Array.from({ length: 15 }, (_, i) => item(`话题${i}`, 100 - i));
  const result = selectHotTopics(
    pool,
    pool.map((_, i) => i),
    ["话题0"],
    pool.slice(0, 10).map((x) => x.topic),
  );
  assert.equal(result.items[0], "话题0");
  assert.equal(result.items.length, 10);
  assert.ok(result.items.includes("话题14"));
  assert.equal(selectHotTopics([], [], [], []).items.length, 0);
});
test("model supplies keywords and relevance only; published names/counts come from search", async () => {
  const original = globalThis.fetch;
  const replies = [{ keywords: ["上海探店", "自助餐"] }, { indices: [1, 2] }];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(replies.shift()) } }],
      }),
    );
  const searched: string[] = [];
  try {
    const result = await recommendStudioTopics(
      "test",
      {},
      [],
      [],
      async (keyword) => {
        searched.push(keyword);
        return keyword === "上海探店"
          ? [item("其他城市", 9000), item("上海探店", 100)]
          : [item("自助餐", 300)];
      },
    );
    assert.deepEqual(searched, ["上海探店", "自助餐"]);
    assert.deepEqual(result.items, ["自助餐", "上海探店"]);
    assert.ok(result.notice);
  } finally {
    globalThis.fetch = original;
  }
});
