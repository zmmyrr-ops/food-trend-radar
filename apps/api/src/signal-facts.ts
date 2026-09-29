import { createHash } from "node:crypto";

export type SignalFacts = {
  version: "facts-v1";
  status: "extracted" | "unavailable";
  error: string | null;
  content_hash: string | null;
  promotion_mentions: string[];
  restrictions: string[];
  dated_mentions: { date: string; evidence: string; year_inferred: boolean }[];
  risk: boolean;
  shanghai_eligibility: "unknown";
};
export function unavailableFacts(error: string): SignalFacts {
  return {
    version: "facts-v1",
    status: "unavailable",
    error,
    content_hash: null,
    promotion_mentions: [],
    restrictions: [],
    dated_mentions: [],
    risk: false,
    shanghai_eligibility: "unknown",
  };
}
export function extractFacts(html: string, publishedAt: string): SignalFacts {
  const body = html.match(
    /<div\s+class="cmsMainBox">([\s\S]*?)<div\s+class="bottom-share\b/i,
  )?.[1];
  if (!body) throw Error("未识别官方正文，不能从导航或标题推断活动条件");
  const text = body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|section|div)>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ");
  const lines = [
    ...new Set(
      text
        .split(/\n/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (!lines.length) throw Error("正文无可提取文本，图片信息未解析");
  const dated: SignalFacts["dated_mentions"] = [];
  const publication = new Date(publishedAt);
  if (!Number.isFinite(publication.getTime())) throw Error("无有效发布日期");
  const year = new Date(publication.getTime() + 8 * 3600000).getUTCFullYear();
  for (const line of lines) {
    for (const m of line.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g)) {
      const y = Number(m[1] ?? year);
      const day = `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      const time = Date.parse(`${day}T00:00:00Z`);
      if (
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== day
      )
        continue;
      // Unspecified years near a year boundary require stronger evidence.
      if (!m[1] && Math.abs(time - publication.getTime()) > 180 * 86400000)
        continue;
      dated.push({
        date: day,
        evidence: line.slice(
          Math.max(0, m.index! - 30),
          m.index! + m[0].length + 90,
        ),
        year_inferred: !m[1],
      });
    }
  }
  return {
    version: "facts-v1",
    status: "extracted",
    error: null,
    content_hash: createHash("sha256").update(text).digest("hex"),
    promotion_mentions: lines
      .filter((x) =>
        /\d+(?:\.\d+)?\s*元|[￥¥]\s*\d|买[一1]送[一1]|\d+(?:\.\d+)?折/.test(x),
      )
      .slice(0, 12)
      .map((x) => x.slice(0, 400)),
    restrictions: lines
      .filter((x) =>
        /仅限|专享|门槛|限额|限量|抽奖|随机|部分餐厅|不适用|不参与|以.*为准/.test(
          x,
        ),
      )
      .slice(0, 12)
      .map((x) => x.slice(0, 400)),
    dated_mentions: dated.slice(0, 20),
    risk: /召回|食品安全|中毒|致歉|道歉|停售|活动取消|取消活动|活动已取消|活动暂停/.test(
      text,
    ),
    shanghai_eligibility: "unknown",
  };
}
