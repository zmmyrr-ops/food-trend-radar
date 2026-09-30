import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { legacyOwner, ownerOf } from "./accounts.js";

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
      author: String(n.user?.nickname || "小红书作者"),
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
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_media_jobs(id uuid PRIMARY KEY,brand_id uuid NOT NULL,product_id text NOT NULL,keyword text NOT NULL,names jsonb NOT NULL,state text NOT NULL,resources jsonb NOT NULL DEFAULT '[]',searched int NOT NULL DEFAULT 0,inspected int NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(brand_id,product_id));
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
      (state.block_code === "AUTH_EXPIRED" ||
        new Date(state.blocked_until).getTime() > Date.now())
    )
      throw Error(state.block_code || "COOLDOWN");
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
        if ([401, 403, 406, 461, 471].includes(r.status))
          throw Error("AUTH_EXPIRED");
        if (r.status === 429) throw Error("RATE_LIMITED");
        if (!r.ok) throw Error("UPSTREAM_ERROR");
        const text = await r.text();
        if (text.length > 5_000_000) throw Error("INVALID_RESPONSE");
        try {
          data = JSON.parse(text);
        } catch {
          throw Error("AUTH_EXPIRED");
        }
      }
      if (data?.success !== true || data?.code !== 0)
        throw Error("AUTH_EXPIRED");
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
        if (found.length)
          await db.query(
            "INSERT INTO coupon_media_cache(note_id,resources) VALUES($1,$2) ON CONFLICT(note_id) DO UPDATE SET resources=$2,observed_at=now()",
            [n.id, JSON.stringify(found)],
          );
      }
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
            "SELECT * FROM coupon_media_jobs WHERE state='queued' ORDER BY created_at LIMIT 1",
          )
        ).rows[0];
        if (!job) return;
        try {
          await run(job);
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
        }
      }
    })().finally(() => {
      worker = undefined;
    });
  }
  function publicJob(job: any) {
    if (!job) return null;
    const { names, seen_notes, search_id, ...safe } = job;
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
  ) {
    await credentials();
    const coupon = (
      await db.query<any>(
        "SELECT b.name,b.aliases,i.payload->>'name' AS title FROM coupon_items i JOIN brands b ON b.id=i.brand_id WHERE i.brand_id=$1 AND i.product_id=$2 AND b.active AND i.payload->>'identity'='name_match' ORDER BY i.observed_at DESC LIMIT 1",
        [brand, product],
      )
    ).rows[0];
    if (!coupon) throw Error("COUPON_NOT_FOUND");
    const keyword = coupon.name;
    const result = await db.transaction(async (tx) => {
      const old = (
        await tx.query<any>(
          "SELECT * FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3",
          [brand, product, owner],
        )
      ).rows[0];
      if (reset && old && ["queued", "running"].includes(old.state))
        throw Error("JOB_RUNNING");
      if (
        !reset &&
        old &&
        (["queued", "running"].includes(old.state) ||
          (!more &&
            old.keyword === keyword &&
            old.state === "complete" &&
            Date.now() - new Date(old.updated_at).getTime() < TTL) ||
          (old.state === "failed" &&
            Date.now() - new Date(old.updated_at).getTime() < 60_000))
      )
        return old;
      if (more && old && !reset && old.keyword === keyword) {
        if (old.exhausted || old.resources.length >= 200) return old;
        return (
          await tx.query<any>(
            "UPDATE coupon_media_jobs SET state='queued',target_count=$2,coupon_title=$3,searched=0,inspected=0,error_code=NULL,updated_at=now() WHERE id=$1 RETURNING *",
            [
              old.id,
              Math.min(200, old.resources.length + 20),
              coupon.title || "",
            ],
          )
        ).rows[0];
      }
      return (
        await tx.query<any>(
          "INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,refresh_details,coupon_title,owner_id) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8) ON CONFLICT(owner_id,brand_id,product_id) DO UPDATE SET id=excluded.id,keyword=excluded.keyword,names=excluded.names,state='queued',resources='[]',next_page=1,seen_notes='[]',target_count=40,exhausted=false,search_id=NULL,refresh_details=excluded.refresh_details,coupon_title=excluded.coupon_title,searched=0,inspected=0,error_code=NULL,created_at=now(),updated_at=now() RETURNING *",
          [
            randomUUID(),
            brand,
            product,
            keyword,
            JSON.stringify([coupon.name, ...coupon.aliases]),
            reset,
            coupon.title || "",
            owner,
          ],
        )
      ).rows[0];
    });
    kick();
    return publicJob(result);
  }
  function register(app: Express) {
    const input = z.object({
      brand_id: z.uuid(),
      product_id: z.string().min(1).max(100),
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
    app.post("/api/v3/coupon-media", async (req, res) => {
      const v = input
        .extend({
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
          ),
        });
      } catch (e) {
        const code = e instanceof Error ? e.message : "INTERNAL_ERROR";
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
                    ? "小红书请求凭据未配置"
                    : "无法创建素材任务",
            },
          });
      }
    });
    app.post("/api/v3/coupon-media/:id/cancel", async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      await db.query(
        "UPDATE coupon_media_jobs SET state='cancelled',updated_at=now() WHERE id=$1 AND owner_id=$2 AND state IN ('queued','running')",
        [id, ownerOf(req)],
      );
      res.json({ ok: true });
    });
  }
  return {
    register,
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
