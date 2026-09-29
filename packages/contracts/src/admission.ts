import { z } from "zod";

const link = z
  .string()
  .url()
  .max(2000)
  .refine((v) => /^https?:\/\//.test(v));
const note = z.string().trim().min(1).max(2000);
export const policy = {
  version: "shanghai-l1-v1",
  region_code: "310000",
  horizon_hours: 72,
  monitoring_key: ["brand_id", "event_id", "region_code", "as_of"],
  event_types: ["新品", "联名", "优惠", "开店", "节日限定"],
  brand_target: 200,
  brand_minimum: 150,
  category_targets: {
    茶饮果饮: 45,
    咖啡: 30,
    烘焙甜品: 25,
    西式快餐: 25,
    中式快餐小吃: 20,
    火锅烧烤: 20,
    中餐及本地特色: 20,
    其他餐饮: 15,
  },
  label: {
    version: "L1-v1",
    scope: "同平台、上海、同覆盖口径",
    baseline_days: 28,
    min_valid_days: 14,
    demand_multiplier: 3,
    demand_quantile: 0.9,
    contents_min: 20,
    authors_min: 10,
    window_hours: 24,
    grid_hours: 6,
    consecutive_grids: 2,
    late_hours: 24,
    unknown_timeout_days: 7,
    unknown_is_negative: false,
  },
  features: {
    version: "eight-factors-v1",
    weights: { A: 25, B: 15, C: 15, D: 12, E: 10, F: 10, G: 5, H: 8 },
    windows_hours: [6, 12, 24],
    missing: "参考中位数加缺失掩码；不重分配权重",
    availability: "available_at <= as_of",
    daily_interpolation: false,
    reference: "仅从训练集或预先冻结参考集拟合",
  },
  saturation: {
    version: "s-v1",
    range: [0, 1],
    definition:
      "同口径内容供给百分位与已达到冻结头部阈值的独立内容占比，各占0.5；阈值仅由训练期冻结",
    missing: null,
    rule_penalty: 20,
    headstart: "100 * p72 * (1-s)",
    thresholds_status: "待真实训练样本冻结，当前不可计算",
  },
  alerts: {
    version: "alert-v1",
    rule_min: 70,
    probability_min: 0.65,
    headstart_min: 45,
    coverage_min: 0.9,
    quality_min: 0.8,
    confirmations: 2,
    interval_hours: 1,
    dedupe_hours: 24,
    daily_max: 5,
    quiet_hours: "22:00-08:00 Asia/Shanghai",
    external_enabled: false,
  },
  light_observation: {
    version: "editorial-v1",
    label: "选题观察分",
    unit: "分，非概率",
    weights: {
      official_72h_launch: 35,
      verified_public_discount: 30,
      shanghai_participation: 20,
      verified_visual_novelty: 15,
    },
    missing: "任一项未知则不评分",
    threshold: null,
    alerts_enabled: false,
    validation: "未经效果验证，仅供人工排序，不沿用70分告警",
  },
  trial: {
    days: 7,
    min_brands: 10,
    max_brands: 20,
    min_categories: 3,
    min_success: 0.95,
    min_completeness: 0.95,
    max_duplicates: 0.05,
    max_delay_minutes: 360,
    load_brands: 200,
    retry_multiplier: 1.2,
  },
  publication: {
    model_required: true,
    training_events: 1000,
    training_positive: 150,
    test_events: 200,
    test_positive: 30,
    max_ece: 0.08,
    shadow_days: 14,
  },
} as const;
export const auditInput = z
  .object({
    source_id: z.string().uuid(),
    reviewer: z.string().trim().min(1).max(80),
    account_reference: z.string().trim().min(1).max(100), // 脱敏标识，非凭据
    endpoint: link,
    evidence_url: link,
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    observed_at: z.iso.datetime({ offset: true }),
    storage_allowed: z.boolean(),
    automated_access_allowed: z.boolean(),
    metrics: z
      .array(z.enum(["demand", "contents", "authors"]))
      .min(1)
      .max(3),
    field_mapping: note,
    coverage_definition: note,
    platform: z.string().trim().min(1).max(100),
    keywords_per_brand: z.number().int().min(1).max(30),
    pages_per_keyword: z.number().int().min(1).max(100),
    runs_per_day: z.number().int().min(1).max(1440),
    monthly_budget: z.number().nonnegative(),
    note,
  })
  .strict();
export const trialInput = z
  .object({
    audit_id: z.string().uuid(),
    day: z.iso.date(),
    brand_ids: z
      .array(z.string().uuid())
      .min(10)
      .max(20)
      .refine((v) => new Set(v).size === v.length, "品牌不能重复"),
    requests: z.number().int().positive(),
    successes: z.number().int().nonnegative(),
    completeness: z.number().min(0).max(1),
    duplicate_rate: z.number().min(0).max(1),
    max_delay_minutes: z.number().nonnegative(),
    cost_yuan: z.number().nonnegative(),
    evidence_url: link,
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewer: z.string().trim().min(1).max(80),
    note,
  })
  .strict()
  .refine((v) => v.successes <= v.requests, "成功次数不能超过请求次数");
export const eventAdmissionInput = z
  .object({
    event_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reviewer: z.string().trim().min(1).max(80),
    note,
    risk: z.enum([
      "unknown",
      "none",
      "food_safety",
      "negative_sentiment",
      "false_discount",
      "out_of_stock",
    ]),
    participation: z.enum(["unknown", "available", "unavailable"]),
    stores: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            address: z.string().trim().min(1).max(300),
            region_code: z.literal("310000"),
            evidence_url: link,
          })
          .strict(),
      )
      .max(100),
    price_yuan: z.number().min(0).nullable(),
    conditions: note,
    evidence_url: link,
    valid_until: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (v) => v.participation !== "available" || v.stores.length > 0,
    "确认可参与须至少一个上海门店及证据",
  );
export const policyReviewInput = z
  .object({
    policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewer: z.string().trim().min(1).max(80),
    note,
  })
  .strict();
export type AuditInput = z.infer<typeof auditInput>;
export type TrialInput = z.infer<typeof trialInput>;
export type EventAdmissionInput = z.infer<typeof eventAdmissionInput>;
