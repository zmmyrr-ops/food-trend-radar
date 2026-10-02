import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Express } from "express";
import { z } from "zod";
import seeds from "./topic-ids.json" with { type: "json" };
export type TopicPlay = {
  topic: string;
  display: string | null;
  url: string | null;
  checked_at: string;
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
export function registerTopicPlays(app: Express, cacheFile: string) {
  let ids: Record<string, string> = { ...seeds };
  let cache: Record<string, TopicPlay> = {};
  const ready = readFile(cacheFile, "utf8")
    .then((s) => {
      const data = JSON.parse(s);
      ids = { ...ids, ...data.ids };
      cache = data.cache || {};
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
        if (!ids[topic])
          await page(
            `https://www.douyin.com/search/${encodeURIComponent(topic)}`,
          );
        if (ids[topic]) {
          result.url = `https://www.douyin.com/hashtag/${ids[topic]}`;
          result.display = parseTopicPlays(await page(result.url), topic);
          result.status = result.display ? "ok" : "unavailable";
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
        await writeFile(cacheFile + ".tmp", JSON.stringify({ ids, cache }), {
          mode: 0o600,
        });
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
