import assert from "node:assert/strict";
import test from "node:test";
import {
  bfReferences,
  selectBfReferences,
} from "../src/video-bf-references.js";
import {
  assDocument,
  musicBed,
  subtitleCues,
  synthesizeSpeech,
  validateScript,
} from "../src/video-production.js";
import { productionOptionsSchema } from "../src/video-types.js";

test("BF references cover both channels and return relevant samples", () => {
  assert.equal(bfReferences.length, 50);
  assert.equal(new Set(bfReferences.map((x) => x.id)).size, 50);
  assert.equal(
    selectBfReferences("leisure", "动物 近景")[0].channel,
    "leisure",
  );
  assert.match(
    selectBfReferences("food", "自助餐 丰盛 全景")[0].tags,
    /自助餐/,
  );
});
test("option combinations remain independent and reject string booleans", () => {
  for (let mask = 0; mask < 8; mask++) {
    const value = {
      subtitles: !!(mask & 1),
      narration: !!(mask & 2),
      music: !!(mask & 4),
    };
    const parsed = productionOptionsSchema.parse(value);
    for (const key of ["music", "narration", "subtitles"] as const)
      assert.equal(parsed[key], value[key]);
  }
  assert.equal(
    productionOptionsSchema.safeParse({ music: "false" }).success,
    false,
  );
});
test("scripts and subtitles use the same words, ordered cue timings and safe ASS", () => {
  const s = validateScript(
    {
      sentences: ["周末想换个去处，先看看这里。", "从场地到设施，慢慢看一圈。"],
    },
    12,
  );
  const cues = subtitleCues(s, [5, 6]);
  assert.equal(cues.map((x) => x.text).join(""), s.join(""));
  assert.equal(cues[0].start, 0.25);
  assert.ok(Math.abs(cues.at(-1)!.end - 11.25) < 0.001);
  assert.ok(
    cues.every((c, i) => c.end > c.start && (!i || c.start >= cues[i - 1].end)),
  );
  assert.match(assDocument(cues, 720, 1280), /Dialogue/);
  assert.throws(() =>
    validateScript(
      { sentences: ["[品牌]的[设施]非常不错。", "可以闭眼冲的超棒宝藏。"] },
      12,
    ),
  );
  assert.throws(() =>
    validateScript(
      {
        sentences: Array(5).fill("这段太长的文案完全不应该被读到视频外面去。"),
      },
      12,
    ),
  );
});
test("music is finite PCM with correct duration and different channel arrangements", () => {
  const food = musicBed(12, false),
    leisure = musicBed(12, true);
  assert.equal(food.toString("ascii", 0, 4), "RIFF");
  assert.equal(food.length, 44 + 12 * 24000 * 2);
  assert.notDeepEqual(food, leisure);
  let peak = 0;
  for (let i = 44; i < food.length; i += 2)
    peak = Math.max(peak, Math.abs(food.readInt16LE(i)));
  assert.ok(peak > 1000 && peak < 32767);
});
test("TTS limits download host and never forwards key to audio storage", async () => {
  const calls: any[] = [];
  const mock = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? Response.json({
          output: {
            audio: {
              url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?sign=test",
            },
          },
        })
      : new Response(Buffer.alloc(100));
  }) as typeof fetch;
  await synthesizeSpeech("private-test-key", "你好", mock);
  assert.match(calls[1].url, /^https:/);
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(JSON.parse(calls[0].init.body).input.voice, "Cherry");
  await assert.rejects(
    synthesizeSpeech("k", "你好", (async () =>
      Response.json({
        output: { audio: { url: "http://127.0.0.1/private" } },
      })) as typeof fetch),
    /地址/,
  );
});

test("subtitle controls scale identically for preview and export and reject injections", () => {
  const options = {
    subtitleFont: "serif" as const,
    subtitleSize: 72,
    subtitlePosition: 70,
    subtitleOutline: 6,
    subtitleColor: "#FFCC00",
    subtitleOutlineColor: "#112233",
  };
  const preview = assDocument([], 720, 1280, options);
  assert.match(
    preview,
    /Noto Serif SC,48,&H0000CCFF,&H00332211,1,4,0,2,45,45,384/,
  );
  assert.match(
    assDocument([], 1080, 1920, options),
    /Noto Serif SC,72,.*1,6,0,2,45,45,576/,
  );
  assert.throws(() =>
    assDocument([], 720, 1280, { subtitleColor: "white,evil" }),
  );
  assert.equal(
    productionOptionsSchema.safeParse({ voice: "arbitrary" }).success,
    false,
  );
  assert.equal(
    productionOptionsSchema.safeParse({ subtitleSize: 200 }).success,
    false,
  );
});
test("selected voice is sent to provider", async () => {
  let sent = "";
  const mock = (async (_url: unknown, init: any) => {
    if (init?.method === "POST") {
      sent = JSON.parse(init.body).input.voice;
      return Response.json({
        output: {
          audio: {
            url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.wav",
          },
        },
      });
    }
    return new Response(Buffer.alloc(100));
  }) as typeof fetch;
  await synthesizeSpeech("test", "你好", mock, "Ethan");
  assert.equal(sent, "Ethan");
});

test("natural paragraph output need not fail because model returned a single sentence entry", () => {
  const paragraph =
    "先看彩色球池和滑梯，再看看沙池里的小挖掘机。几种不同的场景连在一起，想换个室内去处可以先看看这里。";
  assert.deepEqual(validateScript({ sentences: [paragraph] }, 12), [paragraph]);
});
