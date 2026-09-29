import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import {
  extractFacts,
  type SignalFacts,
  unavailableFacts,
} from "./signal-facts.js";

export const source = {
  id: "mcd-sales-v1",
  name: "麦当劳官网 · 新品优惠",
  url: "https://www.mcdonalds.com.cn/news/sales",
  brand: "麦当劳",
  geography: "national",
  coverage: "官网当前列表页，非全量历史",
  interval_hours: 6,
};
export type Signal = {
  title: string;
  url: string;
  published_at: string;
  date_precision: "day";
  kind: string | null;
  risk: boolean;
  facts?: SignalFacts;
};
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
function plain(v: string) {
  return v
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
      const code =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
export function parseAnnouncements(html: string): Signal[] {
  const items: Signal[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const title = match[2].match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1];
    const date = match[2].match(
      /<time\b[^>]*>\s*(\d{4})\.(\d{2})\.(\d{2})\s*<\/time>/i,
    );
    if (!title || !date) continue;
    const url = new URL(match[1], source.url);
    if (
      url.origin !== new URL(source.url).origin ||
      !url.pathname.startsWith("/news/")
    )
      continue;
    const day = `${date[1]}-${date[2]}-${date[3]}`;
    const published_at = `${day}T00:00:00+08:00`;
    if (
      !Number.isFinite(Date.parse(published_at)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
    )
      continue;
    const text = plain(title).slice(0, 300);
    const risk = /召回|食品安全|中毒|致歉|道歉|停售|取消|缺货|售罄/.test(text);
    const kind = /联名|联动|携手/.test(text)
      ? "联名"
      : /上新|新品|全新|新甜品|新月堡|新绘本/.test(text)
        ? "新品"
        : /优惠|元|￥|¥|免费|买一送一|折/.test(text)
          ? "优惠"
          : /中秋|节日|限定/.test(text)
            ? "节日限定"
            : null;
    items.push({
      title: text,
      url: url.href,
      published_at,
      date_precision: "day",
      kind,
      risk,
    });
  }
  if (!items.length)
    throw Error("目录结构变化或未取得带日期公告，停止更新并保留旧数据");
  return [...new Map(items.map((x) => [x.url, x])).values()];
}
// This is an announcement-priority score, not demand, popularity or probability.
export function scoreAnnouncement(s: Signal, asOf: number) {
  const age = (asOf - Date.parse(s.published_at)) / 86400000;
  if (age < 0 || age > 14 || s.risk || s.facts?.risk || !s.kind) return null;
  const freshness = Math.round(70 * (1 - age / 14) * 10) / 10;
  return {
    observation_score: Math.round((freshness + 30) * 10) / 10,
    early_signal_score: null,
    p72: null,
    headstart_index: null,
    version: "OBS-announcement-v1",
    contributions: [
      { name: "公告日期新鲜度（14天线性衰减）", points: freshness },
      { name: "标题命中活动规则", points: 30 },
    ],
    signal: s,
    shanghai_eligibility: "unknown",
    quality_status: "partial",
    limitations: [
      "仅一份官方公告列表，不含需求、作者或内容量",
      "上海活动适用及起止时间待核验",
      "未确定开售时间，早期信号分不计算",
    ],
  };
}
export async function fetchPublicPage(url: string) {
  const u = new URL(url);
  if (
    u.origin !== new URL(source.url).origin ||
    !(
      u.pathname === "/robots.txt" ||
      /^\/news\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)
    ) ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw Error("不在采集来源准入清单");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "FoodTrendRadar/0.1 (public announcements; local research)",
    },
  });
  if (!response.ok) throw Error(`来源响应HTTP ${response.status}`);
  if (!/text\/(html|plain)/i.test(response.headers.get("content-type") ?? ""))
    throw Error("来源不是文本页面");
  const reader = response.body?.getReader();
  if (!reader) throw Error("来源响应为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2000000) {
      await reader.cancel();
      throw Error("来源响应超过2MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function checkRobots(body: string, path = "/news/sales") {
  // Conservatively apply all disallow rules, including rules for other agents.
  if (!/^User-agent:/im.test(body)) throw Error("无法识别robots规则，暂停采集");
  for (const line of body.split(/\r?\n/)) {
    const rule = line.match(/^\s*Disallow:\s*([^#]*)/i)?.[1].trim();
    if (!rule) continue;
    const pattern = rule
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    if (new RegExp(`^${pattern}`).test(path))
      throw Error("来源robots禁止此路径，暂停采集");
  }
}
export function createAutoRadar(db: PGlite, load = fetchPublicPage) {
  let running = false;
  let stopped = false;
  let pending: Promise<void> | null = null;
  async function start() {
    if (stopped) return { accepted: false, reason: "服务正在停止" };
    if (running) return { accepted: false, reason: "已有更新任务运行中" };
    running = true;
    try {
      const latest = (
        await db.query<{ started_at: Date }>(
          "SELECT started_at FROM auto_runs ORDER BY started_at DESC LIMIT 1",
        )
      ).rows[0];
      if (
        latest &&
        Date.now() - new Date(latest.started_at).getTime() < 300000
      ) {
        running = false;
        return { accepted: false, reason: "为保护来源，更新间隔至少5分钟" };
      }
      const id = randomUUID();
      await db.query("INSERT INTO auto_runs(id,status) VALUES($1,'running')", [
        id,
      ]);
      pending = execute(id)
        .catch(() => {
          console.error("自动采集任务无法写入终态，重启后恢复", id);
        })
        .finally(() => {
          running = false;
        });
      return { accepted: true, id };
    } catch (e) {
      running = false;
      throw e;
    }
  }
  async function execute(id: string) {
    try {
      const brand = (
        await db.query<{ id: string }>(
          "SELECT id FROM brands WHERE name=$1 AND active=true",
          [source.brand],
        )
      ).rows[0];
      if (!brand) throw Error("正式品牌库缺少启用的麦当劳，未创建测试品牌");
      const robots = await load(new URL("/robots.txt", source.url).href);
      checkRobots(robots);
      const html = await load(source.url);
      const signals = parseAnnouncements(html);
      const now = new Date();
      let detailFailures = 0;
      const recent = signals
        .filter((s) => scoreAnnouncement(s, now.getTime()) !== null)
        .sort(
          (a, b) =>
            b.published_at.localeCompare(a.published_at) ||
            a.url.localeCompare(b.url),
        );
      for (const [index, signal] of recent.entries()) {
        if (index >= 12) {
          signal.facts = unavailableFacts("本轮详情上限12条，等待后续覆盖");
          continue;
        }
        try {
          const detailUrl = new URL(signal.url);
          detailUrl.pathname = detailUrl.pathname.replace(/\/?$/, "/");
          checkRobots(robots, detailUrl.pathname);
          signal.facts = extractFacts(
            await load(detailUrl.href),
            signal.published_at,
          );
        } catch (e) {
          detailFailures++;
          signal.facts = unavailableFacts(
            e instanceof Error ? e.message : "详情读取失败",
          );
        }
      }
      let created = 0,
        changed = 0;
      await db.transaction(async (tx) => {
        for (const signal of signals) {
          const key = digest(source.id + signal.url),
            hash = digest(JSON.stringify(signal));
          const old = (
            await tx.query<{ content_hash: string }>(
              "SELECT content_hash FROM auto_signals WHERE id=$1",
              [key],
            )
          ).rows[0];
          await tx.query(
            `INSERT INTO auto_signals(id,brand_id,source_id,url,payload,content_hash,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,content_hash=EXCLUDED.content_hash,last_seen_at=EXCLUDED.last_seen_at`,
            [
              key,
              brand.id,
              source.id,
              signal.url,
              JSON.stringify(signal),
              hash,
              now,
            ],
          );
          if (!old || old.content_hash !== hash) {
            await tx.query(
              "INSERT INTO auto_signal_revisions(signal_id,run_id,payload,content_hash,available_at) VALUES($1,$2,$3,$4,$5)",
              [key, id, JSON.stringify(signal), hash, now],
            );
            if (old) changed++;
            else created++;
          }
        }
        const scored = signals
          .map((s) => scoreAnnouncement(s, now.getTime()))
          .filter((s) => s !== null)
          .sort(
            (a, b) =>
              b.observation_score - a.observation_score ||
              a.signal.url.localeCompare(b.signal.url),
          );
        if (scored.length)
          await tx.query(
            "INSERT INTO auto_scores(run_id,brand_id,as_of,payload) VALUES($1,$2,$3,$4)",
            [
              id,
              brand.id,
              now,
              JSON.stringify({
                ...scored[0],
                brand_id: brand.id,
                brand_name: source.brand,
                signal_count: scored.length,
                as_of: now.toISOString(),
                signals: scored,
              }),
            ],
          );
        await tx.query(
          "UPDATE auto_runs SET status='succeeded',finished_at=$2,result=$3 WHERE id=$1",
          [
            id,
            now,
            JSON.stringify({
              source: source.id,
              fetched: signals.length,
              details_extracted: recent.filter(
                (s) => s.facts?.status === "extracted",
              ).length,
              detail_failures: detailFailures,
              created,
              changed,
              scorable: scored.length,
              response_sha256: digest(html),
              coverage: source.coverage,
            }),
          ],
        );
      });
    } catch (e) {
      await db.query(
        "UPDATE auto_runs SET status='failed',finished_at=now(),error=$2 WHERE id=$1",
        [id, e instanceof Error ? e.message : "采集失败"],
      );
    }
  }
  async function board() {
    const latest = (
      await db.query(
        "SELECT * FROM auto_runs ORDER BY started_at DESC LIMIT 10",
      )
    ).rows;
    const success = (
      await db.query<{ id: string; finished_at: Date }>(
        "SELECT id,finished_at FROM auto_runs WHERE status='succeeded' ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0];
    const fresh =
      !!success &&
      Date.now() - new Date(success.finished_at).getTime() < 12 * 3600000;
    const snapshots = success
      ? (
          await db.query<{ payload: Record<string, unknown> }>(
            "SELECT s.payload FROM auto_scores s JOIN brands b ON b.id=s.brand_id WHERE s.run_id=$1 AND b.active=true",
            [success.id],
          )
        ).rows
      : [];
    const enabled = (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM brands WHERE active=true",
      )
    ).rows[0].count;
    const configured = (
      await db.query("SELECT id FROM brands WHERE active=true AND name=$1", [
        source.brand,
      ])
    ).rows.length;
    const items = fresh
      ? snapshots
          .map((x) => x.payload)
          .filter(
            (p) => scoreAnnouncement(p.signal as Signal, Date.now()) !== null,
          )
      : [];
    return {
      items,
      next_cursor: null,
      data_as_of: success?.finished_at ?? null,
      mode: "observation",
      p72: null,
      headstart_index: null,
      quality_status: fresh ? "partial" : success ? "stale" : "insufficient",
      source,
      counts: {
        active_brands: enabled,
        configured_brands: configured,
        monitored_brands: fresh ? configured : 0,
        scored_brands: items.length,
      },
      runs: latest,
      message:
        "公告观察分仅按日期和标题规则计算；不是爆款率。上海适用、需求趋势、饱和度和概率校准尚不可用。",
    };
  }
  function register(app: Express) {
    app.get("/v1/opportunities", async (_req, res) => res.json(await board()));
    app.post("/v1/auto/update", async (_req, res) => {
      const result = await start();
      res.status(result.accepted ? 202 : 409).json(result);
    });
  }
  async function schedule() {
    if (running || stopped) return;
    const last = (
      await db.query<{ started_at: Date }>(
        "SELECT started_at FROM auto_runs ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0];
    if (
      !last ||
      Date.now() - new Date(last.started_at).getTime() >=
        source.interval_hours * 3600000
    )
      await start();
  }
  async function recover() {
    await db.query(
      "UPDATE auto_runs SET status='interrupted',finished_at=now(),error='服务重启，未完成事务不计成功；下轮重新读取列表' WHERE status='running'",
    );
  }
  async function stop() {
    stopped = true;
    await pending;
  }
  return { start, board, register, schedule, recover, stop };
}
