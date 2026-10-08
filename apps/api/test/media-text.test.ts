import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeMediaText } from "../src/media-text.js";

test("文字整理关闭推理，校验截断与JSON，并限制文章长度", async () => {
  const original = globalThis.fetch,
    key = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test";
  let mode = "success";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.thinking.type, "disabled");
    assert.equal(body.max_tokens, 2400);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.articles.length, 25);
    assert.equal(input.articles[0].text.length, 1800);
    return Response.json({
      choices: [
        {
          finish_reason: mode === "length" ? "length" : "stop",
          message: {
            content:
              mode === "invalid"
                ? "not-json"
                : '```json\n{"overview":"内容概述","highlights":["特色体验"]}\n```',
          },
        },
      ],
    });
  };
  try {
    const notes = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: "品牌",
      text: "文".repeat(4000),
    }));
    assert.equal(
      (await summarizeMediaText(notes, "品牌", "unused")).overview,
      "内容概述",
    );
    mode = "length";
    await assert.rejects(
      summarizeMediaText(notes, "品牌", "unused"),
      /SUMMARY_TRUNCATED/,
    );
    mode = "invalid";
    await assert.rejects(
      summarizeMediaText(notes, "品牌", "unused"),
      /SUMMARY_INVALID/,
    );
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = key;
  }
});
