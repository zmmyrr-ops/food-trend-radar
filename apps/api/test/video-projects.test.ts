import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "../src/db.js";
import { createVideoProjects } from "../src/video-projects.js";
import {
  type Asset,
  adaptivePlan,
  automaticPlan,
  validatePlan,
} from "../src/video-types.js";

const assets = () =>
  Array.from({ length: 8 }, (_, i) => ({
    id: randomUUID(),
    source_id: String(i),
    path: "/private/file.mp4",
    title: "食品",
    author: "作者",
    note_url: "",
    kind: "video" as const,
    duration: 3,
    accepted: true,
    score: 90 - i,
    best_start: 0,
    best_end: 3,
    tags: [String(i % 3)],
  }));
test("自动编排达到目标时长，不循环素材，不接受未知资源和越界时间", () => {
  const a = assets();
  for (const seconds of [12, 15, 18, 20]) {
    const plan = automaticPlan(a, seconds);
    assert.equal(
      plan.reduce((n, c) => n + c.duration, 0),
      seconds,
    );
    assert.equal(new Set(plan.map((c) => c.asset_id)).size, plan.length);
    assert.equal(validatePlan(plan, a, seconds), plan);
  }
  assert.throws(() => automaticPlan(a.slice(0, 3), 18), /不足/);
  const p = automaticPlan(a, 18);
  assert.throws(
    () =>
      validatePlan([{ ...p[0], asset_id: randomUUID() }, ...p.slice(1)], a, 18),
    /不可用/,
  );
  assert.throws(
    () => validatePlan([{ ...p[0], start: 2 }, ...p.slice(1)], a, 18),
    /超出/,
  );
  assert.throws(() => validatePlan(p, a, 20), /时长/);
});
test("工作室不接受客户端任意远程URL；授权缺失拒绝创建；上传大小与类型检查", async () => {
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(), "video-test-"));
  const service = await createVideoProjects(db, dir);
  const app = express();
  app.use(express.json());
  service.register(app);
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const bad = await fetch(url + "/api/v3/video-projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_id: randomUUID(),
        product_id: "a",
        seconds: 18,
        resource_ids: [],
        rights_confirmed: false,
        url: "http://127.0.0.1",
      }),
    });
    assert.equal(bad.status, 400);
    const upload = await fetch(url + "/api/v3/video-assets", {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: Buffer.alloc(200),
    });
    assert.equal(upload.status, 200);
    const u = await upload.json();
    assert.equal(u.kind, "image");
    const config = await (
      await fetch(url + "/api/v3/video-projects/config")
    ).json();
    assert.equal(config.configured, false);
    assert.ok(!JSON.stringify(config).includes("api_key"));
  } finally {
    await service.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("编辑时间线采用修订号，过期版本不能覆盖；重启标记中断并保留已分析资产", async () => {
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(), "video-revision-"));
  let service = await createVideoProjects(db, dir);
  const a = assets(),
    id = randomUUID(),
    p = {
      id,
      brand_id: randomUUID(),
      product_id: "coupon",
      brand_name: "品牌",
      title: "券",
      seconds: 18,
      assets: a,
      plan: automaticPlan(a, 18),
      state: "analyzing",
      progress: "处理中",
      error: null,
      revision: 1,
      cost: 0.1,
      rights_confirmed: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  await db.query("INSERT INTO video_projects(id,payload) VALUES($1,$2)", [
    id,
    JSON.stringify(p),
  ]);
  await service.stop();
  service = await createVideoProjects(db, dir);
  const app = express();
  app.use(express.json());
  service.register(app);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/video-projects/${id}`;
  try {
    const library = await (
      await fetch(url.slice(0, url.lastIndexOf("/")))
    ).json();
    assert.equal(library.items.length, 1);
    assert.equal(library.items[0].id, id);
    assert.equal(library.items[0].brand_id, p.brand_id);
    assert.equal(library.items[0].assets, undefined);
    assert.ok(!JSON.stringify(library).includes("/private/file"));
    const recovered = (await (await fetch(url)).json()).project;
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.assets.length, 8);
    assert.ok(!JSON.stringify(recovered).includes("/private/file"));
    const send = (revision: number) =>
      fetch(url + "/timeline", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, plan: p.plan }),
      });
    assert.equal((await send(1)).status, 200);
    assert.equal((await send(1)).status, 400);
    assert.equal((await fetch(url + "/download")).status, 400);
  } finally {
    await service.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("真实FFmpeg渲染：18秒、竖屏、字幕、无素材音轨，生成可解码MP4", {
  timeout: 90000,
}, async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { writeFile, mkdir, readFile } = await import("node:fs/promises");
  const ffmpeg = require("ffmpeg-static") as string,
    probe = require("ffprobe-static").path as string;
  const dir = await mkdtemp(join(tmpdir(), "video-render-"));
  const root = join(dir, "videos"),
    job = join(root, "job");
  await mkdir(job, { recursive: true });
  try {
    const source = join(job, "source.mp4");
    await exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x568:r=30",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-y",
      source,
    ]);
    const a = assets()
      .slice(0, 6)
      .map((x, i) => ({
        ...x,
        path: source,
        ...(i % 2 === 0 ? { width: 320, height: 568 } : {}),
      }));
    const plan = automaticPlan(a, 18);
    plan[0].caption = "Render test";
    await writeFile(
      join(job, "input.json"),
      JSON.stringify({ assets: a, plan, seconds: 18, revision: 1, cost: 0 }),
    );
    await exec(
      process.execPath,
      [
        (await import("node:url")).fileURLToPath(
          new URL("../dist/video-worker.js", import.meta.url),
        ),
        job,
        "preview",
        root,
      ],
      {
        env: { ...process.env, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: probe },
        timeout: 80000,
      },
    );
    const output = join(job, "preview-1.mp4");
    const info = JSON.parse(
      (
        await exec(probe, [
          "-v",
          "quiet",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          output,
        ])
      ).stdout,
    );
    assert.equal(info.streams[0].width, 720);
    assert.equal(info.streams[0].height, 1280);
    assert.ok(Math.abs(Number(info.format.duration) - 18) < 0.04);
    assert.equal(info.streams.length, 1);
    assert.ok((await readFile(output)).length > 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("素材不足目标时长时自动缩短，12秒可生成，不足12秒拒绝", () => {
  const a = assets();
  assert.equal(adaptivePlan(a, 18).seconds, 18);
  const four = a.slice(0, 4);
  const fitted = adaptivePlan(four, 18);
  assert.equal(fitted.seconds, 12);
  assert.equal(validatePlan(fitted.plan, four, 12), fitted.plan);
  assert.equal(new Set(fitted.plan.map((c) => c.asset_id)).size, 4);
  const five = a
    .slice(0, 5)
    .map((a) => ({ ...a, best_end: 2.7, duration: 2.7 }));
  assert.equal(adaptivePlan(five, 20).seconds, 13);
  assert.throws(() => adaptivePlan(a.slice(0, 3), 18), /不足12秒/);
});

test("最终剪辑保留AI镜头顺序，不再被分数和标签重新排序", () => {
  const a = assets().reverse();
  const plan = automaticPlan(a, 18, true);
  assert.deepEqual(
    plan.map((c) => c.asset_id),
    a.slice(0, 6).map((a) => a.id),
  );
});
