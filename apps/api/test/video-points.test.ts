import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createAccounts } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";
import { changePoints } from "../src/points.js";
import { createVideoProjects } from "../src/video-projects.js";

test("video charges once, cancel/startup refund, insufficient balance rolls back queue", async () => {
  const db = await openDatabase();
  await createAccounts(db, {});
  const owner = randomUUID(),
    id = randomUUID();
  await db.query("INSERT INTO accounts(id,phone) VALUES($1,'13800007890')", [
    owner,
  ]);
  await db.transaction((tx) => changePoints(tx, owner, 100, "seed", "seed"));
  const dir = await mkdtemp(join(tmpdir(), "video-points-"));
  let svc = await createVideoProjects(db, dir);
  await svc.stop();
  const p = {
    id,
    brand_id: "",
    product_id: "",
    revision: 1,
    assets: [],
    plan: [],
    rights_confirmed: true,
    state: "draft",
    seconds: 15,
  };
  await db.query(
    "INSERT INTO video_projects(id,payload,owner_id) VALUES($1,$2,$3)",
    [id, JSON.stringify(p), owner],
  );
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    (req as any).account = { id: owner };
    res.locals.account = { id: owner, role: "user" };
    next();
  });
  svc.register(app);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v3/video-projects/${id}`;
  const post = (action: string) =>
    fetch(url + "/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  const balance = async () =>
    (
      await db.query<{ balance: number }>(
        "SELECT balance FROM point_wallets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].balance;
  try {
    const results = await Promise.all([post("analyze"), post("analyze")]);
    assert.ok(results.every((r) => r.ok));
    assert.equal(await balance(), 50);
    assert.equal((await post("cancel")).status, 200);
    assert.equal(await balance(), 100);
    await post("cancel");
    assert.equal(await balance(), 100);
    await post("analyze");
    assert.equal(await balance(), 50);
    svc = await createVideoProjects(db, dir);
    await svc.stop();
    assert.equal(await balance(), 100);
    svc = await createVideoProjects(db, dir);
    await svc.stop();
    assert.equal(await balance(), 100);
    await db.query("UPDATE point_wallets SET balance=10 WHERE owner_id=$1", [
      owner,
    ]);
    assert.equal((await post("analyze")).status, 402);
    assert.equal(await balance(), 10);
    const state = (
      await db.query<any>("SELECT payload FROM video_projects WHERE id=$1", [
        id,
      ])
    ).rows[0].payload.state;
    assert.equal(state, "interrupted");
  } finally {
    await svc.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
