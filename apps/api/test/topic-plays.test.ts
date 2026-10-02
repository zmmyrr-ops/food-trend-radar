import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverTopics, parseTopicPlays } from "../src/topic-plays.js";

test("extracts topic header count without confusing individual video metrics", () => {
  const html =
    '<div data-e2e="topic-title"><h1>#<!-- -->上海迪士尼10岁生日</h1><span>1.8亿<!-- -->次播放</span></div><span>99亿次播放</span>';
  assert.equal(parseTopicPlays(html, "上海迪士尼10岁生日"), "1.8亿");
  assert.equal(parseTopicPlays(html, "上海迪士尼"), null);
  assert.equal(parseTopicPlays("<p>99亿次播放</p>", "上海迪士尼"), null);
});
test("extracts exact topic names and IDs from escaped page data", () => {
  assert.deepEqual(
    discoverTopics(
      '{\\"hashtagId\\":\\"7610987711888885803\\",\\"hashtagName\\":\\"上海迪士尼10岁生日\\"}',
    ),
    { 上海迪士尼10岁生日: "7610987711888885803" },
  );
});
