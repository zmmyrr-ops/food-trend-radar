import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import {
  brandInput,
  brandReviewInput,
  type EventInput,
  eventInput,
  type ImportResult,
  researchEvidenceInput,
  type SourceInput,
  sourceGate,
  sourceInput,
} from "@radar/contracts";
import { parse } from "csv-parse/sync";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { registerAdmission } from "./admission.js";
import { createAutoRadar } from "./auto-radar.js";
import { registerBrandSubscriptions } from "./brand-subscriptions.js";
import type { createCoupons } from "./coupons.js";
import type { createOperations } from "./operations.js";
import { registerShopReports } from "./shop-reports.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const normalize = (v: string) =>
  v.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const eventKey = (v: EventInput) =>
  hash(
    JSON.stringify([
      v.brand_id,
      normalize(v.title),
      v.type,
      new Date(v.starts_at).toISOString(),
      new Date(v.ends_at).toISOString(),
      "310000",
    ]),
  );
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
type Queryable = Pick<PGlite, "query">;
async function saveEvent(db: Queryable, v: EventInput, id: string) {
  return db.query(
    "INSERT INTO events(id,brand_id,title,type,starts_at,ends_at,source_url,evidence_note,effective_price,eligibility,status,dedup_key,source_id,original_price,promotion_terms,collaboration,store_scope,applicable_stores) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *",
    [
      id,
      v.brand_id,
      v.title,
      v.type,
      v.starts_at,
      v.ends_at,
      v.source_url,
      v.evidence_note,
      v.effective_price,
      v.eligibility,
      v.status,
      eventKey(v),
      v.source_id,
      v.original_price,
      v.promotion_terms,
      v.collaboration,
      v.store_scope,
      JSON.stringify(v.applicable_stores),
    ],
  );
}
async function processCsv(
  tx: Queryable,
  csv: string,
  write: boolean,
): Promise<ImportResult> {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      columns: (headers: string[]) => {
        const allowed = [
          "brand_id",
          "title",
          "type",
          "starts_at",
          "ends_at",
          "source_url",
          "evidence_note",
          "effective_price",
          "eligibility",
          "status",
          "source_id",
          "original_price",
          "promotion_terms",
          "collaboration",
          "store_scope",
          "applicable_stores",
        ];
        const required = allowed.slice(0, 7);
        if (
          new Set(headers).size !== headers.length ||
          headers.some((h) => !allowed.includes(h)) ||
          required.some((h) => !headers.includes(h))
        )
          throw new Error("表头缺失、重复或含未知字段");
        return headers;
      },
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 10000,
    });
  } catch {
    throw new HttpError(
      422,
      "CSV_INVALID",
      "CSV格式不正确：请检查表头、列数和引号；必需字段见模板",
    );
  }
  if (!rows.length || rows.length > 500)
    throw new HttpError(422, "CSV_LIMIT", "每次导入1至500行");
  const report: ImportResult = {
    id: randomUUID(),
    created: 0,
    duplicates: 0,
    errors: [],
  };
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const parsed = eventInput.safeParse({
      ...row,
      source_id: row.source_id?.trim() || null,
      original_price: row.original_price?.trim()
        ? Number(row.original_price)
        : null,
      promotion_terms: row.promotion_terms || "",
      collaboration: row.collaboration || "",
      store_scope: row.store_scope?.trim() || "unknown",
      applicable_stores: row.applicable_stores?.trim()
        ? row.applicable_stores.split("|").map((s) => s.trim())
        : [],
      effective_price: row.effective_price?.trim()
        ? Number(row.effective_price)
        : null,
    });
    if (!parsed.success) {
      report.errors.push({
        row: i + 2,
        message: parsed.error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("；"),
      });
      continue;
    }
    const v = parsed.data;
    if (
      !(await tx.query("SELECT id FROM brands WHERE id=$1", [v.brand_id])).rows
        .length
    ) {
      report.errors.push({
        row: i + 2,
        message: "brand_id不存在，请先建立品牌",
      });
      continue;
    }
    if (
      v.source_id &&
      !(
        await tx.query("SELECT id FROM data_sources WHERE id=$1", [v.source_id])
      ).rows.length
    ) {
      report.errors.push({
        row: i + 2,
        message: "source_id不存在，请先登记来源",
      });
      continue;
    }
    if (
      seen.has(eventKey(v)) ||
      (
        await tx.query("SELECT id FROM events WHERE dedup_key=$1", [
          eventKey(v),
        ])
      ).rows.length
    ) {
      report.duplicates++;
      continue;
    }
    seen.add(eventKey(v));
    if (write) await saveEvent(tx, v, randomUUID());
    report.created++;
  }
  return report;
}
export function createApp(
  db: PGlite,
  webOrigin = "http://localhost:5173",
  radar = createAutoRadar(db),
  coupons?: ReturnType<typeof createCoupons>,
  operations?: Awaited<ReturnType<typeof createOperations>>,
  runtimeDiagnostics?: () => unknown,
  accounts?: { register(app: express.Express): void },
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Request-Id", randomUUID());
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.get("host") ?? "")
    )
      return next(new HttpError(403, "HOST_DENIED", "仅允许本机访问"));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        origin &&
        ![
          webOrigin,
          "http://127.0.0.1:5173",
          `http://${req.get("host")}`,
        ].includes(origin)
      )
        return next(new HttpError(403, "ORIGIN_DENIED", "请求来源不允许"));
      if (
        !req.is("application/json") &&
        !(
          req.path === "/api/v3/video-assets" &&
          req.method === "POST" &&
          (req.is("video/*") ||
            req.is("audio/*") ||
            req.is("image/jpeg") ||
            req.is("image/png") ||
            req.is("image/webp"))
        )
      )
        return next(new HttpError(415, "CONTENT_TYPE", "请使用JSON请求"));
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  accounts?.register(app);
  registerShopReports(app, db);
  registerBrandSubscriptions(app, db);
  if (runtimeDiagnostics)
    app.get("/api/v3/runtime-diagnostics", (_req, res) =>
      res.json(runtimeDiagnostics()),
    );
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ status: "ready", database: "pglite-local" });
  });
  app.get("/v1/sources", async (_req, res) => {
    const result = await db.query<{
      id: string;
      config: SourceInput;
      created_at: string;
    }>("SELECT * FROM data_sources ORDER BY created_at DESC,id");
    res.json({
      items: result.rows.map((r) => ({
        ...r.config,
        id: r.id,
        created_at: r.created_at,
        gate: sourceGate(r.config),
      })),
    });
  });
  app.post("/v1/sources", async (req, res) => {
    const v = sourceInput.parse(req.body),
      id = randomUUID();
    await db.query(
      "INSERT INTO data_sources(id,name_key,config) VALUES($1,$2,$3)",
      [id, normalize(v.name), JSON.stringify(v)],
    );
    res.status(201).json({ id, ...v, gate: sourceGate(v) });
  });
  app.put("/v1/sources/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = sourceInput.parse(req.body);
    await db.transaction(async (tx) => {
      const old = await tx.query("SELECT * FROM data_sources WHERE id=$1", [
        id,
      ]);
      if (!old.rows.length) throw new HttpError(404, "NOT_FOUND", "来源不存在");
      await tx.query(
        "INSERT INTO changes(entity_type,entity_id,snapshot) VALUES('source',$1,$2)",
        [id, JSON.stringify(old.rows[0])],
      );
      await tx.query(
        "UPDATE data_sources SET name_key=$2,config=$3 WHERE id=$1",
        [id, normalize(v.name), JSON.stringify(v)],
      );
    });
    res.json({ id, ...v, gate: sourceGate(v) });
  });
  app.get("/v1/sources/:id/history", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (
      !(await db.query("SELECT id FROM data_sources WHERE id=$1", [id])).rows
        .length
    )
      throw new HttpError(404, "NOT_FOUND", "来源不存在");
    res.json({
      items: (
        await db.query(
          "SELECT * FROM changes WHERE entity_type='source' AND entity_id=$1 ORDER BY id DESC",
          [id],
        )
      ).rows,
    });
  });
  app.get("/v1/brands", async (req, res) => {
    const q = z
      .string()
      .max(100)
      .parse(req.query.q ?? "");
    const result = await db.query(
      "SELECT * FROM brands WHERE name ILIKE $1 OR aliases::text ILIKE $1 ORDER BY created_at DESC,id",
      [`%${q}%`],
    );
    res.json({ items: result.rows });
  });
  app.post("/v1/brands", async (req, res) => {
    const v = brandInput.parse(req.body),
      id = randomUUID();
    const result = await db.query(
      "INSERT INTO brands(id,name,name_key,category,aliases,shanghai_evidence_url,active,keywords) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        id,
        v.name,
        normalize(v.name),
        v.category,
        JSON.stringify(v.aliases),
        v.shanghai_evidence_url,
        v.active,
        JSON.stringify(v.keywords),
      ],
    );
    res.status(201).json(result.rows[0]);
  });
  app.put("/v1/brands/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = brandInput.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const old = await tx.query("SELECT * FROM brands WHERE id=$1", [id]);
      if (!old.rows.length) throw new HttpError(404, "NOT_FOUND", "品牌不存在");
      await tx.query(
        "INSERT INTO changes(entity_type,entity_id,snapshot) VALUES($1,$2,$3)",
        ["brand", id, JSON.stringify(old.rows[0])],
      );
      return tx.query(
        "UPDATE brands SET name=$2,name_key=$3,category=$4,aliases=$5,shanghai_evidence_url=$6,active=$7,keywords=$8,revision=revision+1,review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=$1 RETURNING *",
        [
          id,
          v.name,
          normalize(v.name),
          v.category,
          JSON.stringify(v.aliases),
          v.shanghai_evidence_url,
          v.active,
          JSON.stringify(v.keywords),
        ],
      );
    });
    res.json(result.rows[0]);
  });
  app.get("/v1/brands/:id/evidence", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (
      !(await db.query("SELECT id FROM brands WHERE id=$1", [id])).rows.length
    )
      throw new HttpError(404, "NOT_FOUND", "品牌不存在");
    res.json({
      items: (
        await db.query(
          "SELECT evidence,created_at FROM brand_research WHERE brand_id=$1 ORDER BY created_at DESC,id",
          [id],
        )
      ).rows,
    });
  });
  app.post("/v1/brands/:id/evidence", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = researchEvidenceInput.parse(req.body);
    if (Date.parse(v.observed_at) > Date.now())
      throw new HttpError(422, "FUTURE_EVIDENCE", "采集时间不能位于未来");
    const key = hash(id + JSON.stringify(v));
    await db.query(
      "INSERT INTO brand_research(id,brand_id,evidence) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [key, id, JSON.stringify(v)],
    );
    res.status(201).json({ id: key });
  });
  app.post("/v1/brands/:id/review", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = brandReviewInput.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const old = await tx.query<{ revision: number; keywords: string[] }>(
        "SELECT * FROM brands WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!old.rows.length) throw new HttpError(404, "NOT_FOUND", "品牌不存在");
      if (old.rows[0].revision !== v.revision)
        throw new HttpError(
          409,
          "STALE_REVIEW",
          "品牌已更新，请刷新后重新核验",
        );
      if (v.decision === "verified" && !old.rows[0].keywords.length)
        throw new HttpError(
          422,
          "KEYWORDS_REQUIRED",
          "通过核验前请配置监测关键词",
        );
      await tx.query(
        "INSERT INTO changes(entity_type,entity_id,snapshot) VALUES('brand',$1,$2)",
        [id, JSON.stringify(old.rows[0])],
      );
      return tx.query(
        "UPDATE brands SET review_status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now(),revision=revision+1 WHERE id=$1 RETURNING *",
        [id, v.decision, v.note, v.reviewer],
      );
    });
    res.json(result.rows[0]);
  });
  app.get("/v1/brands/:id/history", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (
      !(await db.query("SELECT id FROM brands WHERE id=$1", [id])).rows.length
    )
      throw new HttpError(404, "NOT_FOUND", "品牌不存在");
    res.json({
      items: (
        await db.query(
          "SELECT * FROM changes WHERE entity_type='brand' AND entity_id=$1 ORDER BY id DESC",
          [id],
        )
      ).rows,
    });
  });
  app.get("/v1/events", async (_req, res) => {
    const result = await db.query(
      "SELECT e.*,b.name AS brand_name FROM events e JOIN brands b ON b.id=e.brand_id ORDER BY e.created_at DESC,e.id LIMIT 500",
    );
    res.json({ items: result.rows });
  });
  app.post("/v1/events", async (req, res) => {
    const v = eventInput.parse(req.body);
    const result = await saveEvent(db, v, randomUUID());
    res.status(201).json(result.rows[0]);
  });
  app.put("/v1/events/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = eventInput.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const old = await tx.query("SELECT * FROM events WHERE id=$1", [id]);
      if (!old.rows.length) throw new HttpError(404, "NOT_FOUND", "事件不存在");
      await tx.query(
        "INSERT INTO changes(entity_type,entity_id,snapshot) VALUES($1,$2,$3)",
        ["event", id, JSON.stringify(old.rows[0])],
      );
      return tx.query(
        "UPDATE events SET brand_id=$2,title=$3,type=$4,starts_at=$5,ends_at=$6,source_url=$7,evidence_note=$8,effective_price=$9,eligibility=$10,status=$11,dedup_key=$12,source_id=$13,original_price=$14,promotion_terms=$15,collaboration=$16,store_scope=$17,applicable_stores=$18 WHERE id=$1 RETURNING *",
        [
          id,
          v.brand_id,
          v.title,
          v.type,
          v.starts_at,
          v.ends_at,
          v.source_url,
          v.evidence_note,
          v.effective_price,
          v.eligibility,
          v.status,
          eventKey(v),
          v.source_id,
          v.original_price,
          v.promotion_terms,
          v.collaboration,
          v.store_scope,
          JSON.stringify(v.applicable_stores),
        ],
      );
    });
    res.json(result.rows[0]);
  });
  app.get("/v1/events/:id/history", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const result = await db.query(
      "SELECT * FROM changes WHERE entity_type='event' AND entity_id=$1 ORDER BY id DESC",
      [id],
    );
    res.json({ items: result.rows });
  });
  app.post("/v1/imports/preview", async (req, res) => {
    const { csv } = z
      .object({ csv: z.string().min(1).max(500000) })
      .strict()
      .parse(req.body);
    const report = await db.transaction((tx) => processCsv(tx, csv, false));
    res.json({
      valid: report.created,
      duplicates: report.duplicates,
      errors: report.errors,
    });
  });
  app.get("/v1/imports/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const result = await db.query(
      "SELECT id,result,created_at FROM imports WHERE id=$1",
      [id],
    );
    if (!result.rows.length)
      throw new HttpError(404, "NOT_FOUND", "导入记录不存在");
    res.json(result.rows[0]);
  });
  app.post("/v1/imports", async (req, res) => {
    const key = z.string().min(1).max(100).parse(req.get("Idempotency-Key"));
    const { csv } = z
      .object({ csv: z.string().min(1).max(500000) })
      .strict()
      .parse(req.body);
    const bodyHash = hash(csv);
    const result = await db.transaction(async (tx) => {
      const previous = await tx.query<{
        body_hash: string;
        result: ImportResult;
      }>("SELECT body_hash,result FROM imports WHERE idempotency_key=$1", [
        key,
      ]);
      if (previous.rows[0]) {
        if (previous.rows[0].body_hash !== bodyHash)
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "相同幂等键对应不同内容",
          );
        return previous.rows[0].result;
      }
      const report = await processCsv(tx, csv, true);
      await tx.query(
        "INSERT INTO imports(id,idempotency_key,body_hash,result) VALUES($1,$2,$3,$4)",
        [report.id, key, bodyHash, JSON.stringify(report)],
      );
      return report;
    });
    res.json(result);
  });
  app.get("/v1/imports", async (_req, res) => {
    const result = await db.query(
      "SELECT id,result,created_at FROM imports ORDER BY created_at DESC LIMIT 50",
    );
    res.json({ items: result.rows });
  });
  operations?.register(app);
  if (coupons) coupons.register(app);
  else radar.register(app);
  registerAdmission(app, db);
  app.use("/v1", (_req, res) =>
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "接口不存在" },
      request_id: res.getHeader("X-Request-Id"),
    }),
  );
  const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(webDist)) {
    app.use(
      "/assets",
      express.static(path.join(webDist, "assets"), {
        maxAge: "1y",
        immutable: true,
        fallthrough: false,
      }),
    );
    app.use(
      express.static(webDist, {
        setHeaders: (res, filename) => {
          if (filename.endsWith("index.html"))
            res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    app.get("/{*path}", (_req, res) =>
      res
        .setHeader("Cache-Control", "no-cache")
        .sendFile(path.join(webDist, "index.html")),
    );
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    let status = 500,
      code = "INTERNAL_ERROR",
      message = "服务暂时不可用";
    if (error instanceof z.ZodError) {
      status = 422;
      code = "VALIDATION_ERROR";
      message = error.issues
        .map((x) => `${x.path.join(".")}: ${x.message}`)
        .join("；");
    } else if (error instanceof HttpError) {
      ({ status, code, message } = error);
    } else if (error.code === "23505") {
      status = 409;
      code = "DUPLICATE";
      message = "名称或事件已存在，请检查重复记录";
    } else if (error.code === "23503") {
      status = 422;
      code = "UNKNOWN_REFERENCE";
      message = "关联的品牌或数据源不存在";
    } else if (error.type === "entity.parse.failed") {
      status = 400;
      code = "INVALID_JSON";
      message = "JSON格式不正确";
    } else if (error.type === "entity.too.large") {
      status = 413;
      code = "BODY_TOO_LARGE";
      message = "请求超过大小限制";
    }
    res.status(status).json({
      error: { code, message },
      request_id: res.getHeader("X-Request-Id"),
    });
  };
  app.use(errorHandler);
  return app;
}
