import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { projectRoot } from "./config.js";

export const MINI_APP_ID = "wxdcd4067f8d413b31";
export const MINI_TEMPLATE_ID = "ceAsC4n9rxFS_02B1pPJalXqPOQjorHgpmM-26NG9J8";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const short = (s: string) => Array.from(s).slice(0, 20).join("");
export function miniTemplate(m: {
  brand_name: string;
  title: string;
  kind: string;
  created_at: string | Date;
}) {
  const date = new Date(
    new Date(m.created_at).getTime() + 8 * 3600000,
  ).toISOString();
  return {
    thing1: {
      value: short(
        `${m.brand_name} ${m.kind === "new" ? "新上券" : "热度飙升"}`,
      ),
    },
    thing2: { value: "上海" },
    thing3: { value: short(m.title || "发现可带货优惠券，点击查看") },
    time4: { value: date.slice(0, 10) + " " + date.slice(11, 16) },
  };
}
export async function createWechatMini(
  db: PGlite,
  options: {
    secret?: () => Promise<string>;
    transport?: (url: string, body?: unknown) => Promise<any>;
  } = {},
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS wechat_identities(openid text PRIMARY KEY,owner_id uuid UNIQUE NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS wechat_grants(owner_id uuid PRIMARY KEY REFERENCES accounts(id),available boolean NOT NULL DEFAULT false,granted_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS wechat_deliveries(message_id uuid PRIMARY KEY,owner_id uuid NOT NULL,state text NOT NULL,code text,created_at timestamptz NOT NULL DEFAULT now());`);
  async function secret() {
    if (options.secret) return options.secret();
    if (process.env.WECHAT_MINI_APP_SECRET)
      return process.env.WECHAT_MINI_APP_SECRET;
    try {
      return String(
        JSON.parse(
          await readFile(
            resolve(projectRoot, "data/secrets/wechat-mini.json"),
            "utf8",
          ),
        ).appSecret || "",
      );
    } catch {
      return "";
    }
  }
  async function transport(url: string, body?: unknown) {
    if (options.transport) return options.transport(url, body);
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!r.ok) throw Error("WECHAT_UPSTREAM_FAILED");
    return r.json();
  }
  function register(app: Express) {
    app.post("/api/mini/login", async (req, res) => {
      const code = z.string().min(1).max(256).parse(req.body.code);
      const appSecret = await secret();
      if (!appSecret)
        return res
          .status(503)
          .json({ error: { message: "微信登录尚未配置，请联系管理员" } });
      const limit = (
        await db.query<{ attempts: number }>(
          `INSERT INTO account_login_limits(key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN account_login_limits.expires_at<now() THEN 1 ELSE account_login_limits.attempts+1 END,expires_at=CASE WHEN account_login_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE account_login_limits.expires_at END RETURNING attempts`,
          [`mini-ip:${req.ip}`],
        )
      ).rows[0];
      if (limit.attempts > 100)
        return res
          .status(429)
          .json({ error: { message: "登录频繁，请稍后重试" } });
      let data: any;
      try {
        data = await transport(
          `https://api.weixin.qq.com/sns/jscode2session?${new URLSearchParams({ appid: MINI_APP_ID, secret: appSecret, js_code: code, grant_type: "authorization_code" })}`,
        );
      } catch {
        return res
          .status(502)
          .json({ error: { message: "微信登录暂时不可用，请重试" } });
      }
      if (data.errcode || typeof data.openid !== "string" || !data.openid)
        return res
          .status(401)
          .json({ error: { message: "微信登录已失效，请重试" } });
      const token = randomBytes(32).toString("hex");
      await db.transaction(async (tx) => {
        const owner = (
          await tx.query<{ id: string }>(
            "INSERT INTO accounts(id,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET phone=excluded.phone RETURNING id",
            [randomUUID(), `wx:${data.openid}`],
          )
        ).rows[0].id;
        await tx.query(
          "INSERT INTO wechat_identities(openid,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [data.openid, owner],
        );
        await tx.query(
          "DELETE FROM account_sessions WHERE account_id=$1 AND expires_at<now()",
          [owner],
        );
        await tx.query(
          "INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
          [hash(token), owner],
        );
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ token, expires_in: 604800, template_id: MINI_TEMPLATE_ID });
    });
    // Only this explicit mini-program surface may bypass the website Basic Auth.
    app.use(async (req, res, next) => {
      if (!req.path.startsWith("/api/mini/")) return next();
      const route = req.path.slice("/api/mini".length);
      const allowed =
        (req.method === "GET" &&
          /^\/(coupon-picks|coupons\/\d+\/(rules|stores)|brand-subscriptions(?:\/(search|messages))?|brand-blacklist(?:\/search)?|notification-status)$/.test(
            route,
          )) ||
        (req.method === "POST" &&
          /^\/(brand-subscriptions(?:\/read)?|brand-blacklist|notification-consent|logout)$/.test(
            route,
          ));
      if (!allowed)
        return res.status(404).json({ error: { message: "接口不存在" } });
      const token = req.headers.authorization?.match(
        /^Bearer ([a-f0-9]{64})$/,
      )?.[1];
      const user =
        token &&
        (
          await db.query<{ owner_id: string }>(
            "SELECT w.owner_id FROM account_sessions s JOIN wechat_identities w ON w.owner_id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()",
            [hash(token)],
          )
        ).rows[0];
      if (!user)
        return res.status(401).json({ error: { message: "请重新微信登录" } });
      res.setHeader("Cache-Control", "private, no-store");
      if (route === "/logout") {
        await db.query("DELETE FROM account_sessions WHERE token_hash=$1", [
          hash(token!),
        ]);
        return res.json({ ok: true });
      }
      if (route === "/notification-consent") {
        const accepted = z.boolean().parse(req.body.accepted);
        // Client acceptance is advisory; WeChat is the authority on actual quota.
        await db.query(
          "INSERT INTO wechat_grants(owner_id,available) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET available=$2,granted_at=now()",
          [user.owner_id, accepted],
        );
        return res.json({ ok: true });
      }
      if (route === "/notification-status") {
        const grant =
          (
            await db.query(
              "SELECT available,granted_at FROM wechat_grants WHERE owner_id=$1",
              [user.owner_id],
            )
          ).rows[0] || null;
        const last =
          (
            await db.query(
              "SELECT state,code,created_at FROM wechat_deliveries WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 1",
              [user.owner_id],
            )
          ).rows[0] || null;
        return res.json({ grant, last, template_id: MINI_TEMPLATE_ID });
      }
      // Reuse account-scoped brand APIs and the shared pool, never expose sales counts.
      if (route === "/coupon-picks") {
        const send = res.json.bind(res);
        res.json = (body: any) =>
          send(
            body?.items
              ? {
                  total: body.total,
                  counts: body.counts,
                  items: body.items.map((p: any) => ({
                    brand_id: p.brand_id,
                    product_id: p.product_id,
                    brand_name: p.brand_name,
                    title: p.title,
                    price_fen: p.price_fen,
                    origin_price_fen: p.origin_price_fen,
                    is_new: p.is_new,
                    priority_score: p.priority?.score ?? 0,
                    heat_index:
                      p.priority?.parts?.find((x: any) => x.name === "销量升温")
                        ?.value == null
                        ? null
                        : Math.round(
                            Math.max(
                              0,
                              Math.min(
                                100,
                                ((p.priority?.parts?.find(
                                  (x: any) => x.name === "销量升温",
                                )?.value ?? 0) /
                                  30) *
                                  100,
                              ),
                            ),
                          ),
                    discount: p.discount?.rate ?? null,
                  })),
                }
              : body,
          );
      }
      if (/^\/coupons\/\d+\/(rules|stores)$/.test(route)) {
        const send = res.json.bind(res);
        res.json = (body: any) =>
          send(
            body?.error
              ? body
              : route.endsWith("/rules")
                ? { rules: body.items?.[0]?.payload?.rules ?? [] }
                : {
                    source_shop: body.source_shop
                      ? {
                          name: body.source_shop.name,
                          address: body.source_shop.address,
                        }
                      : null,
                  },
          );
      }
      req.headers.cookie = `radar_session=${token}`;
      const mapped = `/api/v3${req.url.slice("/api/mini".length)}`;
      // Only validated mini routes are mapped to the shared account-scoped APIs.
      req.url = mapped;
      req.originalUrl = mapped;
      next();
    });
  }

  let cached: { value: string; until: number } | undefined;
  let running: Promise<void> | undefined;
  async function sendMessages() {
    const appSecret = await secret();
    if (!appSecret) return;
    if (
      !(
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('subscription_messages') IS NOT NULL AS present",
        )
      ).rows[0].present
    )
      return;
    const rows = (
      await db.query<any>(
        `SELECT DISTINCT ON (m.owner_id) m.*,w.openid FROM subscription_messages m JOIN wechat_identities w ON w.owner_id=m.owner_id JOIN wechat_grants g ON g.owner_id=m.owner_id AND g.available JOIN brand_subscriptions s ON s.owner_id=m.owner_id AND s.brand_id=m.brand_id WHERE m.created_at>=g.granted_at AND m.created_at>now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM wechat_deliveries d WHERE d.message_id=m.id) ORDER BY m.owner_id,m.created_at DESC LIMIT 5`,
      )
    ).rows;
    if (!rows.length) return;
    if (!cached || cached.until < Date.now()) {
      const t = await transport(
        "https://api.weixin.qq.com/cgi-bin/stable_token",
        {
          grant_type: "client_credential",
          appid: MINI_APP_ID,
          secret: appSecret,
        },
      );
      if (!t.access_token) return;
      cached = {
        value: t.access_token,
        until: Date.now() + Math.max(60, Number(t.expires_in) - 120) * 1000,
      };
    }
    for (const m of rows) {
      const claimed = await db.transaction(async (tx) => {
        const g = await tx.query(
          "UPDATE wechat_grants SET available=false WHERE owner_id=$1 AND available RETURNING owner_id",
          [m.owner_id],
        );
        if (!g.rows.length) return false;
        await tx.query(
          "INSERT INTO wechat_deliveries(message_id,owner_id,state) VALUES($1,$2,'sending')",
          [m.id, m.owner_id],
        );
        return true;
      });
      if (!claimed) continue;
      try {
        const result = await transport(
          `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${cached.value}`,
          {
            touser: m.openid,
            template_id: MINI_TEMPLATE_ID,
            page: `pages/coupons/index?brand_id=${m.brand_id}`,
            miniprogram_state: process.env.WECHAT_MINI_STATE || "formal",
            lang: "zh_CN",
            data: miniTemplate(m),
          },
        );
        await db.query(
          "UPDATE wechat_deliveries SET state=$2,code=$3 WHERE message_id=$1",
          [
            m.id,
            result.errcode === 0 ? "sent" : "failed",
            String(result.errcode ?? "INVALID_RESPONSE"),
          ],
        );
        if ([40001, 42001].includes(result.errcode)) cached = undefined;
      } catch {
        // An ambiguous timeout must not cause duplicate notifications or consume more quota.
        await db.query(
          "UPDATE wechat_deliveries SET state='unknown',code='NETWORK_RESULT_UNKNOWN' WHERE message_id=$1",
          [m.id],
        );
      }
      if (!cached) break;
    }
  }
  return {
    register,
    tick: () => {
      if (!running)
        running = sendMessages().finally(() => {
          running = undefined;
        });
      return running;
    },
    drain: async () => {
      await running;
    },
  };
}
