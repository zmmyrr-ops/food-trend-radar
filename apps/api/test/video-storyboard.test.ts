import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSpeechEvents,
  speechCues,
  synthesizeTimedSpeech,
} from "../src/video-speech.js";
import {
  clipFrameCounts,
  compactNarration,
  fitBlock,
  validateStoryboard,
} from "../src/video-storyboard.js";
import type { Asset, Clip } from "../src/video-types.js";

const clips: Clip[] = [
  { asset_id: "a", start: 1, duration: 2, caption: "" },
  { asset_id: "b", start: 0, duration: 2, caption: "" },
];
const assets: Asset[] = [
  {
    id: "a",
    source_id: "a",
    title: "",
    author: "",
    note_url: "",
    kind: "video",
    duration: 3.2,
    best_end: 3.2,
  },
  {
    id: "b",
    source_id: "b",
    title: "",
    author: "",
    note_url: "",
    kind: "video",
    duration: 5,
  },
];
test("storyboard enforces complete ordered ownership of every clip and rejects fabricated facts", () => {
  assert.equal(
    validateStoryboard(
      {
        blocks: [
          {
            asset_ids: ["a", "b"],
            text: "彩色滑梯连着球池，这个角落挺有意思。",
          },
        ],
      },
      clips,
    ).length,
    1,
  );
  for (const ids of [["b", "a"], ["a", "a"], ["a"], ["a", "b", "c"]])
    assert.throws(
      () =>
        validateStoryboard(
          { blocks: [{ asset_ids: ids, text: "彩色滑梯连着球池。" }] },
          clips,
        ),
      /顺序/,
    );
  for (const text of [
    "三百多平米里自然共存。",
    "只要99元就能随便玩。",
    "适合三到十岁的小朋友。",
  ])
    assert.throws(() =>
      validateStoryboard({ blocks: [{ asset_ids: ["a", "b"], text }] }, clips),
    );
});
test("voice duration is allocated only to matching shots and cannot extend source or loop", () => {
  const result = fitBlock(clips, assets, 6);
  assert.equal(result[0].duration, 2.2);
  assert.equal(result[1].duration, 3.8);
  assert.equal(
    result.reduce((n, c) => n + c.duration, 0),
    6,
  );
  assert.throws(() => fitBlock(clips, assets, 8));
  assert.throws(() => fitBlock(clips, assets, 1));
  assert.equal(clips[0].duration, 2);
});
const event = (output: unknown) => `data: ${JSON.stringify({ output })}\n\n`;
const words = [
  { text: "这", begin_time: 80, end_time: 240, begin_index: 0 },
  { text: "里，", begin_time: 240, end_time: 400, begin_index: 1 },
];
const url =
  "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.wav";
test("stream parser deduplicates cumulative provider word times and requires complete response", () => {
  const body =
    event({ sentence: { index: 0, words } }) +
    event({
      sentence: { index: 0, words },
      finish_reason: "stop",
      audio: { url },
    });
  const p = parseSpeechEvents(body);
  assert.equal(p.words.length, 2);
  assert.equal(p.words[0].start, 0.08);
  assert.throws(
    () => parseSpeechEvents(event({ sentence: { index: 0, words } })),
    /未完成/,
  );
  const cues = speechCues(p.words, 4);
  assert.deepEqual(cues, [{ text: "这里", start: 4.08, end: 4.4 }]);
});
test("new voice requests exact model and timestamps; downloads never receive credentials", async () => {
  const calls: any[] = [];
  const mock = (async (url: any, init: any) => {
    calls.push({ url, init });
    return calls.length === 1
      ? new Response(
          event({
            sentence: { index: 0, words },
            finish_reason: "stop",
            audio: {
              url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.wav",
            },
          }),
        )
      : new Response(Buffer.alloc(128));
  }) as typeof fetch;
  const result = await synthesizeTimedSpeech(
    "private",
    "这里",
    "longanlingxin",
    mock,
  );
  const input = JSON.parse(calls[0].init.body);
  assert.equal(input.model, "qwen-audio-3.0-tts-plus");
  assert.equal(input.input.word_timestamp_enabled, true);
  assert.equal(result.words.length, 2);
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[1].url.protocol, "https:");
  const evil = (async () =>
    new Response(
      event({
        sentence: { index: 0, words },
        finish_reason: "stop",
        audio: { url: "http://localhost/secret" },
      }),
    )) as typeof fetch;
  await assert.rejects(
    synthesizeTimedSpeech("private", "这里", "longanlingxin", evil),
    /地址/,
  );
});
test("subtitle pauses and punctuation follow measured speech rather than character averages", () => {
  const cues = speechCues(
    [
      { text: "先看", start: 0.1, end: 0.5 },
      { text: "滑梯", start: 0.5, end: 1 },
      { text: "，再看", start: 2, end: 2.4 },
      { text: "球池。", start: 2.4, end: 3 },
    ],
    7,
  );
  assert.deepEqual(cues, [
    { text: "先看滑梯", start: 7.1, end: 8 },
    { text: "再看球池", start: 9, end: 10 },
  ]);
});

test("short transitions may stay silent, while main scenes require narration", () => {
  assert.equal(
    validateStoryboard(
      { blocks: [{ asset_ids: ["a"], text: "" }] },
      clips.slice(0, 1),
    )[0].text,
    "",
  );
  assert.throws(
    () =>
      validateStoryboard(
        { blocks: [{ asset_ids: ["a", "b"], text: "" }] },
        clips,
      ),
    /缺少口播/,
  );
});

test("length fallback preserves whole clauses instead of chopping words", () => {
  assert.equal(
    compactNarration("玻璃那边是小动物，旁边还有木桩，光看就挺有意思。", 12),
    "玻璃那边是小动物。",
  );
  assert.equal(compactNarration("不能在这个完整分句中间截断词语。", 5), null);
});

test("fractional speech durations produce integer frames without cumulative drift", () => {
  const durations = [
    1.7, 1.7, 1.7, 1.7, 1.78, 1.78, 1.78, 1.78, 1.96, 1.96, 1.96, 1.96, 1.84,
    1.84,
  ];
  const counts = clipFrameCounts(durations.map((duration) => ({ duration })));
  assert.ok(counts.every((n) => Number.isInteger(n) && n > 0));
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    Math.round(durations.reduce((a, b) => a + b, 0) * 30),
  );
});
