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
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { inChannel } from "@radar/contracts";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";
import { mediaUrl } from "./coupon-media.js";
import { mediaFormat } from "./media-format.js";
import { createObjectStorage } from "./object-storage.js";
import {
  type Asset,
  planSchema,
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
  };
  const visible = (p: VideoProject) => ({
    ...p,
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
  async function enqueue(id: string, mode: string) {
    const p = await get(id);
    if (running(p.state)) return p;
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
      p.revision++;
      delete p.preview_revision;
      delete p.export_revision;
      p.plan = [];
    }
    p.state = "queued";
    p.error = null;
    p.progress = "等待视频处理";
    const claimed = await db.query(
      "UPDATE video_projects SET payload=$2 WHERE id=$1 AND payload->>'state' NOT IN ('queued','preparing','analyzing','planning','rendering_preview','rendering_export') RETURNING id",
      [id, JSON.stringify(p)],
    );
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
        res.status(400).json({
          error: {
            message:
              e instanceof z.ZodError
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
  function register(app: Express) {
    visits.register(app);
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
          `SELECT id FROM ${table} WHERE id=$1 AND owner_id=$2`,
          [req.params.id, ownerOf(req)],
        );
        if (!row.rows.length) {
          res.status(404).json({ error: { message: "项目或素材不存在" } });
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
          min_seconds: 12,
          max_seconds: 20,
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
            seconds: z.number().int().min(12).max(20),
            resource_ids: z.array(z.string().max(200)).max(40),
            upload_ids: z.array(uuid).max(40).default([]),
            music_id: uuid.optional(),
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
                `SELECT b.name,i.payload FROM coupon_items i JOIN brands b ON b.id=i.brand_id WHERE i.brand_id=$1 AND i.product_id=$2 AND i.payload->>'identity'='name_match' ORDER BY i.observed_at DESC LIMIT 1`,
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
            assets,
            plan: [],
            state: "draft",
            progress: "等待开始",
            error: null,
            revision: 1,
            cost: 0,
            rights_confirmed: true,
            created_at: now,
            updated_at: now,
            music_id: v.music_id,
          };
        await db.query(
          "INSERT INTO video_projects(id,payload,owner_id) VALUES($1,$2,$3)",
          [p.id, JSON.stringify(p), ownerOf(req)],
        );
        res
          .status(201)
          .json({ project: visible(await enqueue(p.id, "analyze")) });
      }),
    );
    app.get(
      "/api/v3/video-projects/:id",
      wrap(async (req, res) =>
        res.json({ project: visible(await get(String(req.params.id))) }),
      ),
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
        const remote = await storage?.signedUrl(a.path, filename, {
          inline: true,
          contentType: format.type,
        });
        res.setHeader("Cache-Control", "private, no-store");
        if (remote) {
          res.redirect(302, remote);
          return;
        }
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
        const remote = await storage?.signedUrl(
          file,
          `food-${p.seconds}s-${kind}.mp4`,
          { inline: req.query.inline === "1", contentType: "video/mp4" },
        );
        res.setHeader("Cache-Control", "private, no-store");
        if (remote) {
          res.redirect(302, remote);
          return;
        }
        await stat(file);
        if (req.query.inline === "1") res.type("mp4").sendFile(file);
        else res.download(file, `food-${p.seconds}s-${kind}.mp4`);
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
