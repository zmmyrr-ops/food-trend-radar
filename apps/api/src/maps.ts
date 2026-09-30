import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Express } from "express";
import { ownerOf } from "./accounts.js";
import { projectRoot } from "./config.js";
export function registerMaps(
  app: Express,
  configPath = resolve(projectRoot, "data/secrets/maps.json"),
) {
  async function config() {
    const v = JSON.parse(await readFile(configPath, "utf8"));
    if (
      typeof v.key !== "string" ||
      typeof (v.secret || v.securityJsCode) !== "string"
    )
      throw Error("地图未配置");
    return { key: v.key, secret: v.secret || v.securityJsCode };
  }
  app.get("/api/v3/maps/config", async (_req, res) => {
    try {
      const c = await config();
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ key: c.key });
    } catch {
      res.status(503).json({ error: { message: "地图未配置，请联系管理员" } });
    }
  });
  const budgets = new Map<string, { at: number; n: number }>();
  app.use("/_AMapService", async (req, res) => {
    if (req.method !== "GET") return void res.sendStatus(405);
    const path = req.path;
    if (
      !/^\/(v3\/(place\/(text|detail|around)|geocode\/(geo|regeo)|direction\/(driving|walking|bicycling))|v4\/(map\/styles|direction\/bicycling))$/.test(
        path,
      )
    ) {
      res.sendStatus(404);
      return;
    }
    const owner = ownerOf(req);
    let budget = budgets.get(owner);
    if (!budget || Date.now() - budget.at > 60000) {
      budget = { at: Date.now(), n: 0 };
      budgets.set(owner, budget);
    }
    if (++budget.n > 40) {
      res
        .status(429)
        .json({ error: { message: "地图请求过于频繁，请稍后重试" } });
      return;
    }
    if (budgets.size > 10000) budgets.clear();
    try {
      const c = await config();
      const u = new URL(
        path,
        path === "/v4/map/styles"
          ? "https://webapi.amap.com"
          : "https://restapi.amap.com",
      );
      const incoming = new URL(req.originalUrl, "https://tanhaodian.cn");
      u.search = incoming.search;
      u.searchParams.set("key", c.key);
      u.searchParams.set("jscode", c.secret);
      const response = await fetch(u, {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.text();
      if (body.length > 2_000_000) throw Error("response too large");
      res
        .status(response.status)
        .setHeader("Cache-Control", "private, max-age=60");
      res.setHeader(
        "Content-Type",
        response.headers.get("content-type") || "application/json",
      );
      res.send(body);
    } catch {
      res
        .status(502)
        .json({ error: { message: "地图服务暂不可用，请稍后重试" } });
    }
  });
}
