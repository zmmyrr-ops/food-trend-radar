import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createAutoRadar,
  fetchPublicPage,
  parseAnnouncements,
  scoreAnnouncement,
} from "../src/auto-radar.js";
import { openDatabase } from "../src/db.js";

const page = (title: string, date = "2026.09.20") =>
  `<a href="https://www.mcdonalds.com.cn/news/test-event"><div><h4>${title}</h4><time>${date}</time></div></a>`;
test("announcement parser and scoring reject unsupported evidence, future dates and risk", async () => {
  const s = parseAnnouncements(page("全新联名 &amp; 新品"))[0];
  assert.equal(s.title, "全新联名 & 新品");
  assert.equal(s.kind, "联名");
  const asOf = Date.parse("2026-09-20T08:00:00+08:00");
  assert.equal(scoreAnnouncement(s, asOf)?.p72, null);
  assert.equal(scoreAnnouncement(s, asOf)?.early_signal_score, null);
  assert.equal(
    scoreAnnouncement(
      { ...s, published_at: "2026-09-21T00:00:00+08:00" },
      asOf,
    ),
    null,
  );
  assert.equal(
    scoreAnnouncement(
      { ...s, published_at: "2026-08-01T00:00:00+08:00" },
      asOf,
    ),
    null,
  );
  assert.equal(
    scoreAnnouncement(parseAnnouncements(page("新品召回"))[0], asOf),
    null,
  );
  assert.equal(
    scoreAnnouncement(parseAnnouncements(page("季度财报"))[0], asOf),
    null,
  );
  assert.throws(() => parseAnnouncements(page("新品", "2026.02.30")));
  assert.throws(() => parseAnnouncements("<html>请登录</html>"));
  assert.throws(() =>
    parseAnnouncements(
      page("新品").replace("www.mcdonalds.com.cn", "evil.example"),
    ),
  );
  await assert.rejects(fetchPublicPage("http://127.0.0.1/internal"));
  assert.equal(parseAnnouncements(page("新品") + page("新品")).length, 1);
});

test("automatic collection persists signals and revisions, excludes stale results and never writes manual events", async () => {
  const db = await openDatabase();
  let fail = false;
  let title = "测试新品上新";
  const date = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", ".");
  let calls = 0;
  const radar = createAutoRadar(db, async (url) => {
    calls++;
    if (fail) throw Error("模拟来源中断");
    return url.endsWith("robots.txt")
      ? "User-agent: *\nDisallow: /api/"
      : url.endsWith("test-event/")
        ? '<div class="cmsMainBox"><p>新品9.9元，仅限会员</p></div><div class="bottom-share foo">'
        : page(title, date);
  });
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'麦当劳','麦当劳','西式快餐','https://example.com/store')",
    [randomUUID()],
  );
  async function run() {
    await db.query(
      "UPDATE auto_runs SET started_at=started_at-interval '6 hours'",
    );
    const started = await radar.start();
    assert.equal(started.accepted, true);
    for (let i = 0; i < 100; i++) {
      if ((await radar.board()).runs[0]?.status !== "running") return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("任务超时");
  }
  try {
    await run();
    let board = await radar.board();
    assert.equal(board.items.length, 1);
    assert.equal(board.p72, null);
    assert.equal(board.counts.monitored_brands, 1);
    const savedSignal = (
      await db.query<{ payload: { facts: { status: string } } }>(
        "SELECT payload FROM auto_signals",
      )
    ).rows[0];
    assert.equal(savedSignal.payload.facts.status, "extracted");
    const original = (await db.query("SELECT payload FROM auto_scores"))
      .rows[0];
    const blocked = await radar.start();
    assert.equal(blocked.accepted, false);
    assert.equal(calls, 3);
    await run();
    assert.equal((await db.query("SELECT * FROM auto_signals")).rows.length, 1);
    assert.equal(
      (await db.query("SELECT * FROM auto_signal_revisions")).rows.length,
      1,
    );
    title = "测试新品上新更正";
    await run();
    assert.equal(
      (await db.query("SELECT * FROM auto_signal_revisions")).rows.length,
      2,
    );
    assert.deepEqual(
      (await db.query("SELECT payload FROM auto_scores ORDER BY as_of LIMIT 1"))
        .rows[0],
      original,
    );
    fail = true;
    await run();
    board = await radar.board();
    assert.equal(board.runs[0].status, "failed");
    assert.equal((await db.query("SELECT * FROM auto_scores")).rows.length, 3);
    await db.query(
      "UPDATE auto_runs SET finished_at=now()-interval '13 hours' WHERE status='succeeded'",
    );
    board = await radar.board();
    assert.equal(board.items.length, 0);
    assert.equal(board.quality_status, "stale");
    assert.equal((await db.query("SELECT * FROM events")).rows.length, 0);
    await db.query("INSERT INTO auto_runs(id,status) VALUES($1,'running')", [
      randomUUID(),
    ]);
    await radar.recover();
    assert.equal(
      (await db.query("SELECT * FROM auto_runs WHERE status='running'")).rows
        .length,
      0,
    );
  } finally {
    await db.close();
  }
});
