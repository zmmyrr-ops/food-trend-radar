import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";

// Reserved archive owner: never assigned by public registration.
export const legacyOwner = "00000000-0000-0000-0000-000000000000";
export function ownerOf(req: Request): string {
  return (
    (req as Request & { account?: { id: string } }).account?.id ?? legacyOwner
  );
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export async function createAccounts(
  db: PGlite,
  options: { testMode: boolean; secure?: boolean; adminPhone?: string },
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY,phone text UNIQUE NOT NULL,role text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS account_sessions(token_hash text PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id),expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS account_login_limits(key text PRIMARY KEY,attempts int NOT NULL,expires_at timestamptz NOT NULL);`);
  if (options.adminPhone) {
    if (!/^1[3-9]\d{9}$/.test(options.adminPhone))
      throw Error("Invalid administrator phone");
    const account = (
      await db.query<{ id: string }>(
        "INSERT INTO accounts(id,phone,role) VALUES($1,$2,'admin') ON CONFLICT(phone) DO UPDATE SET role='admin' RETURNING id",
        [randomUUID(), options.adminPhone],
      )
    ).rows[0];
    for (const table of [
      "coupon_media_jobs",
      "video_projects",
      "video_uploads",
    ]) {
      await db.query(`UPDATE ${table} SET owner_id=$1 WHERE owner_id=$2`, [
        account.id,
        legacyOwner,
      ]);
    }
  }
  const cookie = (req: Request) =>
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("radar_session="))
      ?.slice(14) ?? "";
  const clearCookie = {
    httpOnly: true,
    secure: options.secure ?? false,
    sameSite: "strict" as const,
    path: "/",
  };
  const authenticate: RequestHandler = async (req, res, next) => {
    const row = (
      await db.query<{ id: string; phone: string; role: string }>(
        "SELECT a.id,a.phone,a.role FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()",
        [digest(cookie(req))],
      )
    ).rows[0];
    if (!row) {
      res
        .status(401)
        .json({ error: { code: "LOGIN_REQUIRED", message: "请先登录" } });
      return;
    }
    Object.assign(req, { account: row });
    res.locals.account = row;
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
  function register(app: Express) {
    app.get("/api/auth/config", (_req, res) =>
      res.json({ test_mode: options.testMode }),
    );
    app.post("/api/auth/login", async (req, res) => {
      if (!options.testMode) {
        res.status(503).json({ error: { message: "短信服务尚未配置" } });
        return;
      }
      const parsed = z
        .object({
          phone: z.string().regex(/^1[3-9]\d{9}$/),
          code: z.string().length(6),
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: { message: "请输入正确的手机号和六位验证码" } });
        return;
      }
      const { phone, code } = parsed.data;
      for (const key of [`phone:${phone}`, `ip:${req.ip}`]) {
        const limit = (
          await db.query<{ attempts: number }>(
            `INSERT INTO account_login_limits(key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN account_login_limits.expires_at<now() THEN 1 ELSE account_login_limits.attempts+1 END,expires_at=CASE WHEN account_login_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE account_login_limits.expires_at END RETURNING attempts`,
            [key],
          )
        ).rows[0];
        if (limit.attempts > (key.startsWith("ip:") ? 100 : 10)) {
          res
            .status(429)
            .json({ error: { message: "尝试次数过多，请15分钟后重试" } });
          return;
        }
      }
      if (code !== "666666") {
        res.status(401).json({ error: { message: "验证码不正确" } });
        return;
      }
      const account = (
        await db.query<{ id: string; phone: string; role: string }>(
          "INSERT INTO accounts(id,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET phone=excluded.phone RETURNING id,phone,role",
          [randomUUID(), phone],
        )
      ).rows[0];
      const token = randomBytes(32).toString("hex");
      await db.query(
        "DELETE FROM account_sessions WHERE token_hash=$1 OR expires_at<now()",
        [digest(cookie(req))],
      );
      await db.query(
        "INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [digest(token), account.id],
      );
      res
        .cookie("radar_session", token, {
          ...clearCookie,
          maxAge: 7 * 86400000,
        })
        .json({ account });
    });
    app.get("/api/auth/me", authenticate, (_req, res) =>
      res.json({ account: res.locals.account }),
    );
    app.post("/api/auth/logout", async (req, res) => {
      await db.query("DELETE FROM account_sessions WHERE token_hash=$1", [
        digest(cookie(req)),
      ]);
      res.clearCookie("radar_session", clearCookie).json({ ok: true });
    });
    app.use(["/api", "/v1", "/_AMapService"], authenticate);
    app.use(["/api", "/v1"], (req, res, next) => {
      if (res.locals.account.role === "admin") return next();
      const route = req.originalUrl.split("?")[0];
      const personal =
        /^\/api\/v3\/(coupon-media|video-projects|video-assets|visit-plans|visit-stores|maps|shop-reports|brand-subscriptions|brand-blacklist)(\/|$)/.test(
          route,
        );
      const readOnly =
        ["GET", "HEAD"].includes(req.method) &&
        (route === "/v1/brands" ||
          /^\/api\/v3\/(coupon-picks(?:\.csv)?|coupons|brands|environment|sales-heat|ai-recommendations)(\/|$)/.test(
            route,
          ));
      const studioCopy =
        req.method === "POST" && route === "/api/v3/studio-copy";
      const topicPlays =
        ["GET", "HEAD"].includes(req.method) && route === "/api/v3/topic-plays";
      if (personal || readOnly || studioCopy || topicPlays) return next();
      res.status(403).json({
        error: { code: "ADMIN_REQUIRED", message: "此操作仅管理员可用" },
      });
    });
  }
  return { register };
}
