import { randomInt, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { hashAccountPassword, ownerOf, verifyPassword } from "./accounts.js";
import { changePoints } from "./points.js";
import type { SmsAuth } from "./sms-auth.js";

const referralSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);
export function generateReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const code = Array.from(
      { length: 6 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    if (/[A-Z]/.test(code) && /[2-9]/.test(code)) return code;
  }
}
const phoneSchema = z.string().regex(/^1[3-9]\d{9}$/);
const passwordSchema = z
  .string()
  .min(8)
  .max(72)
  .refine((v) => !/^\s|\s$/.test(v), "密码首尾不能有空格");
export async function createMembership(db: PGlite, sms: SmsAuth) {
  await db.exec(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referral_code text;
 ALTER TABLE accounts ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES accounts(id);
 ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
 CREATE UNIQUE INDEX IF NOT EXISTS account_referral_unique ON accounts(referral_code) WHERE referral_code IS NOT NULL;
 CREATE TABLE IF NOT EXISTS referral_code_allocator(id int PRIMARY KEY CHECK(id=1));
 INSERT INTO referral_code_allocator VALUES(1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS sms_limits(phone text PRIMARY KEY,day text NOT NULL,count int NOT NULL,last_sent_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS sms_challenges(phone text PRIMARY KEY,id uuid NOT NULL,state text NOT NULL,attempts int NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS sms_ip_limits(key text PRIMARY KEY,count int NOT NULL);
 `);
  const checking = new Set<string>();
  function publicRoutes(app: Express) {
    app.post("/api/auth/sms", async (req, res) => {
      const v = z
        .object({
          phone: phoneSchema,
          invitation_code: referralSchema,
        })
        .strict()
        .safeParse(req.body);
      if (!v.success)
        return res
          .status(400)
          .json({ error: { message: "请填写手机号及6位邀请码" } });
      const { phone, invitation_code } = v.data;
      // Unknown invite attempts and send attempts share an IP budget.
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const ip = (
        await db.query<{ count: number }>(
          "INSERT INTO sms_ip_limits(key,count) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET count=sms_ip_limits.count+1 RETURNING count",
          [`${day}:${req.ip}`],
        )
      ).rows[0];
      if (ip.count > 30)
        return res
          .status(429)
          .json({ error: { message: "请求过于频繁，请明天再试" } });
      if (
        !(
          await db.query("SELECT id FROM accounts WHERE referral_code=$1", [
            invitation_code,
          ])
        ).rows.length
      )
        return res
          .status(400)
          .json({ error: { message: "邀请码无效，请向邀请人确认" } });
      if (
        (await db.query("SELECT id FROM accounts WHERE phone=$1", [phone])).rows
          .length
      )
        return res
          .status(409)
          .json({ error: { message: "该手机号已注册，请直接登录" } });
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO sms_limits(phone,day,count,last_sent_at) VALUES($1,$2,0,'1970-01-01') ON CONFLICT DO NOTHING",
            [phone, day],
          );
          const s = (
            await tx.query<{
              day: string;
              count: number;
              last_sent_at: string;
            }>("SELECT * FROM sms_limits WHERE phone=$1 FOR UPDATE", [phone])
          ).rows[0];
          if (Date.now() - new Date(s.last_sent_at).getTime() < 60000)
            throw Error("请间隔1分钟再获取验证码");
          if (s.day === day && s.count >= 5)
            throw Error("该手机号今天已获取5次，请明天再试");
          await tx.query(
            "UPDATE sms_limits SET day=$2,count=$3,last_sent_at=now() WHERE phone=$1",
            [phone, day, s.day === day ? s.count + 1 : 1],
          );
          await tx.query(
            "INSERT INTO sms_challenges(phone,id,state,expires_at) VALUES($1,$2,'sending',now()+interval '5 minutes') ON CONFLICT(phone) DO UPDATE SET id=excluded.id,state='sending',attempts=0,expires_at=excluded.expires_at",
            [phone, id],
          );
        });
      } catch (e) {
        return res
          .status(429)
          .json({ error: { message: (e as Error).message } });
      }
      try {
        await sms.send(phone);
        await db.query(
          "UPDATE sms_challenges SET state='sent',expires_at=now()+interval '5 minutes' WHERE phone=$1 AND id=$2",
          [phone, id],
        );
        res.json({ ok: true, retry_after: 60 });
      } catch (e) {
        await db.query(
          "UPDATE sms_challenges SET state='failed' WHERE phone=$1 AND id=$2",
          [phone, id],
        );
        res.status(503).json({ error: { message: (e as Error).message } });
      }
    });
    app.post("/api/auth/register", async (req, res) => {
      const v = z
        .object({
          phone: phoneSchema,
          code: z.string().regex(/^\d{6}$/),
          invitation_code: referralSchema,
          password: passwordSchema,
        })
        .strict()
        .safeParse(req.body);
      if (!v.success)
        return res
          .status(400)
          .json({ error: { message: "请填写完整信息，密码须为8–72位" } });
      const { phone, code, password, invitation_code } = v.data;
      if (checking.has(phone))
        return res.status(429).json({ error: { message: "正在核验，请稍候" } });
      checking.add(phone);
      try {
        const invite = (
          await db.query<{ id: string; phone: string }>(
            "SELECT id,phone FROM accounts WHERE referral_code=$1",
            [invitation_code],
          )
        ).rows[0];
        if (!invite || invite.phone === phone) throw Error("邀请码无效");
        if (
          (await db.query("SELECT id FROM accounts WHERE phone=$1", [phone]))
            .rows.length
        )
          throw Error("该手机号已注册，请直接登录");
        const challenge = (
          await db.query<{ id: string }>(
            "UPDATE sms_challenges SET attempts=attempts+1 WHERE phone=$1 AND state='sent' AND expires_at>now() AND attempts<5 RETURNING id",
            [phone],
          )
        ).rows[0];
        if (!challenge) throw Error("验证码已失效或尝试过多，请重新获取");
        if (!(await sms.check(phone, code)))
          throw Error("验证码不正确或已失效");
        const passwordHash = await hashAccountPassword(password);
        const id = randomUUID();
        await db.transaction(async (tx) => {
          const consumed = await tx.query(
            "UPDATE sms_challenges SET state='used' WHERE phone=$1 AND id=$2 AND state='sent' AND expires_at>now() RETURNING id",
            [phone, challenge.id],
          );
          if (!consumed.rows.length)
            throw Error("验证码已使用或已失效，请重新获取");
          const inserted = await tx.query(
            "INSERT INTO accounts(id,phone,password_hash,invited_by,phone_verified_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(phone) DO NOTHING RETURNING id",
            [id, phone, passwordHash, invite.id],
          );
          if (!inserted.rows.length) throw Error("该手机号已注册，请直接登录");
          await changePoints(tx, id, 100, "新用户注册赠送", `welcome:${id}`);
          await changePoints(
            tx,
            invite.id,
            100,
            "成功邀请新用户",
            `referral:${id}`,
          );
        });
        res
          .status(201)
          .json({ ok: true, message: "注册成功，已赠送100积分，请登录" });
      } catch (e) {
        res.status(400).json({ error: { message: (e as Error).message } });
      } finally {
        checking.delete(phone);
      }
    });
  }
  function privateRoutes(app: Express, auth: RequestHandler) {
    app.get("/api/member", auth, async (req, res) => {
      const id = ownerOf(req);
      const a = (
        await db.query<any>(
          "SELECT a.phone,a.referral_code,coalesce(w.balance,0) AS balance FROM accounts a LEFT JOIN point_wallets w ON w.owner_id=a.id WHERE a.id=$1",
          [id],
        )
      ).rows[0];
      const invited = (
        await db.query(
          "SELECT phone,created_at FROM accounts WHERE invited_by=$1 ORDER BY created_at DESC",
          [id],
        )
      ).rows;
      res.json({ ...a, invited });
    });
    app.get("/api/member/points", auth, async (req, res) => {
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(req.query.offset ?? 0);
      const id = ownerOf(req);
      const items = (
        await db.query(
          "SELECT id,amount,reason,created_at FROM point_entries WHERE owner_id=$1 AND NOT hidden ORDER BY created_at DESC,id LIMIT 30 OFFSET $2",
          [id, offset],
        )
      ).rows;
      const total = (
        await db.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM point_entries WHERE owner_id=$1 AND NOT hidden",
          [id],
        )
      ).rows[0].total;
      res.json({ items, total });
    });
    app.post("/api/member/invitation", auth, async (req, res) => {
      const id = ownerOf(req);
      const code = await db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM referral_code_allocator WHERE id=1 FOR UPDATE",
        );
        const a = (
          await tx.query<{ referral_code: string | null }>(
            "SELECT referral_code FROM accounts WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (a.referral_code) return a.referral_code;
        for (let n = 0; n < 30; n++) {
          const candidate = generateReferralCode();
          if (
            (
              await tx.query("SELECT id FROM accounts WHERE referral_code=$1", [
                candidate,
              ])
            ).rows.length
          )
            continue;
          await tx.query("UPDATE accounts SET referral_code=$2 WHERE id=$1", [
            id,
            candidate,
          ]);
          return candidate;
        }
        throw Error("邀请码生成繁忙，请稍后重试");
      });
      res.json({ code });
    });
    app.post("/api/member/password", auth, async (req, res) => {
      const v = z
        .object({
          old_password: z.string().min(1).max(128),
          password: passwordSchema,
        })
        .strict()
        .safeParse(req.body);
      if (!v.success)
        return res.status(400).json({ error: { message: "新密码须为8–72位" } });
      const id = ownerOf(req);
      const a = (
        await db.query<{ password_hash: string }>(
          "SELECT password_hash FROM accounts WHERE id=$1",
          [id],
        )
      ).rows[0];
      const limit = (
        await db.query<{ attempts: number }>(
          "INSERT INTO account_login_limits(key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN account_login_limits.expires_at<now() THEN 1 ELSE account_login_limits.attempts+1 END,expires_at=CASE WHEN account_login_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE account_login_limits.expires_at END RETURNING attempts",
          [`password:${id}`],
        )
      ).rows[0];
      if (limit.attempts > 10)
        return res
          .status(429)
          .json({ error: { message: "尝试过多，请15分钟后再试" } });
      if (!(await verifyPassword(v.data.old_password, a.password_hash)))
        return res.status(400).json({ error: { message: "原密码不正确" } });
      const next = await hashAccountPassword(v.data.password);
      const changed = await db.transaction(async (tx) => {
        const r = await tx.query(
          "UPDATE accounts SET password_hash=$2,invitation_hash=NULL,invitation_encrypted=NULL WHERE id=$1 AND password_hash=$3 RETURNING id",
          [id, next, a.password_hash],
        );
        if (r.rows.length)
          await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [
            id,
          ]);
        return r.rows.length;
      });
      if (!changed)
        return res
          .status(409)
          .json({ error: { message: "密码已发生变化，请重新登录" } });
      res.json({ ok: true, relogin: true });
    });
    app.get("/api/admin/members", auth, async (req, res) => {
      if (res.locals.account.role !== "admin")
        return res.status(403).json({ error: { message: "仅管理员可用" } });
      const items = (
        await db.query(
          `SELECT a.id,a.phone,a.role,a.referral_code,a.created_at,p.phone AS inviter_phone,coalesce(w.balance,0) AS balance,(SELECT count(*)::int FROM accounts c WHERE c.invited_by=a.id) AS invited_count FROM accounts a LEFT JOIN accounts p ON p.id=a.invited_by LEFT JOIN point_wallets w ON w.owner_id=a.id ORDER BY a.created_at DESC`,
        )
      ).rows;
      res.json({ items });
    });
    app.get("/api/admin/members/:id/points", auth, async (req, res) => {
      if (res.locals.account.role !== "admin")
        return res.status(403).json({ error: { message: "仅管理员可用" } });
      const id = z.uuid().parse(req.params.id);
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.query.offset ?? 0);
      res.json({
        items: (
          await db.query(
            "SELECT id,amount,reason,hidden,created_at FROM point_entries WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 30 OFFSET $2",
            [id, offset],
          )
        ).rows,
      });
    });
    app.post("/api/admin/members/:id/points", auth, async (req, res) => {
      if (res.locals.account.role !== "admin")
        return res.status(403).json({ error: { message: "仅管理员可用" } });
      const id = z.uuid().parse(req.params.id);
      const v = z
        .object({
          amount: z.number().int().min(1).max(1000000),
          request_id: z.uuid(),
          note: z.string().trim().max(200).default("管理员赠送"),
        })
        .strict()
        .parse(req.body);
      if (
        !(await db.query("SELECT id FROM accounts WHERE id=$1", [id])).rows
          .length
      )
        return res.sendStatus(404);
      await db.transaction((tx) =>
        changePoints(
          tx,
          id,
          v.amount,
          `${v.note}（操作人 ${ownerOf(req)}）`,
          `admin:${ownerOf(req)}:${id}:${v.request_id}`,
          true,
        ),
      );
      res.json({ ok: true });
    });
  }
  return { publicRoutes, privateRoutes };
}
