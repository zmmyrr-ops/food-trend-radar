import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFacts } from "../src/signal-facts.js";

const html = (s: string) =>
  `<nav>1元优惠 9月21日</nav><div class="cmsMainBox">${s}</div><div class="bottom-share foo">`;
test("facts retain lottery restrictions without inventing discount or eligibility", () => {
  const f = extractFacts(
    html(
      "<p>大薯￥9.9</p><p>0元抽奖，仅限会员，随机中奖</p><p>9月22日13:30直播</p>",
    ),
    "2026-09-20T00:00:00+08:00",
  );
  assert.equal(f.promotion_mentions.length, 2);
  assert.equal(f.restrictions.length, 1);
  assert.equal(f.dated_mentions[0].date, "2026-09-22");
  assert.equal(f.dated_mentions[0].year_inferred, true);
  assert.equal(f.shanghai_eligibility, "unknown");
  assert.equal(f.dated_mentions.length, 1);
  assert.throws(() => extractFacts("<h1>新品9.9元</h1>", "2026-09-20"));
});
test("rejects invalid dates and ambiguous cross-year inference, detects cancellation in body", () => {
  const f = extractFacts(
    html("<p>2月30日</p><p>1月2日</p><p>2027年1月3日活动取消</p>"),
    "2026-12-28T00:00:00+08:00",
  );
  assert.equal(f.dated_mentions.length, 1);
  assert.equal(f.dated_mentions[0].date, "2027-01-03");
  assert.equal(f.risk, true);
});
