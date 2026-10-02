import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Express } from "express";
import { z } from "zod";
import seeds from "./topic-ids.json" with { type: "json" };
export type TopicPlay = {
  topic: string;
  display: string | null;
  url: string | null;
  checked_at: string;
  view_count?: number;
  status: "ok" | "unmatched" | "unavailable";
};
const ua =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export function discoverTopics(html: string) {
  const entries = [
    ...html
      .replace(/\\"/g, '"')
      .matchAll(/"hashtagId":"(\d+)","hashtagName":"([^"\\]+)"/g),
  ];
  return Object.fromEntries(entries.map((m) => [m[2], m[1]]));
}
export function parseTopicPlays(html: string, expected: string) {
  const plain = html.replace(/<!--.*?-->/gs, "");
  const block = plain.match(
    /data-e2e="topic-title"[^>]*>([\s\S]{0,1800}?)<\/span>/,
  )?.[1];
  if (!block) return null;
  const title = block.match(/<h1[^>]*>#?([^<]+)<\/h1>/)?.[1]?.trim();
  if (title !== expected) return null;
  return block.match(/([\d.]+[万亿]?)次播放/)?.[1] || null;
}
export function parseTopicSuggestion(data: unknown, expected: string) {
  const body = z
    .object({
      status_code: z.literal(0),
      sug_list: z
        .array(
          z.object({
            cha_name: z.string(),
            cid: z.string().regex(/^\d+$/),
            view_count: z.number().int().nonnegative().safe(),
          }),
        )
        .nullable()
        .optional(),
    })
    .parse(data);
  const normalize = (value: string) =>
    value.normalize("NFKC").trim().toLowerCase();
  return (
    body.sug_list?.find(
      (item) => normalize(item.cha_name) === normalize(expected),
    ) || null
  );
}
export function formatTopicCount(count: number) {
  if (count >= 100_000_000)
    return `${Number((count / 100_000_000).toFixed(2))}亿`;
  if (count >= 10_000) return `${Number((count / 10_000).toFixed(2))}万`;
  return String(count);
}
export function registerTopicPlays(app: Express, cacheFile: string) {
  let ids: Record<string, string> = { ...seeds };
  let cache: Record<string, TopicPlay> = {};
  const ready = readFile(cacheFile, "utf8")
    .then((s) => {
      const data = JSON.parse(s);
      ids = { ...ids, ...data.ids };
      cache = data.version === 2 ? data.cache || {} : {};
    })
    .catch(() => {});
  let queue = Promise.resolve();
  let nextAt = 0;
  const pending = new Map<string, Promise<TopicPlay>>();
  async function page(url: string) {
    await new Promise((r) => setTimeout(r, Math.max(0, nextAt - Date.now())));
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": ua },
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("UPSTREAM");
      }
      const text = await response.text();
      if (text.length > 5_000_000) throw Error("TOO_LARGE");
      Object.assign(ids, discoverTopics(text));
      return text;
    } finally {
      nextAt = Date.now() + 3500;
    }
  }
  async function creatorLookup(topic: string): Promise<TopicPlay | null> {
    let config;
    try {
      config = JSON.parse(
        await readFile(
          join(dirname(cacheFile), "secrets", "douyin-topics.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const url = new URL(config.url);
    if (
      url.origin !== "https://creator.douyin.com" ||
      url.pathname !== "/aweme/v1/search/challengesug/"
    )
      throw Error("INVALID_SOURCE");
    url.searchParams.set("keyword", topic);
    const headers: Record<string, string> = {};
    for (const key of [
      "accept",
      "accept-language",
      "cookie",
      "user-agent",
      "referer",
      "x-secsdk-csrf-token",
    ])
      if (typeof config.headers?.[key] === "string")
        headers[key] = config.headers[key];
    await new Promise((r) => setTimeout(r, Math.max(0, nextAt - Date.now())));
    try {
      const response = await fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("UPSTREAM");
      }
      const match = parseTopicSuggestion(await response.json(), topic);
      if (match) ids[topic] = match.cid;
      return {
        topic,
        display: match ? formatTopicCount(match.view_count) : null,
        ...(match ? { view_count: match.view_count } : {}),
        url: match ? `https://www.douyin.com/hashtag/${match.cid}` : null,
        checked_at: new Date().toISOString(),
        status: match ? "ok" : "unmatched",
      };
    } finally {
      nextAt = Date.now() + 3500;
    }
  }
  function lookup(topic: string): Promise<TopicPlay> {
    const existing = pending.get(topic);
    if (existing) return existing;
    const work = queue.then(async () => {
      await ready;
      const previous = cache[topic];
      const ttl = previous?.status === "ok" ? 6 * 3600_000 : 30 * 60_000;
      if (previous && Date.now() - Date.parse(previous.checked_at) < ttl)
        return previous;
      const result: TopicPlay = {
        topic,
        display: null,
        url: null,
        checked_at: new Date().toISOString(),
        status: "unmatched",
      };
      try {
        const creator = await creatorLookup(topic);
        if (creator) Object.assign(result, creator);
        else {
          if (!ids[topic])
            await page(
              `https://www.douyin.com/search/${encodeURIComponent(topic)}`,
            );
          if (ids[topic]) {
            result.url = `https://www.douyin.com/hashtag/${ids[topic]}`;
            result.display = parseTopicPlays(await page(result.url), topic);
            result.status = result.display ? "ok" : "unavailable";
          }
        }
      } catch {
        result.status = "unavailable";
      }
      cache[topic] = result;
      const entries = Object.entries(cache);
      if (entries.length > 2000)
        cache = Object.fromEntries(entries.slice(-2000));
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(
          cacheFile + ".tmp",
          JSON.stringify({ version: 2, ids, cache }),
          {
            mode: 0o600,
          },
        );
        await rename(cacheFile + ".tmp", cacheFile);
      } catch {}
      return result;
    });
    queue = work.then(
      () => {},
      () => {},
    );
    pending.set(topic, work);
    void work.finally(() => pending.delete(topic));
    return work;
  }
  app.get("/api/v3/topic-plays", async (req, res) => {
    const topic = z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[\p{L}\p{N}_]+$/u)
      .parse(req.query.topic);
    if (pending.size >= 30 && !pending.has(topic)) {
      res.status(429).json({ error: { message: "话题查询繁忙，请稍后重试" } });
      return;
    }
    res.json(await lookup(topic));
  });
}
