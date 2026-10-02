import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverTopics,
  formatTopicCount,
  parseTopicPlays,
  parseTopicSuggestion,
} from "../src/topic-plays.js";

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

test("creator suggestions match exact names, not a higher-view similar topic", () => {
  const data = {
    status_code: 0,
    sug_list: [
      { cha_name: "上海迪士尼旅游攻略", cid: "12", view_count: 999999 },
      { cha_name: "上海迪士尼", cid: "13", view_count: 32006432214 },
    ],
  };
  assert.equal(parseTopicSuggestion(data, "上海迪士尼")?.cid, "13");
  assert.equal(parseTopicSuggestion(data, "迪士尼"), null);
  assert.equal(
    parseTopicSuggestion({ status_code: 0, sug_list: [] }, "上海探店"),
    null,
  );
});
test("upstream failures and missing counts are not zero plays", () => {
  assert.throws(() => parseTopicSuggestion({ status_code: 8 }, "探店"));
  assert.throws(() =>
    parseTopicSuggestion(
      { status_code: 0, sug_list: [{ cha_name: "探店", cid: "1" }] },
      "探店",
    ),
  );
  assert.equal(
    parseTopicSuggestion(
      {
        status_code: 0,
        sug_list: [{ cha_name: "探店", cid: "1", view_count: 0 }],
      },
      "探店",
    )?.view_count,
    0,
  );
});
test("formats topic aggregate plays", () => {
  assert.equal(formatTopicCount(32006432214), "320.06亿");
  assert.equal(formatTopicCount(5440999939), "54.41亿");
  assert.equal(formatTopicCount(210579960), "2.11亿");
  assert.equal(formatTopicCount(12345), "1.23万");
  assert.equal(formatTopicCount(0), "0");
});
