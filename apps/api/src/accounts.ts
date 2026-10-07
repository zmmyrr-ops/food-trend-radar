import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { createWechatMini } from "./wechat-mini.js";

// Reserved archive owner: never assigned by public registration.
export const legacyOwner = "00000000-0000-0000-0000-000000000000";
export function ownerOf(req: Request): string {
  return (
    (req as Request & { account?: { id: string } }).account?.id ?? legacyOwner
  );
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const memoryKeys = new WeakMap<object, Buffer>();
async function invitationKey(db: PGlite, exportPath?: string) {
  if (!exportPath) {
    if (!memoryKeys.has(db)) memoryKeys.set(db, randomBytes(32));
    return memoryKeys.get(db)!;
  }
  const path = join(dirname(exportPath), "account-invitation-key");
  try {
    const key = await readFile(path);
    if (key.length !== 32) throw Error("Invalid invitation encryption key");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (
      (
        await db.query(
          "SELECT id FROM accounts WHERE invitation_encrypted IS NOT NULL LIMIT 1",
        )
      ).rows.length
    )
      throw Error(
        "Invitation encryption key is missing; restore it from backup",
      );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
        throw writeError;
    }
    const key = await readFile(path);
    if (key.length !== 32) throw Error("Invalid invitation encryption key");
    return key;
  }
}
function encryptInvitation(code: string, phone: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(phone));
  const encrypted = Buffer.concat([
    cipher.update(code, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decryptInvitation(value: string, phone: string, key: Buffer) {
  const bytes = Buffer.from(value, "base64"),
    decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(phone));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
async function newInvitation(db: Pick<PGlite, "query">) {
  for (let i = 0; i < 10; i++) {
    const code = String(randomInt(10000000, 100000000));
    if (
      !(
        await db.query("SELECT id FROM accounts WHERE invitation_hash=$1", [
          digest(code),
        ])
      ).rows.length
    )
      return code;
  }
  throw Error("Could not allocate a unique invitation code");
}
export async function hashAccountPassword(
  password: string,
  salt = randomBytes(16).toString("hex"),
) {
  const value = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
  return `scrypt:${salt}:${value.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string | null) {
  if (!stored || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored))
    return false;
  const derived = await hashAccountPassword(password, stored.split(":")[1]);
  return timingSafeEqual(Buffer.from(derived), Buffer.from(stored));
}
export async function createAccounts(
  db: PGlite,
  options: {
    testMode?: boolean; // Legacy option is ignored; fixed-code login is no longer supported.
    invitationExportPath?: string;
    secure?: boolean;
    adminPhone?: string;
    adminPasswordHash?: string;
    wechat?: Parameters<typeof createWechatMini>[1];
  },
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY,phone text UNIQUE NOT NULL,role text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS account_sessions(token_hash text PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id),expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS account_login_limits(key text PRIMARY KEY,attempts int NOT NULL,expires_at timestamptz NOT NULL);`);
  await db.exec(
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS invitation_hash text; ALTER TABLE accounts ADD COLUMN IF NOT EXISTS invitation_updated_at timestamptz; ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash text; ALTER TABLE accounts ADD COLUMN IF NOT EXISTS invitation_encrypted text",
  );
  const key = await invitationKey(db, options.invitationExportPath);
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
  if (options.adminPasswordHash) {
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(options.adminPasswordHash))
      throw Error("Invalid administrator password hash");
    await db.transaction(async (tx) => {
      const changed = (
        await tx.query<{ id: string }>(
          "UPDATE accounts SET password_hash=$1,invitation_hash=NULL WHERE phone=$2 AND role='admin' AND password_hash IS DISTINCT FROM $1 RETURNING id",
          [options.adminPasswordHash, options.adminPhone],
        )
      ).rows;
      for (const account of changed)
        await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [
          account.id,
        ]);
    });
  }
  // One-time migration: keep account IDs and ownership, revoke legacy phone sessions.
  if (options.invitationExportPath) {
    const path = options.invitationExportPath;
    await db.transaction(async (tx) => {
      const rows = (
        await tx.query<{ id: string; phone: string; role: string }>(
          "SELECT id,phone,role FROM accounts WHERE phone ~ '^1[3-9][0-9]{9}$' AND role<>'admin' AND invitation_encrypted IS NULL FOR UPDATE",
        )
      ).rows;
      if (!rows.length) return;
      const exported = [];
      for (const account of rows) {
        const code = await newInvitation(tx);
        await tx.query(
          "UPDATE accounts SET invitation_hash=$1,invitation_updated_at=now(),invitation_encrypted=$3 WHERE id=$2",
          [
            digest(code),
            account.id,
            encryptInvitation(code, account.phone, key),
          ],
        );
        await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [
          account.id,
        ]);
        exported.push({ ...account, invitation_code: code });
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Write before commit: a failed write must not lock the administrator out.
      await writeFile(path, JSON.stringify(exported, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    });
  }
  const mini = await createWechatMini(db, options.wechat);
  const cookie = (req: Request) =>
    req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ??
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("radar_session="))
      ?.slice(14) ??
    "";
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
    mini.register(app);
    app.get("/api/auth/config", async (req, res) => {
      const phone =
        typeof req.query.phone === "string" &&
        /^1[3-9]\d{9}$/.test(req.query.phone)
          ? req.query.phone
          : "";
      const account = phone
        ? (
            await db.query<{ role: string }>(
              "SELECT role FROM accounts WHERE phone=$1",
              [phone],
            )
          ).rows[0]
        : null;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        login_mode: account?.role === "admin" ? "password" : "invitation",
      });
    });
    app.post("/api/auth/login", async (req, res) => {
      const parsed = z
        .object({
          phone: z.string().regex(/^1[3-9]\d{9}$/),
          code: z.string().trim().min(1).max(128).optional(),
          password: z.string().min(1).max(128).optional(),
        })
        .strict()
        .refine((v) => Boolean(v.code) !== Boolean(v.password))
        .safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: { message: "请输入正确的手机号及登录凭据" } });
        return;
      }
      const { phone, code, password } = parsed.data;
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
      const candidate = (
        await db.query<{ role: string; password_hash: string | null }>(
          "SELECT role,password_hash FROM accounts WHERE phone=$1",
          [phone],
        )
      ).rows[0];
      const isAdmin = candidate?.role === "admin";
      if (
        (isAdmin &&
          (!password ||
            !(await verifyPassword(password, candidate.password_hash)))) ||
        (!isAdmin && !code)
      ) {
        res
          .status(401)
          .json({ error: { message: "手机号或登录凭据不正确，请联系管理员" } });
        return;
      }
      const token = randomBytes(32).toString("hex");
      const account = await db.transaction(async (tx) => {
        const row = (
          await tx.query<{ id: string; phone: string; role: string }>(
            "SELECT id,phone,role FROM accounts WHERE phone=$1 AND ((role='admin' AND password_hash=$2) OR (role<>'admin' AND invitation_hash=$3)) FOR UPDATE",
            [
              phone,
              isAdmin ? candidate.password_hash : null,
              isAdmin ? null : digest(code!),
            ],
          )
        ).rows[0];
        if (!row) return null;
        await tx.query(
          "DELETE FROM account_sessions WHERE token_hash=$1 OR expires_at<now()",
          [digest(cookie(req))],
        );
        await tx.query(
          "INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
          [digest(token), row.id],
        );
        return row;
      });
      if (!account) {
        res
          .status(401)
          .json({ error: { message: "手机号或登录凭据不正确，请联系管理员" } });
        return;
      }
      res
        .cookie("radar_session", token, {
          ...clearCookie,
          maxAge: 7 * 86400000,
        })
        .setHeader("Cache-Control", "no-store")
        .json({ account, token, expires_in: 604800 });
    });
    app.get("/api/auth/me", authenticate, (_req, res) =>
      res.json({ account: res.locals.account }),
    );
    app.post("/api/auth/logout", authenticate, async (req, res) => {
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
    app.get("/api/v3/accounts", async (_req, res) => {
      const items = (
        await db.query<{
          id: string;
          phone: string;
          role: string;
          invitation_encrypted: string | null;
        }>(
          "SELECT id,phone,role,created_at,invitation_updated_at,invitation_encrypted,invitation_hash IS NOT NULL AS has_invitation FROM accounts WHERE phone ~ '^1[3-9][0-9]{9}$' ORDER BY created_at DESC",
        )
      ).rows;
      res.json({
        items: items.map(({ invitation_encrypted, ...account }) => ({
          ...account,
          invitation_code:
            account.role !== "admin" && invitation_encrypted
              ? decryptInvitation(invitation_encrypted, account.phone, key)
              : null,
        })),
      });
    });
    app.post("/api/v3/accounts", async (req, res) => {
      const input = z
        .object({ phone: z.string().regex(/^1[3-9]\d{9}$/) })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        return res
          .status(400)
          .json({ error: { message: "请输入正确的手机号" } });
      const { account, code } = await db.transaction(async (tx) => {
        const code = await newInvitation(tx);
        const account = (
          await tx.query(
            "INSERT INTO accounts(id,phone,invitation_hash,invitation_updated_at,invitation_encrypted) VALUES($1,$2,$3,now(),$4) ON CONFLICT(phone) DO NOTHING RETURNING id,phone,role",
            [
              randomUUID(),
              input.data.phone,
              digest(code),
              encryptInvitation(code, input.data.phone, key),
            ],
          )
        ).rows[0];
        return { account, code };
      });
      if (!account)
        return res
          .status(409)
          .json({ error: { message: "手机号已存在，请使用重置邀请码" } });
      res.status(201).json({ account, invitation_code: code });
    });
    app.post("/api/v3/accounts/:id/invitation", async (req, res) => {
      const id = z.uuid().safeParse(req.params.id);
      if (!id.success) return res.sendStatus(404);
      const { account, code } = await db.transaction(async (tx) => {
        const code = await newInvitation(tx);
        const account = (
          await tx.query<{ id: string; phone: string; role: string }>(
            "SELECT id,phone,role FROM accounts WHERE id=$1 AND role<>'admin' AND phone ~ '^1[3-9][0-9]{9}$' FOR UPDATE",
            [id.data],
          )
        ).rows[0];
        if (account) {
          await tx.query(
            "UPDATE accounts SET invitation_hash=$1,invitation_updated_at=now(),invitation_encrypted=$3 WHERE id=$2",
            [
              digest(code),
              id.data,
              encryptInvitation(code, account.phone, key),
            ],
          );
          await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [
            id.data,
          ]);
        }
        return { account, code };
      });
      if (!account) return res.sendStatus(404);
      res.json({ account, invitation_code: code });
    });
  }
  return { register, tick: mini.tick, drain: mini.drain };
}
