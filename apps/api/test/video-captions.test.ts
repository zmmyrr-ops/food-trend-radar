import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCaptions } from "../src/video-captions.js";

const plan = Array.from({ length: 4 }, (_, i) => ({
  asset_id: String(i),
  duration: 3,
  start: 0,
  caption: "",
}));
test("字幕按镜头序号落位，保持画面顺序和裁切不变", () => {
  const output = applyCaptions(plan, {
    captions: [4, 2, 1, 3].map((index) => ({ index, text: `第${index}句` })),
  });
  assert.deepEqual(
    output.map((c) => c.caption),
    ["第1句", "第2句", "第3句", "第4句"],
  );
  assert.deepEqual(
    output.map(({ caption, ...c }) => c),
    plan.map(({ caption, ...c }) => c),
  );
});
test("拒绝漏镜、重复序号、空字幕和超出阅读时长的字幕", () => {
  for (const captions of [
    [],
    [1, 1, 3, 4].map((index) => ({ index, text: "字幕" })),
    [1, 2, 3, 4].map((index) => ({ index, text: "" })),
    [1, 2, 3, 4].map((index) => ({ index, text: "长".repeat(30) })),
  ])
    assert.throws(() => applyCaptions(plan, { captions }));
});
test("拒绝机械剪辑描述和未提供的预约要求", () => {
  for (const text of ["扇形牛肉开场", "请提前预约", "双人份量刚好"]) {
    assert.throws(
      () =>
        applyCaptions(plan, {
          captions: [1, 2, 3, 4].map((index) => ({ index, text })),
        }),
      /未经核实/,
    );
  }
});
