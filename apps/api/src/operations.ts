import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { createAiRecommendations } from "./ai-recommendations.js";
import { createAlerts } from "./alerts.js";
import { brandCoverage } from "./brand-coverage.js";
import { createBrandIndex } from "./brand-index.js";
import { couponAcceptance } from "./coupon-acceptance.js";
import { createCouponMedia } from "./coupon-media.js";
import { createPickReader, registerCouponPicks } from "./coupon-picks.js";
import { createCouponPool } from "./coupon-pool.js";
import { createCouponStorageMaintenance } from "./coupon-storage.js";
import { writeDatabaseBackup } from "./database-backup.js";
import { createDatabaseMaintenance } from "./database-maintenance.js";
import { createEnvironment } from "./environment.js";
import { createObjectStorage } from "./object-storage.js";
import { createOpportunityBoard } from "./opportunity-board.js";
import { createPickEvaluation } from "./pick-evaluation.js";
import { enableReadModels } from "./read-model-cache.js";
import { createSalesHeat, salesHeatCsv } from "./sales-heat.js";
import { auditSalesHeat } from "./sales-heat-audit.js";
import { createScoreHistory } from "./score-history.js";
import { briefMarkdown, createSelectionBrief } from "./selection-brief.js";
import { sourceDiagnostics } from "./source-diagnostics.js";
import { readStability } from "./stability.js";
import { createVideoProjects } from "./video-projects.js";
export async function createOperations(
  db: PGlite,
  backupDir: string,
  observe: <T>(label: string, work: () => Promise<T>) => Promise<T> = (
    _label,
    work,
  ) => work(),
) {
  const couponStorage = createCouponStorageMaintenance(db);
  const maintainDatabase = createDatabaseMaintenance(db);
  const brandIndex = await createBrandIndex(db);
  const environment = await createEnvironment(db);
  const alerts = await createAlerts(db);
  const scores = await createScoreHistory(db, alerts.opportunity);
  const board = await createOpportunityBoard(db, alerts.emit);
  const brief = createSelectionBrief(db, board.candidates);
  const salesHeat = createSalesHeat(db);
  await enableReadModels(db);
  const pool = await createCouponPool(db, (brand) =>
    createPickReader(
      db,
      () => salesHeat.readBrand(brand),
      () => board.candidatesBrand(brand),
      brandIndex.read,
      brand,
    )(),
  );
  const evaluation = await createPickEvaluation(
    db,
    pool.read,
    createPickReader(undefined, salesHeat.read, async () => []),
  );
  const ai = await createAiRecommendations(db, {
    readPicks: pool.read,
    readContext: async () => {
      const v = await environment.status();
      return { outlook: v.outlook, attribution: v.attribution };
    },
    credentialPath: join(backupDir, "..", "secrets", "deepseek.json"),
  });
  const media = await createCouponMedia(
    db,
    join(backupDir, "..", "secrets", "xiaohongshu-requests.json"),
  );
  const videos = await createVideoProjects(db, join(backupDir, "..", "videos"));
  const backupStorage = await createObjectStorage(backupDir);
  const readPicks = pool.read;
  let busy = false;
  let backupError: string | null = null;
  let backupDoneDate = "";
  let backupRetryAfter = 0;
  async function backup() {
    const day = new Date().toISOString().slice(0, 10);
    if (busy || backupDoneDate === day || Date.now() < backupRetryAfter) return;
    busy = true;
    try {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const name = `radar-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      const files = await readdir(backupDir);
      for (const stale of files.filter((f) =>
        /^radar-\d{4}-\d{2}-\d{2}\.tar\.gz\.tmp(?:\.snapshot)?$/.test(f),
      ))
        await rm(join(backupDir, stale), { recursive: true, force: true });
      if (!files.includes(name) && !files.includes(name + ".oss.json")) {
        const attempt = join(backupDir, ".backup-attempt.json");
        const previous = await readFile(attempt, "utf8")
          .then((v) => JSON.parse(v))
          .catch(() => null);
        if (previous?.retryAfter > Date.now()) {
          backupRetryAfter = previous.retryAfter;
          return;
        }
        await writeFile(
          attempt,
          JSON.stringify({ retryAfter: Date.now() + 10 * 60_000 }),
          { mode: 0o600 },
        );
        const temp = join(backupDir, `${name}.tmp`);
        await writeDatabaseBackup(db, temp);
        await rename(temp, join(backupDir, name));
      }
      const names = [
        ...new Set([...files, name].map((f) => f.replace(/\.oss\.json$/, ""))),
      ]
        .filter((f) => /^radar-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f))
        .sort();
      if (backupStorage) {
        // Seven daily cloud backups, two recent local copies. Failed uploads
        // abort retention so an outage never causes the only copy to be deleted.
        for (const f of names.slice(-7))
          await backupStorage.archive(
            join(backupDir, f),
            !names.slice(-2).includes(f),
          );
        for (const f of names.slice(0, -7))
          await backupStorage.remove(join(backupDir, f));
      } else {
        for (const f of names.slice(0, -7)) await unlink(join(backupDir, f));
      }
      backupError = null;
      backupDoneDate = day;
    } catch {
      backupError = "BACKUP_FAILED";
      backupRetryAfter = Date.now() + 10 * 60_000;
    } finally {
      busy = false;
    }
  }
  let active: Promise<void> | undefined;
  function tick() {
    if (!active)
      active = performTick().finally(() => {
        active = undefined;
      });
    return active;
  }
  let lastReports = 0;
  let lastScores = 0;
  let lastEvaluation = 0;
  async function performTick() {
    await observe("storage.compact", couponStorage.run);
    await observe("database.maintenance", maintainDatabase);
    await observe("alerts.health", () => alerts.health());
    if (Date.now() - lastScores >= 5 * 60000) {
      await observe("scores.refresh", () => scores.refresh());
      lastScores = Date.now();
    }
    await observe("board.digest", () => board.digest());
    await observe("picks.precompute", () => readPicks());
    // 72-hour backtesting need not scan all sales history every minute.
    // Coupon collection, pool updates and subscription notifications keep their cadence.
    if (Date.now() - lastEvaluation >= 10 * 60000) {
      await observe("picks.evaluate", () => evaluation.refresh());
      lastEvaluation = Date.now();
    }
    await observe("backup", () => backup());
    await observe("environment.refresh", () => environment.refresh());
    if (Date.now() - lastReports < 15 * 60000) return;
    lastReports = Date.now();
    // Automatically maintain a credential-free progress report, including final coverage.
    const run = (
      await db.query<{ id: string }>(
        "SELECT * FROM coupon_runs ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0];
    if (run) {
      const tasks = (
        await db.query(
          "SELECT t.brand_id,t.name,t.state,t.pages,t.error_code,t.comparison_status,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id) AS recalled,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id AND i.payload->>'identity'='name_match') AS matched FROM coupon_tasks t WHERE run_id=$1 ORDER BY name",
          [run.id],
        )
      ).rows;
      const reportDir = join(backupDir, "..", "reports");
      await mkdir(reportDir, { recursive: true, mode: 0o700 });
      const filename = join(reportDir, `${run.id}.json`);
      await writeFile(
        `${filename}.tmp`,
        JSON.stringify(
          {
            exported_at: new Date().toISOString(),
            run,
            tasks,
            caveat: "分页完成不代表品牌覆盖完整；名称匹配不代表权益已核验",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await rename(`${filename}.tmp`, filename);
      const reviewFile = join(reportDir, "brand-review-current.json");
      await writeFile(
        `${reviewFile}.tmp`,
        JSON.stringify(await brandCoverage(db), null, 2),
        { mode: 0o600 },
      );
      await rename(`${reviewFile}.tmp`, reviewFile);
      const acceptanceFile = join(reportDir, `${run.id}.acceptance.json`);
      await writeFile(
        `${acceptanceFile}.tmp`,
        JSON.stringify(await couponAcceptance(db, run.id), null, 2),
        { mode: 0o600 },
      );
      await rename(`${acceptanceFile}.tmp`, acceptanceFile);
      const diagnosticFile = join(reportDir, "source-diagnostics-current.json");
      await writeFile(
        `${diagnosticFile}.tmp`,
        JSON.stringify(await sourceDiagnostics(db), null, 2),
        { mode: 0o600 },
      );
      await rename(`${diagnosticFile}.tmp`, diagnosticFile);
      const currentBrief = await observe("brief.read", () => brief.read());
      const heatRows = await observe("salesHeat.read", () => salesHeat.read());
      heatRows.sort(
        (a, b) =>
          (b.speed ?? -Infinity) - (a.speed ?? -Infinity) ||
          `${a.brand_id}:${a.product_id}`.localeCompare(
            `${b.brand_id}:${b.product_id}`,
          ),
      );
      for (const [name, content] of [
        [
          "sales-heat-audit-current.json",
          JSON.stringify(
            {
              generated_at: new Date().toISOString(),
              ...auditSalesHeat(heatRows),
            },
            null,
            2,
          ),
        ],
        [
          "sales-heat-current.json",
          JSON.stringify(
            {
              generated_at: new Date().toISOString(),
              items: heatRows,
              caveat: "月售展示值净变化，不是新增订单；未知不按零。",
            },
            null,
            2,
          ),
        ],
        ["sales-heat-current.csv", salesHeatCsv(heatRows)],
        ["selection-brief-current.json", JSON.stringify(currentBrief, null, 2)],
        ["selection-brief-current.md", briefMarkdown(currentBrief)],
        [
          "stability-current.json",
          JSON.stringify(await readStability(db), null, 2),
        ],
      ]) {
        const file = join(reportDir, name);
        await writeFile(`${file}.tmp`, content, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      }
    }
  }
  function register(app: Express) {
    couponStorage.register(app);
    registerCouponPicks(
      app,
      salesHeat.read,
      board.candidates,
      db,
      environment.status,
      brandIndex.read,
      pool.read,
    );
    brandIndex.register(app);
    ai.register(app);
    media.register(app);
    videos.register(app);
    evaluation.register(app);
    alerts.register(app);
    scores.register(app);
    board.register(app);
    brief.register(app);
    salesHeat.register(app);
    app.get("/api/v3/source-diagnostics", async (_req, res) =>
      res.json(await sourceDiagnostics(db)),
    );
    app.get("/api/v3/runs/:id/acceptance", async (req, res) => {
      const report = await couponAcceptance(db, z.uuid().parse(req.params.id));
      if (!report)
        return res.status(404).json({ error: { message: "轮次不存在" } });
      res.json(report);
    });
    app.get("/api/v3/environment", async (_req, res) =>
      res.json(await environment.status()),
    );
    app.get("/api/v3/operations", async (_req, res) => {
      const requests = (
        await db.query(
          "SELECT count(*)::int AS requests,count(*) FILTER (WHERE gap_ms<1000)::int AS short_gaps,count(*) FILTER (WHERE outcome<>'OK' AND outcome<>'in_flight')::int AS non_success FROM coupon_requests WHERE started_at>now()-interval '24 hours'",
        )
      ).rows[0];
      const coverage = (
        await db.query(
          "SELECT count(*)::int AS brands,count(*) FILTER (WHERE b.active)::int AS enabled,count(*) FILTER (WHERE b.active AND t.completed_at>now()-interval '36 hours')::int AS fresh_baselines FROM brands b LEFT JOIN coupon_baselines cb ON cb.brand_id=b.id LEFT JOIN coupon_tasks t ON t.brand_id=b.id AND t.run_id=cb.run_id",
        )
      ).rows[0];
      res.json({
        requests,
        coverage,
        rules: (
          await db.query(
            "SELECT state,count(*)::int AS count FROM coupon_rule_tasks GROUP BY state ORDER BY state",
          )
        ).rows,
        stores: (
          await db.query(
            "SELECT state,count(*)::int AS count FROM coupon_store_tasks GROUP BY state ORDER BY state",
          )
        ).rows,
        current_enrichment: (
          await db.query(
            `SELECT 'rules' AS kind,t.state,t.error_code,(s.completed_at>now()-interval '36 hours') AS fresh,count(*)::int AS count FROM coupon_rule_tasks t JOIN coupon_baselines b ON b.brand_id=t.brand_id AND b.run_id=t.run_id JOIN coupon_tasks s ON s.run_id=b.run_id AND s.brand_id=b.brand_id GROUP BY t.state,t.error_code,fresh UNION ALL SELECT 'stores' AS kind,t.state,t.error_code,(s.completed_at>now()-interval '36 hours') AS fresh,count(*)::int AS count FROM coupon_store_tasks t JOIN coupon_baselines b ON b.brand_id=t.brand_id AND b.run_id=t.run_id JOIN coupon_tasks s ON s.run_id=b.run_id AND s.brand_id=b.brand_id GROUP BY t.state,t.error_code,fresh`,
          )
        ).rows,
        identity_refreshes: (
          await db.query(
            "SELECT f.brand_id,b.name,f.run_id,r.status AS run_status,t.state,t.error_code,t.completed_at FROM coupon_identity_refreshes f JOIN brands b ON b.id=f.brand_id JOIN coupon_runs r ON r.id=f.run_id JOIN coupon_tasks t ON t.run_id=f.run_id AND t.brand_id=f.brand_id ORDER BY f.created_at DESC",
          )
        ).rows,
        backup: {
          error: backupError,
          files: [
            ...new Set(
              (await readdir(backupDir).catch(() => [])).map((f) =>
                f.replace(/\.oss\.json$/, ""),
              ),
            ),
          ]
            .filter((f) => f.endsWith(".tar.gz"))
            .sort(),
          storage: backupStorage ? "oss-private" : "local",
          local_copies: backupStorage ? 2 : 7,
          retention_days: 7,
        },
        blockers: [
          "券权益接口已接通，规则结构化与全部适用门店尚待核验",
          "月售统计口径与长期历史仍需核验，平台指数仅作待接入辅助",
          "7天14轮稳定性观察需真实经过时间",
          "回测与权重校准需积累结果标签",
        ],
      });
    });
  }
  return {
    tick,
    poolTick: pool.tick,
    refreshBrand: pool.refreshBrand,
    backup,
    register,
    drain: async () => {
      await Promise.all([
        active ?? Promise.resolve(),
        pool.stop(),
        ai.drain(),
        videos.stop(),
        media.stop(),
      ]);
    },
  };
}
