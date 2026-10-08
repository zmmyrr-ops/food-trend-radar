import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { inChannel } from "@radar/contracts";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { legacyOwner, ownerOf } from "./accounts.js";
import { mediaUrl } from "./coupon-media.js";
import { mediaFormat } from "./media-format.js";
import { createObjectStorage } from "./object-storage.js";
import { changePoints } from "./points.js";
import { registerStudioCopy } from "./studio-copy.js";
import { registerTopicPlays } from "./topic-plays.js";
import {
  type Asset,
  planSchema,
  productionOptionsSchema,
  requiresFaceScreen,
  type VideoProject,
  validatePlan,
} from "./video-types.js";
import { createVisitPlans, ownedVisitStore } from "./visit-plans.js";

const uuid = z.string().uuid();
const running = (s: string) =>
  [
    "queued",
    "preparing",
    "analyzing",
    "planning",
    "rendering_preview",
    "rendering_export",
  ].includes(s);
export async function createVideoProjects(db: PGlite, root: string) {
  const storage = await createObjectStorage(root);
  const visits = await createVisitPlans(db);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "uploads"), { recursive: true, mode: 0o700 });
  await db.exec(
    `CREATE TABLE IF NOT EXISTS video_projects(id uuid PRIMARY KEY,payload jsonb NOT NULL); CREATE TABLE IF NOT EXISTS video_uploads(id uuid PRIMARY KEY,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`,
  );
  await db.exec(
    `UPDATE video_projects SET payload=jsonb_set(jsonb_set(payload,'{state}','"interrupted"'),'{error}','"服务重启，已保留结果，请重试"') WHERE payload->>'state' IN ('queued','preparing','analyzing','planning','rendering_preview','rendering_export')`,
  );
  await db.exec(`ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS owner_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
    ALTER TABLE video_uploads ADD COLUMN IF NOT EXISTS owner_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
    CREATE INDEX IF NOT EXISTS video_project_owner ON video_projects(owner_id);`);
  await db.exec(
    "ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS point_charge_key text; ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS point_paid_revision int",
  );
  await db.exec(
    "UPDATE video_projects SET point_paid_revision=(payload->>'revision')::int WHERE point_paid_revision IS NULL AND point_charge_key IS NULL AND payload->>'state' IN ('preview_ready','completed')",
  );
  // Give existing projects a full grace period; expiry never changes from viewing/editing.
  await db.query(
    "UPDATE video_projects SET payload=jsonb_set(payload,'{expires_at}',to_jsonb($1::text)) WHERE payload->>'expires_at' IS NULL",
    [new Date(Date.now() + 30 * 86400000).toISOString()],
  );
  const expired = (p: VideoProject) =>
    !!p.expires_at &&
    Date.parse(p.expires_at) <= Date.now() &&
    !running(p.state);
  async function settleVideo(id: string, state: string) {
    if (
      ![
        "failed",
        "cancelled",
        "interrupted",
        "preview_ready",
        "completed",
      ].includes(state)
    )
      return;
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ owner_id: string; point_charge_key: string }>(
          "SELECT owner_id,point_charge_key FROM video_projects WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row?.point_charge_key) return;
      if (["failed", "cancelled", "interrupted"].includes(state))
        await changePoints(
          tx,
          row.owner_id,
          50,
          "视频制作退回",
          `refund:${row.point_charge_key}`,
        );
      await tx.query(
        "UPDATE video_projects SET point_charge_key=NULL,point_paid_revision=CASE WHEN $2 THEN (payload->>'revision')::int ELSE point_paid_revision END WHERE id=$1",
        [id, ["preview_ready", "completed"].includes(state)],
      );
    });
  }
  for (const row of (
    await db.query<{ id: string; state: string }>(
      "SELECT id,payload->>'state' AS state FROM video_projects WHERE point_charge_key IS NOT NULL",
    )
  ).rows)
    await settleVideo(row.id, row.state);
  let child: ChildProcess | undefined,
    activeId = "",
    stopped = false,
    writeChain = Promise.resolve(),
    cancelled = false;
  let pumping = false;
  const queue: { id: string; mode: string }[] = [];
  const get = async (id: string) => {
    uuid.parse(id);
    const p = (
      await db.query<{ payload: VideoProject }>(
        "SELECT payload FROM video_projects WHERE id=$1",
        [id],
      )
    ).rows[0]?.payload;
    if (!p) throw Error("项目不存在");
    return p;
  };
  const save = async (p: VideoProject) => {
    p.updated_at = new Date().toISOString();
    await db.query("UPDATE video_projects SET payload=$2 WHERE id=$1", [
      p.id,
      JSON.stringify(p),
    ]);
    await settleVideo(p.id, p.state);
  };
  const visible = (p: VideoProject) => ({
    ...p,
    expired: expired(p),
    error: p.error?.replace(/DeepSeek|百炼|Qwen[\w .+-]*/gi, "智能服务"),
    requires_face_screen: requiresFaceScreen(p),
    preview_revision: requiresFaceScreen(p) ? undefined : p.preview_revision,
    export_revision: requiresFaceScreen(p) ? undefined : p.export_revision,
    assets: p.assets.map(({ path, url, ...a }) => a),
  });
  async function pump() {
    if (child || pumping || stopped || !queue.length) return;
    pumping = true;
    try {
      const next = queue.shift()!;
      const p = await get(next.id);
      if (p.state !== "queued") {
        void pump();
        return;
      }
      const dir = join(root, p.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "input.json"), JSON.stringify(p), {
        mode: 0o600,
      });
      if (stopped || (await get(p.id)).state !== "queued") return;
      activeId = p.id;
      cancelled = false;
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              existsSync(
                fileURLToPath(new URL("./video-worker.js", import.meta.url)),
              )
                ? "./video-worker.js"
                : "../dist/video-worker.js",
              import.meta.url,
            ),
          ),
          dir,
          next.mode,
          root,
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env },
        },
      );
      const worker = child;
      worker.on("message", (message) => {
        if (cancelled) return;
        const patch = message as Partial<VideoProject>;
        Object.assign(p, patch);
        const snapshot = structuredClone(p);
        writeChain = writeChain.then(() => save(snapshot)).catch(() => {});
      });
      worker.on("error", () => {
        p.error = "无法启动视频处理进程";
      });
      worker.on("close", () => {
        void (async () => {
          await writeChain;
          if (!cancelled && running(p.state)) {
            p.state = "failed";
            p.error = p.error || "视频进程异常退出，可重试";
            await save(p);
          }
          child = undefined;
          activeId = "";
          void pump();
        })();
      });
    } finally {
      pumping = false;
      if (!child && queue.length && !stopped) queueMicrotask(() => void pump());
    }
  }
  async function enqueue(
    id: string,
    mode: string,
    options?: VideoProject["production_options"],
    revision?: number,
    selection?: {
      seconds?: number;
      resource_ids?: string[];
      upload_ids?: string[];
    },
  ) {
    const p = await get(id);
    if (expired(p)) throw Error("视频项目已过期，请新建制作项目");
    if (running(p.state)) return p;
    if (revision !== undefined && revision !== p.revision)
      throw Error("项目已更新，请刷新");
    if (selection?.resource_ids || selection?.upload_ids) {
      const resources = !p.brand_id
        ? []
        : (
            await db.query<{ resources: any[] }>(
              "SELECT resources FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=(SELECT owner_id FROM video_projects WHERE id=$3)",
              [p.brand_id, p.product_id, p.id],
            )
          ).rows[0]?.resources || [];
      const assets: Asset[] = [];
      for (const source of new Set(selection.resource_ids || [])) {
        const old = p.assets.find(
          (a) => a.source_id === source && a.origin !== "upload",
        );
        if (old) {
          assets.push(old);
          continue;
        }
        const resource = resources.find((r) => r.id === source);
        if (!resource || !mediaUrl(resource.video_url))
          throw Error("所选网络素材已失效，请重新获取");
        assets.push({
          id: randomUUID(),
          source_id: source,
          origin: "network",
          url: mediaUrl(resource.video_url),
          title: resource.title,
          author: resource.author,
          note_url: resource.note_url,
          kind: "video",
        });
      }
      for (const source of new Set(selection.upload_ids || [])) {
        const old = p.assets.find(
          (a) =>
            a.source_id === source &&
            (a.origin === "upload" || a.path?.includes("/uploads/")),
        );
        if (old) {
          assets.push(old);
          continue;
        }
        const upload = (
          await db.query<{ kind: string }>(
            "SELECT kind FROM video_uploads WHERE id=$1 AND owner_id=(SELECT owner_id FROM video_projects WHERE id=$2)",
            [source, p.id],
          )
        ).rows[0];
        if (!upload || upload.kind === "audio") throw Error("上传素材不存在");
        assets.push({
          id: randomUUID(),
          source_id: source,
          origin: "upload",
          path: join(root, "uploads", `${source}.source`),
          title: "用户上传素材",
          author: "用户提供",
          note_url: "",
          kind: upload.kind as "image" | "video",
        });
      }
      if (assets.length < 4 || assets.length > 40)
        throw Error("请选择4至40个素材");
      p.assets = assets;
      p.plan = [];
    }
    if (selection?.seconds !== undefined) {
      p.target_seconds = selection.seconds;
      p.seconds = selection.seconds;
      p.plan = [];
    }
    if (options) p.production_options = options;
    if (mode === "remake" && (!p.plan.length || requiresFaceScreen(p)))
      mode = "analyze";
    if (!p.rights_confirmed) throw Error("请先确认素材使用权限");
    if (mode !== "analyze") validatePlan(p.plan, p.assets, p.seconds);
    if (mode === "analyze") {
      const brand = p.brand_id
        ? (
            await db.query<{ category: string }>(
              "SELECT category FROM brands WHERE id=$1",
              [p.brand_id],
            )
          ).rows[0]
        : undefined;
      p.category = brand?.category;
      p.channel = brand
        ? inChannel(brand.category, "leisure")
          ? "leisure"
          : "food"
        : undefined;
      p.plan = [];
    }
    if (mode === "analyze" || mode === "remake") {
      p.revision++;
      delete p.script;
      delete p.script_segments;
      delete p.story_blocks;
      delete p.script_revision;
      delete p.narration_revision;
      delete p.subtitle_cues;
      delete p.preview_revision;
      delete p.export_revision;
    }
    p.state = "queued";
    p.error = null;
    p.progress = "等待视频处理";
    const claimed = await db.transaction(async (tx) => {
      const claimed = await tx.query(
        "UPDATE video_projects SET payload=$2 WHERE id=$1 AND payload->>'state' NOT IN ('queued','preparing','analyzing','planning','rendering_preview','rendering_export') RETURNING owner_id,point_paid_revision",
        [id, JSON.stringify(p)],
      );
      const owner = (claimed.rows[0] as { owner_id: string } | undefined)
        ?.owner_id;
      if (
        owner &&
        owner !== legacyOwner &&
        (["analyze", "remake"].includes(mode) ||
          (claimed.rows[0] as any).point_paid_revision !== p.revision)
      ) {
        const key = `video:${id}:${randomUUID()}`;
        await changePoints(tx, owner, -50, "制作探店视频", key);
        await tx.query(
          "UPDATE video_projects SET point_charge_key=$2 WHERE id=$1",
          [id, key],
        );
      }
      return claimed;
    });
    if (!claimed.rows.length) return get(id);
    queue.push({ id, mode });
    void pump().catch(async () => {
      p.state = "failed";
      p.error = "创建处理任务失败";
      await save(p);
    });
    return p;
  }
  const wrap =
    (f: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await f(req, res);
      } catch (e) {
        res
          .status(
            e instanceof Error && e.message === "POINTS_INSUFFICIENT"
              ? 402
              : 400,
          )
          .json({
            error: {
              message:
                e instanceof Error && e.message === "POINTS_INSUFFICIENT"
                  ? "积分不足，制作视频需要50积分"
                  : e instanceof z.ZodError
                    ? "输入参数不正确"
                    : e instanceof Error
                      ? e.message
                      : "请求失败",
            },
          });
      }
    };
  async function removeUpload(id: string) {
    const used = await db.query(
      `SELECT id FROM video_projects WHERE payload->>'music_id'=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'assets') a WHERE a->>'source_id'=$1) LIMIT 1`,
      [id],
    );
    if (used.rows.length) return false;
    const u = (
      await db.query<{ kind: string }>(
        "SELECT kind FROM video_uploads WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (u) {
      const path = join(
        root,
        "uploads",
        `${id}.${u.kind === "audio" ? "audio" : "source"}`,
      );
      if (storage) await storage.remove(path);
      else await rm(path, { force: true });
      await db.query("DELETE FROM video_uploads WHERE id=$1", [id]);
    }
    return true;
  }
  async function streamStored(
    req: Request,
    res: Response,
    path: string,
    filename: string,
    type: string,
    inline: boolean,
  ) {
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) {
      res.status(416).end();
      return true;
    }
    let remote;
    try {
      remote = await storage?.mediaStream(path, req.headers.range);
    } catch (e: any) {
      if (e.status === 416 || e.statusCode === 416) {
        res.status(416).end();
        return true;
      }
      throw e;
    }
    if (!remote) return false;
    const headers = remote.res.headers as Record<string, string>;
    res.status(remote.res.status === 206 ? 206 : 200);
    res.setHeader("Content-Type", type);
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    );
    res.setHeader("Accept-Ranges", "bytes");
    for (const key of ["content-length", "content-range"])
      if (headers[key]) res.setHeader(key, headers[key]);
    try {
      await pipeline(remote.stream, res);
    } catch {
      res.destroy();
    }
    return true;
  }
  function register(app: Express) {
    const creatingOwners = new Set<string>();
    app.post("/api/v3/video-projects", (req, res, next) => {
      const owner = ownerOf(req);
      if (creatingOwners.has(owner))
        return res
          .status(409)
          .json({ error: { message: "正在提交制作任务，请稍候" } });
      creatingOwners.add(owner);
      res.once("finish", () => creatingOwners.delete(owner));
      res.once("close", () => creatingOwners.delete(owner));
      next();
    });
    visits.register(app);
    const topicService = registerTopicPlays(
      app,
      join(root, "..", "topic-plays.json"),
    );
    registerStudioCopy(
      app,
      db,
      join(root, "..", "secrets", "deepseek.json"),
      topicService.search,
    );
    // Apply before every detail, download, render, deletion and asset endpoint.
    app.use(
      ["/api/v3/video-projects/:id", "/api/v3/video-assets/:id"],
      async (req, res, next) => {
        if (req.params.id === "config") return next();
        if (!uuid.safeParse(req.params.id).success) {
          res.status(404).json({ error: { message: "项目或素材不存在" } });
          return;
        }
        const table = req.originalUrl.startsWith("/api/v3/video-assets/")
          ? "video_uploads"
          : "video_projects";
        const row = await db.query(
          `SELECT id${table === "video_projects" ? ",payload" : ""} FROM ${table} WHERE id=$1 AND owner_id=$2`,
          [req.params.id, ownerOf(req)],
        );
        if (!row.rows.length) {
          res.status(404).json({ error: { message: "项目或素材不存在" } });
          return;
        }
        const payload = (row.rows[0] as { payload?: VideoProject }).payload;
        if (
          payload &&
          expired(payload) &&
          (req.method === "POST" ||
            /\/(download|media|poster)(\/|\?|$)/.test(req.originalUrl))
        ) {
          res
            .status(410)
            .json({ error: { message: "视频已过期，请新建制作项目" } });
          return;
        }
        next();
      },
    );
    app.patch(
      "/api/v3/video-projects/:id/visit",
      wrap(async (req, res) => {
        const visit = await ownedVisitStore(
          db,
          uuid.parse(req.body.visit_store_id),
          ownerOf(req),
        );
        if (!visit) throw Error("计划店铺不存在");
        const p = await get(uuid.parse(req.params.id));
        if (running(p.state)) throw Error("请等待制作结束再关联");
        p.visit_store_id = visit.id;
        p.visit_plan_id = visit.plan_id;
        p.visit_store_name = visit.name;
        p.visit_plan_name = visit.plan_name;
        p.visit_date = visit.date;
        await save(p);
        res.json({ project: visible(p) });
      }),
    );
    app.delete(
      "/api/v3/video-assets/:id",
      wrap(async (req, res) => {
        const id = uuid.parse(req.params.id);
        if (!(await removeUpload(id))) throw Error("素材正在被项目使用");
        res.json({ ok: true });
      }),
    );
    app.get(
      "/api/v3/video-projects/config",
      wrap(async (_req, res) => {
        let configured = false;
        try {
          configured = !!JSON.parse(
            await readFile(join(root, "..", "secrets", "bailian.json"), "utf8"),
          ).api_key;
        } catch {}
        res.json({
          configured,
          max_assets: 40,
          min_seconds: 15,
          max_seconds: 40,
        });
      }),
    );
    app.post(
      "/api/v3/video-assets",
      express.raw({
        type: ["video/*", "image/jpeg", "image/png", "image/webp", "audio/*"],
        limit: "50mb",
      }),
      wrap(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length < 100)
          throw Error("请选择视频、图片或音乐文件，最大50MB");
        const count = (
          await db.query<{ n: number }>(
            "SELECT count(*)::int n FROM video_uploads",
          )
        ).rows[0].n;
        if (count >= 200) throw Error("上传空间已达上限，请清理旧项目");
        const id = randomUUID(),
          kind = req.is("audio/*")
            ? "audio"
            : req.is("image/*")
              ? "image"
              : "video";
        await writeFile(
          join(
            root,
            "uploads",
            `${id}.${kind === "audio" ? "audio" : "source"}`,
          ),
          req.body,
          { mode: 0o600 },
        );
        await db.query(
          "INSERT INTO video_uploads(id,kind,owner_id) VALUES($1,$2,$3)",
          [id, kind, ownerOf(req)],
        );
        // Upload failures preserve the local file and the owned DB record.
        if (storage)
          await storage
            .archive(
              join(
                root,
                "uploads",
                `${id}.${kind === "audio" ? "audio" : "source"}`,
              ),
            )
            .catch(() =>
              console.error("OSS upload deferred; local upload retained"),
            );
        res.json({ id, kind });
      }),
    );
    app.get(
      "/api/v3/video-projects",
      wrap(async (req, res) => {
        if (
          req.query.brand_id === undefined &&
          req.query.product_id === undefined &&
          req.query.visit_store_id === undefined
        ) {
          const rows = await db.query<{ payload: VideoProject }>(
            "SELECT payload FROM video_projects WHERE owner_id=$1 ORDER BY payload->>'updated_at' DESC LIMIT 50",
            [ownerOf(req)],
          );
          res.json({
            items: rows.rows.map(({ payload: p }) => ({
              id: p.id,
              visit_store_id: p.visit_store_id,
              visit_plan_id: p.visit_plan_id,
              visit_store_name: p.visit_store_name,
              visit_plan_name: p.visit_plan_name,
              visit_date: p.visit_date,
              brand_id: p.brand_id,
              product_id: p.product_id,
              brand_name: p.brand_name,
              title: p.title,
              seconds: p.seconds,
              state: p.state,
              expired: expired(p),
              expires_at: p.expires_at,
              progress: p.progress,
              error: p.error,
              revision: p.revision,
              preview_revision: requiresFaceScreen(p)
                ? undefined
                : p.preview_revision,
              export_revision: requiresFaceScreen(p)
                ? undefined
                : p.export_revision,
              updated_at: p.updated_at,
            })),
          });
          return;
        }
        if (req.query.visit_store_id) {
          const store = uuid.parse(req.query.visit_store_id);
          res.json({
            items: (
              await db.query<{ payload: VideoProject }>(
                "SELECT payload FROM video_projects WHERE owner_id=$1 AND payload->>'visit_store_id'=$2 ORDER BY payload->>'created_at' DESC",
                [ownerOf(req), store],
              )
            ).rows.map((x) => visible(x.payload)),
          });
          return;
        }
        const brand = uuid.parse(req.query.brand_id),
          product = z.string().max(80).parse(req.query.product_id);
        res.json({
          items: (
            await db.query<{ payload: VideoProject }>(
              `SELECT payload FROM video_projects WHERE owner_id=$3 AND payload->>'brand_id'=$1 AND payload->>'product_id'=$2 ORDER BY payload->>'created_at' DESC LIMIT 20`,
              [brand, product, ownerOf(req)],
            )
          ).rows.map((x) => visible(x.payload)),
        });
      }),
    );
    app.post(
      "/api/v3/video-projects",
      wrap(async (req, res) => {
        const v = z
          .object({
            brand_id: z.union([uuid, z.literal("")]),
            visit_store_id: uuid,
            product_id: z.string().max(80),
            seconds: z.number().int().min(15).max(40),
            resource_ids: z.array(z.string().max(200)).max(40),
            upload_ids: z.array(uuid).max(40).default([]),
            music_id: uuid.optional(),
            production_options: productionOptionsSchema.optional(),
            rights_confirmed: z.literal(true),
          })
          .parse(req.body);
        const visit = await ownedVisitStore(db, v.visit_store_id, ownerOf(req));
        if (!visit) throw Error("请从我的探店计划选择店铺制作视频");
        if (
          (visit.brand_id || "") !== v.brand_id ||
          (visit.product_id || "") !== v.product_id
        )
          throw Error("券与计划店铺不匹配");
        const previous = (
          await db.query<{ payload: VideoProject }>(
            `SELECT payload FROM video_projects WHERE owner_id=$3 AND payload->>'brand_id'=$1 AND payload->>'product_id'=$2 AND payload->>'visit_store_id'=$4 AND payload->>'state' IN ('queued','preparing','analyzing','planning','rendering_preview','rendering_export') LIMIT 1`,
            [v.brand_id, v.product_id, ownerOf(req), v.visit_store_id],
          )
        ).rows[0];
        if (previous) {
          res.json({ project: visible(previous.payload) });
          return;
        }
        const total = (
          await db.query<{ n: number }>(
            "SELECT count(*)::int n FROM video_projects",
          )
        ).rows[0].n;
        if (total >= 50) throw Error("项目数量达到50，请先删除旧项目释放空间");
        const coupon = !v.brand_id
          ? { name: visit.name, payload: { name: visit.name } }
          : ((
              await db.query<{ name: string; payload: any }>(
                `SELECT b.name,i.payload FROM coupon_known_items i JOIN brands b ON b.id=i.brand_id WHERE i.brand_id=$1 AND i.product_id=$2 AND i.payload->>'identity'='name_match' ORDER BY i.observed_at DESC LIMIT 1`,
                [v.brand_id, v.product_id],
              )
            ).rows[0] ?? { name: visit.name, payload: { name: visit.name } });
        const resources = !v.brand_id
          ? []
          : ((
              await db.query<{ resources: any[] }>(
                `SELECT resources FROM coupon_media_jobs WHERE brand_id=$1 AND product_id=$2 AND owner_id=$3`,
                [v.brand_id, v.product_id, ownerOf(req)],
              )
            ).rows[0]?.resources ?? []);
        const assets: Asset[] = [];
        for (const id of new Set(v.resource_ids)) {
          const r = resources.find((r) => r.id === id);
          if (!r || !mediaUrl(r.video_url))
            throw Error("所选素材已不可用，请重新获取");
          assets.push({
            id: randomUUID(),
            source_id: id,
            origin: "network",
            url: mediaUrl(r.video_url),
            title: r.title,
            author: r.author,
            note_url: r.note_url,
            kind: "video",
          });
        }
        for (const id of new Set(v.upload_ids)) {
          const u = (
            await db.query<{ kind: string }>(
              "SELECT kind FROM video_uploads WHERE id=$1 AND owner_id=$2",
              [id, ownerOf(req)],
            )
          ).rows[0];
          if (!u || u.kind === "audio") throw Error("上传素材不存在");
          assets.push({
            id: randomUUID(),
            source_id: id,
            origin: "upload",
            path: join(root, "uploads", `${id}.source`),
            title: "用户上传素材",
            author: "用户提供",
            note_url: "",
            kind: u.kind as "image" | "video",
          });
        }
        if (assets.length < 4 || assets.length > 40)
          throw Error("请选择4至40个素材");
        if (
          v.music_id &&
          !(
            await db.query(
              `SELECT id FROM video_uploads WHERE id=$1 AND owner_id=$2 AND kind='audio'`,
              [v.music_id, ownerOf(req)],
            )
          ).rows.length
        )
          throw Error("配乐不存在");
        const now = new Date().toISOString(),
          p: VideoProject = {
            id: randomUUID(),
            visit_store_id: visit.id,
            visit_plan_id: visit.plan_id,
            visit_store_name: visit.name,
            visit_plan_name: visit.plan_name,
            visit_date: visit.date,
            brand_id: v.brand_id,
            product_id: v.product_id,
            brand_name: coupon.name,
            title: coupon.payload.name,
            seconds: v.seconds,
            target_seconds: v.seconds,
            assets,
            plan: [],
            state: "draft",
            progress: "等待开始",
            error: null,
            revision: 1,
            cost: 0,
            rights_confirmed: true,
            expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
            created_at: now,
            updated_at: now,
            music_id: v.music_id,
            production_options: v.production_options ?? {
              subtitles: false,
              narration: false,
              script: false,
              music: false,
            },
          };
        await db.query(
          "INSERT INTO video_projects(id,payload,owner_id) VALUES($1,$2,$3)",
          [p.id, JSON.stringify(p), ownerOf(req)],
        );
        try {
          res
            .status(201)
            .json({ project: visible(await enqueue(p.id, "analyze")) });
        } catch (error) {
          await db.query(
            "DELETE FROM video_projects WHERE id=$1 AND payload->>'state'='draft' AND point_charge_key IS NULL",
            [p.id],
          );
          throw error;
        }
      }),
    );
    app.get(
      "/api/v3/video-projects/:id/point-cost",
      wrap(async (req, res) => {
        const action = z
          .enum(["analyze", "remake", "preview", "export"])
          .parse(req.query.action);
        const p = await get(String(req.params.id));
        const row = (
          await db.query<{ point_paid_revision: number | null }>(
            "SELECT point_paid_revision FROM video_projects WHERE id=$1",
            [p.id],
          )
        ).rows[0];
        const existing =
          !p.captions_pending &&
          ((action === "preview" && p.preview_revision === p.revision) ||
            (action === "export" && p.export_revision === p.revision));
        const cost = existing
          ? 0
          : ["analyze", "remake"].includes(action) ||
              row?.point_paid_revision !== p.revision
            ? 50
            : 0;
        res.json({ cost, revision: p.revision });
      }),
    );
    app.get(
      "/api/v3/video-projects/:id",
      wrap(async (req, res) =>
        res.json({ project: visible(await get(String(req.params.id))) }),
      ),
    );
    app.post(
      "/api/v3/video-projects/:id/remake",
      wrap(async (req, res) => {
        const v = z
          .object({
            revision: z.number().int(),
            seconds: z.number().int().min(15).max(40).optional(),
            resource_ids: z.array(z.string().max(200)).max(40).optional(),
            upload_ids: z.array(uuid).max(40).optional(),
            production_options: productionOptionsSchema,
          })
          .parse(req.body);
        res.json({
          project: visible(
            await enqueue(
              String(req.params.id),
              "remake",
              v.production_options,
              v.revision,
              v,
            ),
          ),
        });
      }),
    );
    app.patch(
      "/api/v3/video-projects/:id/timeline",
      wrap(async (req, res) => {
        const p = await get(String(req.params.id));
        if (running(p.state)) throw Error("请等待当前任务结束");
        const v = z
          .object({ revision: z.number().int(), plan: planSchema })
          .parse(req.body);
        if (v.revision !== p.revision) throw Error("项目已更新，请刷新");
        validatePlan(v.plan, p.assets, p.seconds);
        p.plan = v.plan;
        p.captions_pending = false;
        p.revision++;
        p.state = "edited";
        p.error = null;
        await save(p);
        res.json({ project: visible(p) });
      }),
    );
    for (const action of ["analyze", "preview", "export"])
      app.post(
        `/api/v3/video-projects/:id/${action}`,
        wrap(async (req, res) => {
          const id = String(req.params.id),
            p = await get(id);
          if (action !== "analyze") validatePlan(p.plan, p.assets, p.seconds);
          if (
            !p.captions_pending &&
            ((action === "preview" && p.preview_revision === p.revision) ||
              (action === "export" && p.export_revision === p.revision))
          ) {
            res.json({ project: visible(p) });
            return;
          }
          res.json({ project: visible(await enqueue(id, action)) });
        }),
      );
    app.post(
      "/api/v3/video-projects/:id/cancel",
      wrap(async (req, res) => {
        let p = await get(String(req.params.id));
        if (running(p.state)) {
          if (activeId === p.id && child?.pid) {
            cancelled = true;
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
            await writeChain;
            p = await get(p.id);
          }
          p.state = "cancelled";
          p.progress = "已取消，分析结果保留";
          await save(p);
        }
        res.json({ project: visible(p) });
      }),
    );
    app.get(
      "/api/v3/video-projects/:id/media/:asset",
      wrap(async (req, res) => {
        const p = await get(String(req.params.id));
        const a = p.assets.find((x) => x.id === req.params.asset);
        if (!a?.path) throw Error("素材尚未准备完成");
        let bytes: Buffer;
        try {
          const file = await open(a.path, "r");
          try {
            const buffer = Buffer.alloc(64);
            const { bytesRead } = await file.read(buffer, 0, 64, 0);
            bytes = buffer.subarray(0, bytesRead);
          } finally {
            await file.close();
          }
        } catch (e: any) {
          if (e.code !== "ENOENT" || !storage) throw e;
          bytes = await storage.readPrefix(a.path);
        }
        const format = mediaFormat(bytes);
        const filename = `material-${a.id}.${format.extension}`;
        res.setHeader("Cache-Control", "private, no-store");
        if (await streamStored(req, res, a.path, filename, format.type, true))
          return;
        await stat(a.path);
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        res.type(format.type).sendFile(a.path);
      }),
    );
    app.get(
      "/api/v3/video-projects/:id/download",
      wrap(async (req, res) => {
        const p = await get(String(req.params.id)),
          kind = req.query.kind === "preview" ? "preview" : "export";
        validatePlan(p.plan, p.assets, p.seconds);
        const rev = kind === "preview" ? p.preview_revision : p.export_revision;
        if (rev !== p.revision) throw Error("请先生成当前版本");
        const file = join(root, p.id, `${kind}-${rev}.mp4`);
        res.setHeader("Cache-Control", "private, no-store");
        if (
          await streamStored(
            req,
            res,
            file,
            `food-${Math.round(p.seconds)}s-${kind}.mp4`,
            "video/mp4",
            req.query.inline === "1",
          )
        )
          return;
        await stat(file);
        if (req.query.inline === "1") res.type("mp4").sendFile(file);
        else res.download(file, `food-${Math.round(p.seconds)}s-${kind}.mp4`);
      }),
    );
    app.delete(
      "/api/v3/video-projects/:id",
      wrap(async (req, res) => {
        const p = await get(String(req.params.id));
        if (running(p.state)) throw Error("请先停止任务");
        if (storage) await storage.removeDirectory(join(root, p.id));
        else await rm(join(root, p.id), { recursive: true, force: true });
        await db.query("DELETE FROM video_projects WHERE id=$1", [p.id]);
        for (const id of [
          ...p.assets
            .filter((a) => a.path?.includes("/uploads/"))
            .map((a) => a.source_id),
          ...(p.music_id ? [p.music_id] : []),
        ])
          await removeUpload(id);
        res.json({ ok: true });
      }),
    );
  }
  return {
    register,
    stop: async () => {
      stopped = true;
      const current = child;
      const exited =
        current && current.exitCode === null && current.signalCode === null
          ? new Promise<void>((resolve) =>
              current.once("close", () => resolve()),
            )
          : Promise.resolve();
      if (child?.pid) {
        cancelled = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
      await exited;
      await writeChain;
    },
  };
}
