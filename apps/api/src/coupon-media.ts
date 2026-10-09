import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { legacyOwner, ownerOf } from "./accounts.js";
import { type MediaTextNote, summarizeMediaText } from "./media-text.js";
import { changePoints, refundPoints } from "./points.js";

const SEARCH = "https://so.xiaohongshu.com/api/sns/web/v2/search/notes";
const DETAIL = "https://edith.xiaohongshu.com/api/sns/web/v1/feed";
const TTL = 4 * 3600_000;
const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•]/g, "");
export type LiveResource = {
  id: string;
  note_id: string;
  title: string;
  author: string;
  note_url: string;
  poster: string;
  video_url: string;
  match: string;
  note_text?: string;
  relevance?: "coupon" | "brand";
  matched_terms?: string[];
};
// Product/experience clues, not proof of the same coupon or its conditions.
export function couponMediaTerms(title: string, names: string[]): string[] {
  let text = title.normalize("NFKC").toLowerCase();
  for (const name of [...names].sort((a, b) => b.length - a.length))
    text = text.split(name.normalize("NFKC").toLowerCase()).join(" ");
  text = text.replace(
    /\d+(?:\.\d+)?\s*(?:元|折|人|次|小时|分钟|选|件|杯|张|天|代)?/g,
    " ",
  );
  const generic = new Set(
    "套餐 单人 双人 三人 四人 亲子 成人 儿童 门票 入园 单次 通用 工作日 周末 节假日 午市 晚市 午餐 晚餐 午间 晚间 自助 畅吃 无限 限量 限定 限时 优惠 团购 折扣 超值 特惠 新客 专享 专属 招牌 新品 全周 可用 到店 当天 买单 专用 代金 代用 抵用 代金券 抵用券 体验券 体验 国庆 中秋 双节 假期 黄金周 活动 福利 赠送 免费 仅限 全场 精选 经典 升级 优享 尊享 豪华 儿童票 成人票 亲子票 套票 通票 使用 餐厅 上海 室内 室外 小班 指导 浓醇 双拼 宝山 月光 实况 品牌 测试 券".split(
      " ",
    ),
  );
  const phrases =
    text.match(
      /寿喜烧|石锅鱼|牛排|奶昔|冰沙|烤肉|烤鸭|海鲜|小龙虾|三文鱼|蛋糕|拿铁|咖啡|拉面|轮滑|滑冰|滑雪|攀岩|蹦床|卡丁车|皮划艇|桨板|海洋馆|动物园|萌宠|摩天轮|旋转木马|过山车|巧克力/g,
    ) ?? [];
  return [
    ...new Set([
      ...phrases,
      ...[...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(text)]
        .filter((x) => x.isWordLike)
        .map((x) => x.segment.trim())
        .filter((x) => x.length >= 2 && !generic.has(x) && !/^\d+$/.test(x)),
    ]),
  ].slice(0, 12);
}
export function rankCouponResource(
  item: LiveResource,
  terms: string[],
): LiveResource {
  const text = normalize(`${item.title} ${item.note_text ?? ""}`);
  const matches = terms.filter((t) => text.includes(normalize(t)));
  return {
    ...item,
    relevance: matches.length ? "coupon" : "brand",
    matched_terms: matches,
    match: matches.length
      ? `券相关线索 · ${matches.join("、")} · 未核实同券`
      : "品牌通用补充 · 未核实同券",
  };
}
export function mediaUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      !u.hostname.endsWith(".xhscdn.com") ||
      u.username ||
      u.password ||
      u.port
    )
      return "";
    u.protocol = "https:";
    return u.href;
  } catch {
    return "";
  }
}
export function extractLiveResources(
  raw: unknown,
  noteId: string,
  token: string,
  names: string[],
): LiveResource[] {
  const item = object(raw).data?.items?.find(
    (x: any) => String(x.id ?? x.note_card?.note_id) === noteId,
  );
  const n = object(item?.note_card);
  const text = normalize(`${n.title ?? ""} ${n.desc ?? ""}`);
  if (
    !names.some(
      (name) => normalize(name).length >= 2 && text.includes(normalize(name)),
    )
  )
    return [];
  const result: LiveResource[] = [];
  for (const [index, image] of (Array.isArray(n.image_list)
    ? n.image_list
    : []
  ).entries()) {
    if (image.live_photo !== true) continue;
    const streams = Object.values(object(image.stream)).flat().map(object);
    const video = streams.map((x) => mediaUrl(x.master_url)).find(Boolean);
    if (!video) continue;
    const poster = mediaUrl(image.url_default) || mediaUrl(image.url_pre);
    result.push({
      id: `${noteId}:${image.file_id || index}`,
      note_id: noteId,
      title: String(n.title || "相关探店笔记"),
      author: String(n.user?.nickname || "素材作者"),
      note_url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}?${new URLSearchParams({ xsec_token: token, xsec_source: "pc_search" })}`,
      poster,
      video_url: video,
      match: "同品牌相关 · 未核实同券",
      note_text: String(n.desc ?? "").slice(0, 6000),
    });
  }
  return result;
}
export async function createCouponMedia(
  db: PGlite,
  credentialPath: string,
  options: {
    transport?: (
      url: string,
      headers: Record<string, string>,
      body: string,
    ) => Promise<any>;
    summarizeText?: typeof summarizeMediaText;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_media_jobs(id uuid PRIMARY KEY,brand_id uuid NOT NULL,product_id text NOT NULL,keyword text NOT NULL,names jsonb NOT NULL,state text NOT NULL,resources jsonb NOT NULL DEFAULT '[]',searched int NOT NULL DEFAULT 0,inspected int NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(brand_id,product_id));
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS text_state text;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS text_error text;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS text_summary jsonb;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS text_charge_key text;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS text_notes jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS point_charge_key text;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS point_before_count int NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS coupon_media_cache(note_id text PRIMARY KEY,resources jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS coupon_media_gate(id int PRIMARY KEY,finished_at timestamptz,blocked_until timestamptz,credential_hash text,block_code text);
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS next_page int NOT NULL DEFAULT 1;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS seen_notes jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS target_count int NOT NULL DEFAULT 40;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS exhausted boolean NOT NULL DEFAULT false;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS search_id text;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS coupon_title text NOT NULL DEFAULT '';
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS refresh_details boolean NOT NULL DEFAULT false;
    INSERT INTO coupon_media_gate(id) VALUES(1) ON CONFLICT DO NOTHING;
    ALTER TABLE coupon_media_jobs ADD COLUMN IF NOT EXISTS owner_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
    ALTER TABLE coupon_media_jobs DROP CONSTRAINT IF EXISTS coupon_media_jobs_brand_id_product_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS coupon_media_owner_product ON coupon_media_jobs(owner_id,brand_id,product_id);
    UPDATE coupon_media_jobs SET state='interrupted',error_code='INTERRUPTED',updated_at=now() WHERE state IN ('queued','running');
  `);
  for (const job of (
    await db.query<any>(
      "SELECT id,text_charge_key FROM coupon_media_jobs WHERE text_state IN ('queued','running')",
    )
  ).rows) {
    if (job.text_charge_key) await refundPoints(db, job.text_charge_key);
    await db.query(
      "UPDATE coupon_media_jobs SET text_state='failed',text_error='INTERRUPTED',text_charge_key=NULL WHERE id=$1",
      [job.id],
    );
  }
  async function captureText(
    job: any,
    id: string,
    raw?: any,
    resources: LiveResource[] = [],
  ) {
    const note = raw?.data?.items?.find(
      (x: any) => (x.id ?? x.note_card?.note_id) === id,
    )?.note_card;
    const title = String(note?.title ?? resources[0]?.title ?? "");
    const text = String(note?.desc ?? resources[0]?.note_text ?? "").slice(
      0,
      6000,
    );
    if (
      !text.trim() ||
      !job.names.some((n: string) =>
        normalize(title + text).includes(normalize(n)),
      )
    )
      return;
    await db.query(
      "UPDATE coupon_media_jobs SET text_notes=text_notes || $2::jsonb WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(text_notes) n WHERE n->>'id'=$3)",
      [job.id, JSON.stringify([{ id, title, text }]), id],
    );
  }
  async function finishText(id: string) {
    const job = (
      await db.query<any>(
        "UPDATE coupon_media_jobs SET text_state='running' WHERE id=$1 AND text_state='queued' RETURNING *",
        [id],
      )
    ).rows[0];
    if (!job) return;
    try {
      if (job.state !== "complete" && !job.resources.length)
        throw Error("INCOMPLETE");
      const notes = new Map<string, MediaTextNote>();
      for (const r of job.resources)
        if (r.note_text)
          notes.set(r.note_id, {
            id: r.note_id,
            title: r.title,
            text: r.note_text,
          });
      for (const n of job.text_notes) notes.set(n.id, n);
      if (!notes.size) throw Error("NO_TEXT");
      let summary;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          summary = await (options.summarizeText ?? summarizeMediaText)(
            [...notes.values()].slice(-25),
            job.keyword,
            join(dirname(credentialPath), "deepseek.json"),
          );
          break;
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (
            attempt ||
            !["SUMMARY_BUSY", "SUMMARY_INVALID", "SUMMARY_TRUNCATED"].includes(
              code,
            )
          )
            throw error;
          await wait(2000);
        }
      }
      if (!summary) throw Error("SUMMARY_FAILED");
      await db.query(
        "UPDATE coupon_media_jobs SET text_state='complete',text_error=NULL,text_summary=$2,text_charge_key=NULL WHERE id=$1",
        [id, JSON.stringify(summary)],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = [
        "NO_TEXT",
        "NO_COPY",
        "INCOMPLETE",
        "SUMMARY_BUSY",
        "SUMMARY_INVALID",
        "SUMMARY_TRUNCATED",
        "NOT_CONFIGURED",
      ].includes(message)
        ? message
        : message.includes("timeout") ||
            (error instanceof Error && error.name === "TimeoutError")
          ? "SUMMARY_TIMEOUT"
          : "SUMMARY_FAILED";
      console.warn("Media text summary failed", { job: id, code });
      if (job.text_charge_key) await refundPoints(db, job.text_charge_key);
      await db.query(
        "UPDATE coupon_media_jobs SET text_state='failed',text_error=$2,text_charge_key=NULL WHERE id=$1",
        [id, code],
      );
    }
  }
  let worker: Promise<void> | undefined;
  let stopped = false;
  const wait = options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  async function credentials() {
    try {
      const text = await readFile(credentialPath, "utf8");
      const records = z
        .array(
          z.object({
            url: z.string(),
            headers: z.record(z.string(), z.string()),
            body: z.string(),
          }),
        )
        .parse(JSON.parse(text));
      return { records, hash: createHash("sha256").update(text).digest("hex") };
    } catch {
      throw Error("AUTH_MISSING");
    }
  }
  async function request(
    url: string,
    body: Record<string, unknown>,
    jobId: string,
  ) {
    const c = await credentials();
    const template = c.records.find((r) => r.url === url);
    if (!template) throw Error("AUTH_MISSING");
    const state = (
      await db.query<any>("SELECT * FROM coupon_media_gate WHERE id=1")
    ).rows[0];
    if (
      state.credential_hash === c.hash &&
      new Date(state.blocked_until).getTime() > Date.now()
    )
      throw Error("COOLDOWN");
    const delay = Math.max(
      0,
      new Date(state.finished_at || "1970-01-01").getTime() +
        3000 +
        Math.random() * 2000 -
        Date.now(),
    );
    await wait(delay);
    if (await cancelled(jobId)) throw Error("INTERRUPTED");
    // Reuse only headers supplied for this exact origin; never forward credentials to media hosts.
    const headers = Object.fromEntries(
      Object.entries(template.headers).filter(([k]) =>
        [
          "accept",
          "accept-language",
          "content-type",
          "cookie",
          "origin",
          "referer",
          "user-agent",
          "x-s",
          "x-s-common",
          "x-t",
          "x-b3-traceid",
          "x-xray-traceid",
          "x-rap-param",
          "xy-direction",
        ].includes(k.toLowerCase()),
      ),
    );
    let httpStatus: number | undefined;
    let upstreamCode: number | string | undefined;
    try {
      let data: any;
      if (options.transport)
        data = await options.transport(url, headers, JSON.stringify(body));
      else {
        const r = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        httpStatus = r.status;
        if ([401, 403].includes(r.status)) throw Error("AUTH_EXPIRED");
        if ([406, 429, 461, 471].includes(r.status))
          throw Error("RATE_LIMITED");
        if (!r.ok) throw Error("UPSTREAM_ERROR");
        const text = await r.text();
        if (text.length > 5_000_000) throw Error("INVALID_RESPONSE");
        try {
          data = JSON.parse(text);
        } catch {
          throw Error("INVALID_RESPONSE");
        }
      }
      upstreamCode =
        typeof data?.code === "number" || typeof data?.code === "string"
          ? data.code
          : undefined;
      if (data?.success !== true || data?.code !== 0)
        throw Error(
          Number(upstreamCode) === -100 ? "AUTH_EXPIRED" : "UPSTREAM_ERROR",
        );
      await db.query(
        "UPDATE coupon_media_gate SET credential_hash=$1,block_code=NULL,blocked_until=NULL WHERE id=1",
        [c.hash],
      );
      return data;
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "UPSTREAM_ERROR",
          "INVALID_RESPONSE",
        ].includes(error.message)
          ? error.message
          : "NETWORK_ERROR";
      console.warn("MEDIA_REQUEST_FAILED", {
        endpoint: new URL(url).pathname,
        code,
        http_status: httpStatus,
        upstream_code: upstreamCode,
        job_id: jobId,
      });
      await db.query(
        "UPDATE coupon_media_gate SET credential_hash=$1,block_code=$2,blocked_until=now()+interval '10 minutes' WHERE id=1",
        [c.hash, code],
      );
      throw Error(code);
    } finally {
      await db.query(
        "UPDATE coupon_media_gate SET finished_at=now() WHERE id=1",
      );
    }
  }
  async function cancelled(id: string) {
    return (
      stopped ||
      (
        await db.query<any>("SELECT state FROM coupon_media_jobs WHERE id=$1", [
          id,
        ])
      ).rows[0]?.state !== "running"
    );
  }
  async function run(job: any) {
    if (couponMediaTerms(job.coupon_title, job.names).length)
      return runPrioritized(job);
    await db.query(
      "UPDATE coupon_media_jobs SET state='running',error_code=NULL,updated_at=now() WHERE id=$1",
      [job.id],
    );
    const c = await credentials();
    const searchTemplate = c.records.find((r) => r.url === SEARCH);
    const detailTemplate = c.records.find((r) => r.url === DETAIL);
    if (!searchTemplate || !detailTemplate) throw Error("AUTH_MISSING");
    const resources: LiveResource[] = [...job.resources];
    const seenNotes = new Set<string>(job.seen_notes);
    const seenAssets = new Set<string>(
      resources.map((a) => new URL(a.video_url).pathname),
    );
    let searched = 0,
      inspected = 0;
    const searchId = job.search_id || randomUUID().replaceAll("-", "");
    await db.query("UPDATE coupon_media_jobs SET search_id=$2 WHERE id=$1", [
      job.id,
      searchId,
    ]);
    const target = job.target_count;
    const startPage = job.next_page;
    for (
      let page = startPage;
      page < startPage + 3 && resources.length < target;
      page++
    ) {
      if (await cancelled(job.id)) return;
      const data = await request(
        SEARCH,
        {
          ...JSON.parse(searchTemplate.body),
          keyword: job.keyword,
          page,
          page_size: 20,
          search_id: searchId,
        },
        job.id,
      );
      const notes = Array.isArray(data.data?.items) ? data.data.items : [];
      for (const note of notes) {
        if (
          resources.length >= target ||
          inspected >= 20 ||
          (await cancelled(job.id))
        )
          break;
        if (
          note.model_type !== "note" ||
          typeof note.id !== "string" ||
          typeof note.xsec_token !== "string" ||
          seenNotes.has(note.id)
        )
          continue;
        searched++;
        let found: LiveResource[];
        const cache = (
          await db.query<any>(
            "SELECT resources FROM coupon_media_cache WHERE note_id=$1 AND observed_at>now()-interval '4 hours' AND (NOT $2::boolean OR observed_at >= $3::timestamptz)",
            [note.id, job.refresh_details, job.created_at],
          )
        ).rows[0];
        if (cache) found = cache.resources;
        else {
          const detail = await request(
            DETAIL,
            {
              ...JSON.parse(detailTemplate.body),
              source_note_id: note.id,
              xsec_token: note.xsec_token,
              xsec_source: "pc_search",
            },
            job.id,
          );
          if (await cancelled(job.id)) return;
          found = extractLiveResources(
            detail,
            note.id,
            note.xsec_token,
            job.names,
          );
          await captureText(job, note.id, detail, found);
          // Empty/mismatched results are not cached across brands.
          if (found.length)
            await db.query(
              "INSERT INTO coupon_media_cache(note_id,resources) VALUES($1,$2) ON CONFLICT(note_id) DO UPDATE SET resources=$2,observed_at=now()",
              [note.id, JSON.stringify(found)],
            );
        }
        // Cache entries must still be related to this brand; use the original note's verified names.
        if (
          cache &&
          !job.names.some((name: string) =>
            normalize(found[0]?.title || "").includes(normalize(name)),
          )
        )
          found = [];
        if (cache) await captureText(job, note.id, undefined, found);
        inspected++;
        for (const item of found) {
          const key = new URL(item.video_url).pathname;
          if (seenAssets.has(key)) continue;
          seenAssets.add(key);
          resources.push(rankCouponResource(item, []));
          if (resources.length === target) break;
        }
        // Keep a partially consumed note available for the next batch.
        if (
          found.every((item) =>
            seenAssets.has(new URL(item.video_url).pathname),
          )
        )
          seenNotes.add(note.id);
        await db.query(
          "UPDATE coupon_media_jobs SET resources=$2,searched=$3,inspected=$4,seen_notes=$5,updated_at=now() WHERE id=$1",
          [
            job.id,
            JSON.stringify(resources),
            searched,
            inspected,
            JSON.stringify([...seenNotes]),
          ],
        );
      }
      // Do not advance past unconsumed notes when reaching the batch limit.
      const completePage = notes.every(
        (n: any) =>
          n.model_type !== "note" ||
          typeof n.id !== "string" ||
          typeof n.xsec_token !== "string" ||
          seenNotes.has(n.id),
      );
      await db.query(
        "UPDATE coupon_media_jobs SET next_page=$2,exhausted=$3 WHERE id=$1",
        [
          job.id,
          completePage ? page + 1 : page,
          completePage && !data.data?.has_more,
        ],
      );
      if (!completePage || !data.data?.has_more || inspected >= 20) break;
    }
    if (!(await cancelled(job.id)))
      await db.query(
        "UPDATE coupon_media_jobs SET state='complete',updated_at=now() WHERE id=$1",
        [job.id],
      );
  }
  async function runPrioritized(job: any) {
    await db.query(
      "UPDATE coupon_media_jobs SET state='running',error_code=NULL,updated_at=now() WHERE id=$1",
      [job.id],
    );
    const { records } = await credentials();
    const searchTemplate = records.find((r) => r.url === SEARCH),
      detailTemplate = records.find((r) => r.url === DETAIL);
    if (!searchTemplate || !detailTemplate) throw Error("AUTH_MISSING");
    const terms = couponMediaTerms(job.coupon_title, job.names);
    const existing: LiveResource[] = job.resources;
    const target = job.target_count - existing.length;
    const selectedKeys = new Set(
      existing.map((x) => new URL(x.video_url).pathname),
    );
    const seen = new Set<string>(job.seen_notes);
    const searchId = job.search_id || randomUUID().replaceAll("-", "");
    await db.query("UPDATE coupon_media_jobs SET search_id=$2 WHERE id=$1", [
      job.id,
      searchId,
    ]);
    const pages: { page: number; more: boolean; notes: any[] }[] = [];
    const candidates = new Map<string, any>();
    // Bounded search window: brand-only search, at most 3 pages and 20 details.
    for (let page = job.next_page; page < job.next_page + 3; page++) {
      if (await cancelled(job.id)) return;
      const data = await request(
        SEARCH,
        {
          ...JSON.parse(searchTemplate.body),
          keyword: job.keyword,
          page,
          page_size: 20,
          search_id: searchId,
        },
        job.id,
      );
      const notes = (
        Array.isArray(data.data?.items) ? data.data.items : []
      ).filter(
        (n: any) =>
          n.model_type === "note" &&
          typeof n.id === "string" &&
          typeof n.xsec_token === "string",
      );
      pages.push({ page, more: !!data.data?.has_more, notes });
      for (const n of notes)
        if (!seen.has(n.id) && !candidates.has(n.id)) candidates.set(n.id, n);
      if (!data.data?.has_more) break;
    }
    const hint = (n: any) =>
      terms.filter((t) =>
        normalize(
          String(n.note_card?.display_title ?? n.note_card?.title ?? ""),
        ).includes(normalize(t)),
      ).length;
    const ordered = [...candidates.values()].sort((a, b) => hint(b) - hint(a));
    const related: LiveResource[] = [],
      generic: LiveResource[] = [];
    const inspectedNotes = new Map<string, LiveResource[]>();
    const collectedKeys = new Set(selectedKeys);
    let inspected = 0;
    for (const n of ordered) {
      if (
        inspected >= 20 ||
        related.length >= target ||
        (await cancelled(job.id))
      )
        break;
      const cache = (
        await db.query<any>(
          "SELECT resources FROM coupon_media_cache WHERE note_id=$1 AND observed_at>now()-interval '4 hours' AND (NOT $2::boolean OR observed_at >= $3::timestamptz)",
          [n.id, job.refresh_details, job.created_at],
        )
      ).rows[0];
      let found: LiveResource[];
      if (cache)
        found = cache.resources.filter((r: LiveResource) =>
          job.names.some((name: string) =>
            normalize(`${r.title} ${r.note_text ?? ""}`).includes(
              normalize(name),
            ),
          ),
        );
      else {
        const raw = await request(
          DETAIL,
          {
            ...JSON.parse(detailTemplate.body),
            source_note_id: n.id,
            xsec_token: n.xsec_token,
            xsec_source: "pc_search",
          },
          job.id,
        );
        if (await cancelled(job.id)) return;
        found = extractLiveResources(raw, n.id, n.xsec_token, job.names);
        await captureText(job, n.id, raw, found);
        if (found.length)
          await db.query(
            "INSERT INTO coupon_media_cache(note_id,resources) VALUES($1,$2) ON CONFLICT(note_id) DO UPDATE SET resources=$2,observed_at=now()",
            [n.id, JSON.stringify(found)],
          );
      }
      if (cache) await captureText(job, n.id, undefined, found);
      inspected++;
      found = found.map((r) => rankCouponResource(r, terms));
      inspectedNotes.set(n.id, found);
      for (const item of found) {
        const key = new URL(item.video_url).pathname;
        if (collectedKeys.has(key)) continue;
        collectedKeys.add(key);
        (item.relevance === "coupon" ? related : generic).push(item);
      }
      await db.query(
        "UPDATE coupon_media_jobs SET searched=$2,inspected=$2,updated_at=now() WHERE id=$1 AND state='running'",
        [job.id, inspected],
      );
    }
    if (await cancelled(job.id)) return;
    const added = [...related, ...generic].slice(0, target);
    for (const x of added) selectedKeys.add(new URL(x.video_url).pathname);
    for (const [id, found] of inspectedNotes)
      if (found.every((x) => selectedKeys.has(new URL(x.video_url).pathname)))
        seen.add(id);
    const unfinished = pages.find((p) => p.notes.some((n) => !seen.has(n.id)));
    const last = pages.at(-1);
    const nextPage = unfinished?.page ?? (last ? last.page + 1 : job.next_page);
    const exhausted = !unfinished && !!last && !last.more;
    await db.query(
      "UPDATE coupon_media_jobs SET resources=$2,seen_notes=$3,next_page=$4,exhausted=$5,state='complete',updated_at=now() WHERE id=$1 AND state='running'",
      [
        job.id,
        JSON.stringify(
          [...existing.map((x) => rankCouponResource(x, terms)), ...added].sort(
            (a, b) =>
              Number(b.relevance === "coupon") -
              Number(a.relevance === "coupon"),
          ),
        ),
        JSON.stringify([...seen]),
        nextPage,
        exhausted,
      ],
    );
  }
  function kick() {
    if (worker || stopped) return;
    worker = (async () => {
      while (!stopped) {
        const job = (
          await db.query<any>(
            "SELECT * FROM coupon_media_jobs WHERE state='queued' OR text_state='queued' ORDER BY created_at LIMIT 1",
          )
        ).rows[0];
        if (!job) return;
        try {
          if (job.state === "queued") await run(job);
        } catch (e) {
          const code =
            e instanceof Error &&
            [
              "AUTH_MISSING",
              "AUTH_EXPIRED",
              "RATE_LIMITED",
              "UPSTREAM_ERROR",
              "INVALID_RESPONSE",
              "NETWORK_ERROR",
              "COOLDOWN",
              "INTERRUPTED",
            ].includes(e.message)
              ? e.message
              : "INTERNAL_ERROR";
          await db.query(
            "UPDATE coupon_media_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running')",
            [job.id, code],
          );
        } finally {
          await finishText(job.id);
          const final = (
            await db.query<any>("SELECT * FROM coupon_media_jobs WHERE id=$1", [
              job.id,
            ])
          ).rows[0];
          if (
            final?.point_charge_key &&
            final.point_charge_key === job.point_charge_key
          ) {
            if (final.resources.length <= final.point_before_count)
              await refundPoints(db, final.point_charge_key);
            await db.query(
              "UPDATE coupon_media_jobs SET point_charge_key=NULL WHERE id=$1 AND point_charge_key=$2",
              [job.id, final.point_charge_key],
            );
          }
        }
      }
    })().finally(() => {
      worker = undefined;
    });
  }
  function publicJob(job: any) {
    if (!job) return null;
    const {
      text_notes,
      text_charge_key,
      names,
      seen_notes,
      search_id,
      point_charge_key,
      point_before_count,
      ...safe
    } = job;
    return {
      ...safe,
      resources: job.resources.map(({ note_text, ...r }: LiveResource) => r),
      expires_at: new Date(
        new Date(job.updated_at).getTime() + TTL,
      ).toISOString(),
    };
  }
  async function start(
    brand: string,
    product: string,
    more = false,
    reset = false,
    owner = legacyOwner,
    includeText = false,
  ) {
    const coupon = (
      await db.query<any>(
        "SELECT b.name,b.aliases,i.payload->>'name' AS title FROM coupon_known_items i JOIN brands b ON b.id=i.brand_id WHERE i.brand_id=$1 AND i.product_id=$2 AND b.active AND i.payload->>'identity'='name_match' ORDER BY i.observed_at DESC LIMIT 1",
        [brand, product],
      )
    ).rows[0];
    if (!coupon) throw Error("COUPON_NOT_FOUND");
    const keyword = coupon.name;
    const result = await db.transaction(async (tx) => {
      if (owner !== legacyOwner)
        await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
          owner,
        ]);
      const old = (
        await tx.query<any>(
          "SELECT * FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3",
          [brand, product, owner],
        )
      ).rows[0];
      if (old && ["queued", "running"].includes(old.text_state)) return old;
      let accepted = false;
      let cachedNotes: unknown[] | undefined;
      const selectJob = async () => {
        if (reset && old && ["queued", "running"].includes(old.state))
          throw Error("JOB_RUNNING");
        if (
          !reset &&
          old &&
          (["queued", "running"].includes(old.state) ||
            (old.state === "failed" &&
              Date.now() - new Date(old.updated_at).getTime() < 60_000))
        )
          return old;
        // Only reuse public network resources; every account gets its own job ID.
        if (!reset && !more) {
          const shared = (
            await tx.query<any>(
              "SELECT * FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND keyword=$3 AND coupon_title=$4 AND state='complete' AND jsonb_array_length(resources)>0 AND updated_at>now()-interval '4 hours' ORDER BY updated_at DESC LIMIT 1",
              [brand, product, keyword, coupon.title || ""],
            )
          ).rows[0];
          const signedUrlsValid = shared?.resources.every((r: LiveResource) => {
            try {
              const t = new URL(r.video_url).searchParams.get("t");
              if (!t) return true;
              const expiry = /^\d{10}$/.test(t)
                ? Number(t)
                : /^[a-f0-9]{8}$/i.test(t)
                  ? Number.parseInt(t, 16)
                  : NaN;
              return (
                !Number.isFinite(expiry) || expiry * 1000 > Date.now() + 300000
              );
            } catch {
              return false;
            }
          });
          if (shared && signedUrlsValid) {
            accepted = true;
            cachedNotes = shared.text_notes;
            if (
              owner !== legacyOwner &&
              (!old || old.state !== "complete" || !old.resources.length)
            )
              await changePoints(
                tx,
                owner,
                10 * -1,
                "获取网络素材",
                `media-cache:${randomUUID()}`,
              );
            await tx.query(
              "UPDATE coupon_media_jobs SET updated_at=now() WHERE id=$1",
              [shared.id],
            );
            return (
              await tx.query<any>(
                `INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,resources,coupon_title,owner_id,next_page,seen_notes,target_count,exhausted,search_id)
            VALUES($1,$2,$3,$4,$5,'complete',$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT(owner_id,brand_id,product_id) DO UPDATE SET resources=excluded.resources,state='complete',keyword=excluded.keyword,names=excluded.names,coupon_title=excluded.coupon_title,next_page=excluded.next_page,seen_notes=excluded.seen_notes,target_count=excluded.target_count,exhausted=excluded.exhausted,search_id=excluded.search_id,error_code=NULL,updated_at=now() RETURNING *`,
                [
                  randomUUID(),
                  brand,
                  product,
                  keyword,
                  JSON.stringify([coupon.name, ...coupon.aliases]),
                  JSON.stringify(shared.resources),
                  coupon.title || "",
                  owner,
                  shared.next_page,
                  JSON.stringify(shared.seen_notes),
                  shared.target_count,
                  shared.exhausted,
                  shared.search_id,
                ],
              )
            ).rows[0];
          }
        }
        await credentials();
        if (
          more &&
          old &&
          !reset &&
          old.keyword === keyword &&
          (old.exhausted || old.resources.length >= 200)
        )
          return old;
        accepted = true;
        const chargeKey =
          owner === legacyOwner ? null : `media:${randomUUID()}`;
        if (chargeKey)
          await changePoints(
            tx,
            owner,
            more && !reset && old ? -5 : -10,
            more && !reset && old ? "获取更多素材" : "获取网络素材",
            chargeKey,
          );
        if (more && old && !reset && old.keyword === keyword) {
          if (old.exhausted || old.resources.length >= 200) return old;
          return (
            await tx.query<any>(
              "UPDATE coupon_media_jobs SET point_charge_key=$4,point_before_count=jsonb_array_length(resources),state='queued',target_count=$2,coupon_title=$3,searched=0,inspected=0,error_code=NULL,updated_at=now() WHERE id=$1 RETURNING *",
              [
                old.id,
                Math.min(200, old.resources.length + 20),
                coupon.title || "",
                chargeKey,
              ],
            )
          ).rows[0];
        }
        return (
          await tx.query<any>(
            "INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,refresh_details,coupon_title,owner_id,point_charge_key,point_before_count) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,0) ON CONFLICT(owner_id,brand_id,product_id) DO UPDATE SET point_charge_key=excluded.point_charge_key,point_before_count=0,id=excluded.id,keyword=excluded.keyword,names=excluded.names,state='queued',resources='[]',text_notes='[]',text_state=NULL,text_summary=NULL,next_page=1,seen_notes='[]',target_count=40,exhausted=false,search_id=NULL,refresh_details=excluded.refresh_details,coupon_title=excluded.coupon_title,searched=0,inspected=0,error_code=NULL,created_at=now(),updated_at=now() RETURNING *",
            [
              randomUUID(),
              brand,
              product,
              keyword,
              JSON.stringify([coupon.name, ...coupon.aliases]),
              reset,
              coupon.title || "",
              owner,
              chargeKey,
            ],
          )
        ).rows[0];
      };
      const selected = await selectJob();
      if (cachedNotes?.length)
        await tx.query(
          "UPDATE coupon_media_jobs SET text_notes=$2 WHERE id=$1",
          [selected.id, JSON.stringify(cachedNotes)],
        );
      if (includeText && accepted) {
        const key = owner === legacyOwner ? null : `media-text:${randomUUID()}`;
        if (key) await changePoints(tx, owner, -5, "整理文字素材", key);
        return (
          await tx.query<any>(
            "UPDATE coupon_media_jobs SET text_state='queued',text_error=NULL,text_charge_key=$2,text_summary=NULL WHERE id=$1 RETURNING *",
            [selected.id, key],
          )
        ).rows[0];
      }
      if (reset && accepted)
        await tx.query(
          "UPDATE coupon_media_jobs SET text_state=NULL,text_summary=NULL,text_notes='[]' WHERE id=$1",
          [selected.id],
        );
      return selected;
    });
    kick();
    return publicJob(result);
  }
  async function generateText(brand: string, product: string, owner: string) {
    const job = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [owner]);
      const current = (
        await tx.query<any>(
          "SELECT * FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3 FOR UPDATE",
          [brand, product, owner],
        )
      ).rows[0];
      if (!current?.resources.length) throw Error("MATERIALS_REQUIRED");
      if (["queued", "running"].includes(current.text_state)) return current;
      if (["queued", "running"].includes(current.state))
        throw Error("JOB_RUNNING");
      if (
        !current.text_notes.length &&
        !current.resources.some((r: LiveResource) => r.note_text?.trim())
      )
        throw Error("NO_TEXT");
      const key = `media-text:${randomUUID()}`;
      await changePoints(tx, owner, -5, "智能生成视频文案", key);
      return (
        await tx.query<any>(
          "UPDATE coupon_media_jobs SET text_state='queued',text_error=NULL,text_charge_key=$2 WHERE id=$1 RETURNING *",
          [current.id, key],
        )
      ).rows[0];
    });
    kick();
    return publicJob(job);
  }
  function register(app: Express) {
    const input = z.object({
      brand_id: z.uuid(),
      product_id: z.string().min(1).max(100),
    });
    app.post("/api/v3/coupon-media/text", async (req, res) => {
      const v = input.parse(req.body);
      try {
        res.status(202).json({
          job: await generateText(v.brand_id, v.product_id, ownerOf(req)),
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const messages: Record<string, string> = {
          MATERIALS_REQUIRED: "请先获取视频素材",
          JOB_RUNNING: "请等待素材获取完成",
          NO_TEXT: "暂存文章不足，请先再获取一些素材",
          POINTS_INSUFFICIENT: "积分不足",
        };
        res
          .status(code === "POINTS_INSUFFICIENT" ? 402 : 409)
          .json({ error: { message: messages[code] || "暂时无法生成文案" } });
      }
    });
    app.get("/api/v3/coupon-media", async (req, res) => {
      const v = input.parse(req.query);
      const job = (
        await db.query<any>(
          "SELECT * FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3",
          [v.brand_id, v.product_id, ownerOf(req)],
        )
      ).rows[0];
      res.json({ job: publicJob(job) });
    });
    app.get("/api/v3/coupon-media/download", async (req, res) => {
      const v = input
        .extend({ resource_id: z.string().min(1).max(200) })
        .parse(req.query);
      const job = (
        await db.query<any>(
          "SELECT resources FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3",
          [v.brand_id, v.product_id, ownerOf(req)],
        )
      ).rows[0];
      const resource = job?.resources.find(
        (r: LiveResource) => r.id === v.resource_id,
      );
      if (!resource) {
        res.status(404).json({ error: { message: "素材不存在" } });
        return;
      }
      try {
        const url = new URL(resource.video_url);
        if (
          url.protocol !== "https:" ||
          !url.hostname.endsWith(".xhscdn.com") ||
          url.port ||
          url.username ||
          url.password
        )
          throw Error("不支持的素材地址");
        const addresses = await lookup(url.hostname, { all: true });
        if (
          !addresses.length ||
          addresses.some((x) =>
            /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::|fc|fd|fe80)/i.test(
              x.address,
            ),
          )
        )
          throw Error("不支持的素材地址");
        const upstream = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(45000),
        });
        if (!upstream.ok || !upstream.body)
          throw Error("素材链接已失效，请重新获取");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of upstream.body) {
          size += chunk.length;
          if (size > 50 * 1024 * 1024) throw Error("单个素材超过50MB");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.subarray(4, 8).toString() !== "ftyp")
          throw Error("素材不是有效的视频文件");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="material.mp4"',
        );
        res.type("video/mp4").send(bytes);
      } catch {
        res.status(502).json({
          error: { message: "素材下载失败或链接已过期，请重新获取后重试" },
        });
      }
    });
    app.post("/api/v3/coupon-media", async (req, res) => {
      const v = input
        .extend({
          include_text: z.boolean().default(false),
          more: z.boolean().default(false),
          reset: z.boolean().default(false),
        })
        .strict()
        .refine((v) => !(v.more && v.reset), "不能同时追加和重置")
        .parse(req.body);
      try {
        res.status(202).json({
          job: await start(
            v.brand_id,
            v.product_id,
            v.more,
            v.reset,
            ownerOf(req),
            false,
          ),
        });
      } catch (e) {
        const code = e instanceof Error ? e.message : "INTERNAL_ERROR";
        if (code === "POINTS_INSUFFICIENT")
          return res.status(402).json({
            error: {
              code,
              message: "积分不足，请前往工作台查看积分或邀请好友",
            },
          });
        res
          .status(
            code === "JOB_RUNNING"
              ? 409
              : code === "COUPON_NOT_FOUND"
                ? 404
                : 503,
          )
          .json({
            error: {
              code: [
                "COUPON_NOT_FOUND",
                "AUTH_MISSING",
                "JOB_RUNNING",
              ].includes(code)
                ? code
                : "INTERNAL_ERROR",
              message:
                code === "JOB_RUNNING"
                  ? "请先停止当前素材获取，再重置"
                  : code === "AUTH_MISSING"
                    ? "素材平台请求凭据未配置"
                    : "无法创建素材任务",
            },
          });
      }
    });
    app.post("/api/v3/coupon-media/:id/cancel", async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const cancelled = (
        await db.query<any>(
          "UPDATE coupon_media_jobs SET state='cancelled',updated_at=now() WHERE id=$1 AND owner_id=$2 AND state IN ('queued','running') RETURNING point_charge_key,resources,point_before_count",
          [id, ownerOf(req)],
        )
      ).rows[0];
      if (
        cancelled?.point_charge_key &&
        cancelled.resources.length <= cancelled.point_before_count
      )
        await refundPoints(db, cancelled.point_charge_key);
      res.json({ ok: true });
    });
  }
  return {
    register,
    generateText,
    start,
    drain: async () => {
      await worker;
    },
    stop: async () => {
      stopped = true;
      await worker;
    },
  };
}
