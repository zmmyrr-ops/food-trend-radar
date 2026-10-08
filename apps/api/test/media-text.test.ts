import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMediaCopy, summarizeMediaText } from "../src/media-text.js";

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
                : '```json\n{"snippets":[{"subject":"菜品","copy":"口感酥脆的菜品。","source_id":"0","evidence":"文文"}]}\n```',
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
      (await summarizeMediaText(notes, "品牌", "unused")).highlights[0],
      "口感酥脆的菜品。",
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

test("口播句子必须有原文依据，过滤未知来源和重复句子，不返回证据原文", () => {
  const notes = [{ id: "one", title: "菜品", text: "饼边酥脆，里面柔软。" }];
  const good = {
    subject: "披萨",
    copy: "饼边脆脆的，里面又很软。",
    source_id: "one",
    evidence: "饼边酥脆",
  };
  const out = parseMediaCopy(
    {
      snippets: [
        good,
        good,
        { ...good, source_id: "missing" },
        { ...good, copy: "这个菜完全不同。", evidence: "并不存在" },
      ],
    },
    notes,
  );
  assert.deepEqual(out.snippets, [{ subject: good.subject, copy: good.copy }]);
  assert.equal(out.overview, "");
  assert.throws(() => parseMediaCopy({ snippets: [] }, notes), /NO_COPY/);
  assert.throws(
    () =>
      parseMediaCopy({ snippets: [{ ...good, evidence: "并不存在" }] }, notes),
    /NO_COPY/,
  );
});
