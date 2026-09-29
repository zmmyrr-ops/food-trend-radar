import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type AuditInput,
  auditInput,
  type Brand,
  type EventAdmissionInput,
  eventAdmissionInput,
  policy,
  policyReviewInput,
  type SourceInput,
  sourceGate,
  type TrialInput,
  trialInput,
} from "@radar/contracts";
import type { Express } from "express";
import { z } from "zod";
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object" && !(v instanceof Date)
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
const policyHash = fingerprint(policy);
const dayOf = (ms: number) =>
  new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
function invalid(message: string): never {
  throw new z.ZodError([{ code: "custom", path: [], message }]);
}
type Audit = {
  id: string;
  source_id: string;
  source_hash: string;
  config: AuditInput;
  created_at: Date;
};
type Trial = { config: TrialInput };
export function evaluateSource(
  source: SourceInput,
  audit: Audit | undefined,
  trials: Trial[],
  now = Date.now(),
) {
  const reasons = [...sourceGate(source, now).reasons];
  let calls: number | null = null,
    projectedCost: number | null = null;
  const days = Array.from({ length: 7 }, (_, i) =>
    dayOf(now - (i + 1) * 86400000),
  );
  if (!audit) reasons.push("未登记账户实测证据");
  else {
    const a = audit.config;
    if (audit.source_hash !== fingerprint(source))
      reasons.push("来源配置已变更，须重新实测");
    if (
      !a.storage_allowed ||
      !a.automated_access_allowed ||
      !source.training_allowed
    )
      reasons.push("缺少自动采集、存储或训练许可");
    if (
      source.geography !== "shanghai" ||
      source.coverage !== "full" ||
      source.granularity !== "hour"
    )
      reasons.push("L1-v1仅支持上海全量小时口径；样本及日级须另行验证版本");
    if (
      !["demand", "contents", "authors"].every((m) =>
        a.metrics.includes(m as "demand"),
      )
    )
      reasons.push("同口径需求、内容或作者字段未齐备");
    if (a.runs_per_day < 24) reasons.push("小时监测计划每日轮次不足24次");
    calls = Math.ceil(
      200 *
        a.keywords_per_brand *
        a.pages_per_keyword *
        a.runs_per_day *
        policy.trial.retry_multiplier,
    );
    if (source.daily_quota === null || source.daily_quota < calls)
      reasons.push("200品牌预估调用量超过已确认配额或配额未知");
    if (source.delay_minutes === null || source.delay_minutes > 360)
      reasons.push("延迟未知或超过6小时");
    if (source.monthly_cost === null) reasons.push("月成本未知");
    const recent = days.map(
      (day) => trials.find((t) => t.config.day === day)?.config,
    );
    if (recent.some((t) => !t)) reasons.push("最近7个完整上海自然日记录不齐");
    const available = recent.filter((t): t is TrialInput => !!t);
    if (
      available.some(
        (t) =>
          t.requests <
            t.brand_ids.length *
              a.keywords_per_brand *
              a.pages_per_keyword *
              a.runs_per_day ||
          t.successes / t.requests < 0.95 ||
          t.completeness < 0.95 ||
          t.duplicate_rate > 0.05 ||
          t.max_delay_minutes > 360,
      )
    )
      reasons.push("7日成功率、完整率、重复率或延迟不达标");
    if (
      available.length &&
      available.some(
        (t) =>
          [...t.brand_ids].sort().join() !==
          [...available[0].brand_ids].sort().join(),
      )
    )
      reasons.push("试点品牌集合发生变化，须重新连续验证");
    if (available.length === 7) {
      projectedCost =
        (available.reduce(
          (sum, t) => sum + (t.cost_yuan * 200) / t.brand_ids.length,
          0,
        ) /
          7) *
          30 *
          1.2 +
        (source.monthly_cost ?? 0);
      if (projectedCost > a.monthly_budget)
        reasons.push("200品牌预估月成本超过预算");
    }
  }
  return {
    passed: reasons.length === 0,
    reasons,
    projected_daily_calls: calls,
    projected_monthly_cost: projectedCost,
    required_days: days,
  };
}
export function registerAdmission(app: Express, db: PGlite) {
  app.get("/v1/admission", async (_req, res) => {
    const [sources, audits, trials, brands, reviews] = await Promise.all([
      db.query<{ id: string; config: SourceInput }>(
        "SELECT * FROM data_sources ORDER BY created_at DESC,id",
      ),
      db.query<Audit>(
        "SELECT * FROM source_audits ORDER BY created_at DESC,id",
      ),
      db.query<Trial & { audit_id: string }>("SELECT * FROM source_trials"),
      db.query<Brand>("SELECT * FROM brands"),
      db.query(
        "SELECT * FROM policy_reviews WHERE policy_hash=$1 ORDER BY created_at DESC",
        [policyHash],
      ),
    ]);
    const verified = brands.rows.filter(
      (b) => b.active && b.review_status === "verified" && b.keywords.length,
    );
    const sourceResults = sources.rows.map((s) => {
      const audit = audits.rows.find((a) => a.source_id === s.id);
      return {
        id: s.id,
        name: s.config.name,
        audit_id: audit?.id ?? null,
        ...evaluateSource(
          s.config,
          audit,
          trials.rows.filter((t) => t.audit_id === audit?.id),
        ),
      };
    });
    res.json({
      policy,
      policy_hash: policyHash,
      policy_reviewed: reviews.rows.length > 0,
      reviews: reviews.rows,
      brands: {
        total: brands.rows.length,
        verified: verified.length,
        minimum: 150,
        target: 200,
        categories: Object.entries(policy.category_targets).map(
          ([name, target]) => ({
            name,
            target,
            verified: verified.filter((b) => b.category === name).length,
          }),
        ),
        duplicate_candidates: brands.rows.flatMap((b, i) =>
          brands.rows
            .slice(i + 1)
            .filter((c) =>
              [b.name, ...b.aliases].some((n) =>
                [c.name, ...c.aliases].some(
                  (m) =>
                    m.normalize("NFKC").trim().toLowerCase() ===
                    n.normalize("NFKC").trim().toLowerCase(),
                ),
              ),
            )
            .map((c) => ({ a: b.id, b: c.id, names: [b.name, c.name] })),
        ),
      },
      sources: sourceResults,
      data_gate_passed: sourceResults.some((s) => s.passed),
      publication: {
        allowed: false,
        p72: null,
        headstart_index: null,
        mode: "manual_observation",
        reasons: [
          ...(verified.length < 150 ? ["上海已核验品牌不足150个"] : []),
          ...(!sourceResults.some((s) => s.passed)
            ? ["关键来源未通过实测及7日门禁"]
            : []),
          ...(!reviews.rows.length ? ["口径配置尚未人工评审"] : []),
          "模型、标签阈值及独立回测尚未验收",
        ],
      },
    });
  });
  app.post("/v1/admission/review", async (req, res) => {
    const v = policyReviewInput.parse(req.body);
    if (v.policy_hash !== policyHash) invalid("配置版本已变化，请刷新后评审");
    const id = randomUUID();
    await db.query(
      "INSERT INTO policy_reviews(id,policy_hash,config) VALUES($1,$2,$3)",
      [id, policyHash, JSON.stringify({ ...v, policy_snapshot: policy })],
    );
    res.status(201).json({ id });
  });
  app.get("/v1/admission/audits", async (_req, res) =>
    res.json({
      items: (
        await db.query(
          "SELECT * FROM source_audits ORDER BY created_at DESC,id",
        )
      ).rows,
    }),
  );
  app.post("/v1/admission/audits", async (req, res) => {
    const v = auditInput.parse(req.body);
    if (Date.parse(v.observed_at) > Date.now()) invalid("实测时间不能位于未来");
    const s = (
      await db.query<{ config: SourceInput }>(
        "SELECT config FROM data_sources WHERE id=$1",
        [v.source_id],
      )
    ).rows[0];
    if (!s) invalid("来源不存在");
    const id = randomUUID();
    await db.query(
      "INSERT INTO source_audits(id,source_id,source_hash,config) VALUES($1,$2,$3,$4)",
      [id, v.source_id, fingerprint(s.config), JSON.stringify(v)],
    );
    res.status(201).json({ id });
  });
  app.get("/v1/admission/trials", async (_req, res) =>
    res.json({
      items: (
        await db.query("SELECT * FROM source_trials ORDER BY day DESC,id")
      ).rows,
    }),
  );
  app.post("/v1/admission/trials", async (req, res) => {
    const v = trialInput.parse(req.body);
    const a = (
      await db.query<Audit>("SELECT * FROM source_audits WHERE id=$1", [
        v.audit_id,
      ])
    ).rows[0];
    if (!a) invalid("实测记录不存在");
    if (
      v.day >= dayOf(Date.now()) ||
      v.day < dayOf(new Date(a.created_at).getTime())
    )
      invalid("只接受登记实测起至昨日的完整自然日，不允许回填登记前7天");
    const brands = (
      await db.query<Brand>("SELECT * FROM brands WHERE id=ANY($1::uuid[])", [
        v.brand_ids,
      ])
    ).rows;
    if (
      brands.length !== v.brand_ids.length ||
      brands.some(
        (b) =>
          b.review_status !== "verified" || !b.active || !b.keywords.length,
      )
    )
      invalid("试点须为已核验启用并配置关键词的品牌");
    if (new Set(brands.map((b) => b.category)).size < 3)
      invalid("试点须覆盖至少3个品类");
    const id = randomUUID();
    await db.query(
      "INSERT INTO source_trials(id,audit_id,day,config) VALUES($1,$2,$3,$4)",
      [id, v.audit_id, v.day, JSON.stringify(v)],
    );
    res.status(201).json({ id });
  });
  app.get("/v1/events/:id/admission", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const event = (await db.query("SELECT * FROM events WHERE id=$1", [id]))
      .rows[0];
    if (!event) {
      res
        .status(404)
        .json({ error: { code: "NOT_FOUND", message: "事件不存在" } });
      return;
    }
    const rows = (
      await db.query<{ config: EventAdmissionInput }>(
        "SELECT * FROM event_admissions WHERE event_id=$1 ORDER BY created_at DESC,id",
        [id],
      )
    ).rows;
    const latest = rows[0]?.config;
    const fresh =
      !!latest &&
      latest.event_fingerprint === fingerprint(event) &&
      Date.parse(latest.valid_until) > Date.now();
    const current = event as {
      status: string;
      ends_at: Date;
      eligibility: string;
    };
    res.json({
      monitoring_unit: {
        brand_id: (event as { brand_id: string }).brand_id,
        event_id: id,
        region_code: "310000",
        as_of: new Date().toISOString(),
      },
      event_fingerprint: fingerprint(event),
      history: rows,
      local_review_valid: fresh,
      local_candidate:
        fresh &&
        latest?.risk === "none" &&
        latest.participation === "available" &&
        current.status === "verified" &&
        current.eligibility === "available" &&
        new Date(current.ends_at).getTime() > Date.now(),
      auto_recommendation: false,
    });
  });
  app.post("/v1/events/:id/admission", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = eventAdmissionInput.parse(req.body);
    await db.transaction(async (tx) => {
      const event = (
        await tx.query("SELECT * FROM events WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!event) invalid("事件不存在");
      if (v.event_fingerprint !== fingerprint(event))
        invalid("事件已更正，请刷新后重新核验");
      if (Date.parse(v.valid_until) <= Date.now())
        invalid("核验有效期必须晚于当前时间");
      await tx.query(
        "INSERT INTO event_admissions(id,event_id,config) VALUES($1,$2,$3)",
        [randomUUID(), id, JSON.stringify(v)],
      );
    });
    res.status(201).json({ saved: true, auto_recommendation: false });
  });
}
