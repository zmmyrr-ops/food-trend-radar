import { z } from "zod";
export const leisureCategories = [
  "亲子乐园",
  "主题乐园",
  "动物海洋馆",
  "展馆观光",
  "户外景区",
  "运动玩乐",
] as const;
export const categories = [
  "茶饮果饮",
  "咖啡",
  "烘焙甜品",
  "西式快餐",
  "中式快餐小吃",
  "火锅烧烤",
  "中餐及本地特色",
  "其他餐饮",
  ...leisureCategories,
] as const;
export type Channel = "food" | "leisure";
export function inChannel(
  category: string | undefined,
  channel?: Channel | "all",
) {
  if (!channel || channel === "all") return true;
  const leisure = (leisureCategories as readonly string[]).includes(
    category ?? "",
  );
  return channel === "leisure" ? leisure : !leisure;
}
const url = z
  .string()
  .url()
  .max(2000)
  .refine((v) => /^https?:\/\//.test(v), "仅支持HTTP或HTTPS证据链接");
export const brandInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    category: z.enum(categories),
    aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    shanghai_evidence_url: url,
    active: z.boolean().default(true),
    keywords: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  })
  .strict();
export const eventInput = z
  .object({
    brand_id: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    type: z.enum(["新品", "联名", "优惠", "开店", "节日限定"]),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    source_url: url,
    source_id: z.string().uuid().nullable().default(null),
    evidence_note: z.string().trim().min(1).max(2000),
    effective_price: z
      .number()
      .min(0)
      .max(100000)
      .multipleOf(0.01)
      .nullable()
      .default(null),
    original_price: z
      .number()
      .min(0)
      .max(100000)
      .multipleOf(0.01)
      .nullable()
      .default(null),
    promotion_terms: z.string().trim().max(2000).default(""),
    collaboration: z.string().trim().max(200).default(""),
    store_scope: z
      .enum(["unknown", "all_shanghai", "selected"])
      .default("unknown"),
    applicable_stores: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    eligibility: z
      .enum(["unknown", "available", "unavailable"])
      .default("unknown"),
    status: z.enum(["pending", "verified", "cancelled"]).default("pending"),
  })
  .strict()
  .refine((v) => Date.parse(v.ends_at) > Date.parse(v.starts_at), {
    message: "结束时间必须晚于开始时间",
    path: ["ends_at"],
  })
  .superRefine((v, ctx) => {
    if (v.store_scope === "selected" && !v.applicable_stores.length)
      ctx.addIssue({
        code: "custom",
        path: ["applicable_stores"],
        message: "指定门店须至少填写一家上海门店",
      });
    if (v.store_scope !== "selected" && v.applicable_stores.length)
      ctx.addIssue({
        code: "custom",
        path: ["store_scope"],
        message: "填写门店清单时须选择指定门店",
      });
    const keys = v.applicable_stores.map((s) =>
      s.normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        path: ["applicable_stores"],
        message: "适用门店清单包含重复名称",
      });
  });
export type BrandInput = z.infer<typeof brandInput>;
export type EventInput = z.infer<typeof eventInput>;
export const brandReviewInput = z
  .object({
    revision: z.number().int().positive(),
    decision: z.enum(["verified", "rejected"]),
    reviewer: z.string().trim().min(1).max(80),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type Brand = BrandInput & {
  icon_url?: string | null;
  revision: number;
  review_status: "pending" | "verified" | "rejected";
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  id: string;
  region_code: "310000";
  created_at: string;
};
export type FoodEvent = EventInput & {
  id: string;
  brand_name: string;
  region_code: "310000";
  created_at: string;
};
export type ImportResult = {
  id: string;
  created: number;
  duplicates: number;
  errors: { row: number; message: string }[];
};

export const sourceInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    url,
    owner: z.string().trim().min(1).max(100),
    purpose: z.string().trim().min(1).max(1000),
    coverage: z.enum(["full", "authorized_sample", "manual_sample"]),
    geography: z.enum(["shanghai", "national"]),
    granularity: z.enum(["hour", "day", "event"]),
    delay_minutes: z.number().int().nonnegative().nullable(),
    daily_quota: z.number().int().nonnegative().nullable(),
    monthly_cost: z.number().nonnegative().nullable(),
    retention_days: z.number().int().min(1).max(3650),
    display_allowed: z.boolean(),
    training_allowed: z.boolean(),
    authorization: z.enum(["pending", "approved", "revoked"]),
    authorization_url: url.nullable(),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
    verification_note: z.string().trim().max(2000),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.authorization === "approved" &&
      (!v.authorization_url || !v.expires_at || !v.verification_note)
    )
      ctx.addIssue({
        code: "custom",
        message: "确认授权须填写凭证链接、有效期和核验记录",
        path: ["authorization"],
      });
  });
export type SourceInput = z.infer<typeof sourceInput>;
export type DataSource = SourceInput & {
  id: string;
  created_at: string;
  gate: { eligible: boolean; reasons: string[] };
};
export function sourceGate(v: SourceInput, now = Date.now()) {
  const reasons: string[] = [];
  if (!v.enabled) reasons.push("已停用");
  if (v.authorization !== "approved") reasons.push("授权未确认或已撤销");
  if (!v.expires_at || Date.parse(v.expires_at) <= now)
    reasons.push("授权期限未知或已过期");
  if (!v.display_allowed) reasons.push("未获展示许可");
  return { eligible: reasons.length === 0, reasons };
}

export type ImportPreview = {
  valid: number;
  duplicates: number;
  errors: ImportResult["errors"];
};

export * from "./admission.js";

export const researchEvidenceInput = z
  .object({
    source_title: z.string().trim().min(1).max(200),
    url,
    source_name: z.string().trim().min(1).max(150),
    location: z.string().trim().min(1).max(500),
    position: z.string().max(200),
    evidence_type: z.enum([
      "current_directory",
      "historical_notice",
      "historical_guide",
    ]),
    published_at: z.iso.date().nullable(),
    observed_at: z.iso.datetime({ offset: true }),
    research_status: z.enum([
      "directory_checked",
      "historical_evidence_only",
      "conflicting_directory",
    ]),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ResearchEvidence = z.infer<typeof researchEvidenceInput>;
