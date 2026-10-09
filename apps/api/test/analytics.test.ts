import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createAnalytics } from "../src/analytics.js";
import { openDatabase } from "../src/db.js";

test("analytics batches, deduplicates, rejects spoofed payloads and protects dashboard", async () => {
  const db = await openDatabase();
  await db.exec(
    "CREATE TABLE point_entries(owner_id uuid,amount int,reason text,hidden boolean,created_at timestamptz DEFAULT now())",
  );
  const a = createAnalytics(db),
    owner = randomUUID(),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization)
      res.locals.account = {
        id: owner,
        role: req.headers.authorization === "admin" ? "admin" : "member",
      };
    next();
  });
  a.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const event = {
    id: randomUUID(),
    name: "page_view",
    page: "studio",
    channel: "web",
  };
  const send = (auth: string, events: any[]) =>
    fetch(base + "/api/v3/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: auth },
      body: JSON.stringify({ events }),
    });
  try {
    assert.equal((await send("", [event])).status, 401);
    assert.equal(
      (await send("user", [{ ...event, owner_id: randomUUID() }])).status,
      400,
    );
    assert.equal((await send("user", [event, event])).status, 202);
    await a.flush();
    assert.equal(
      (await db.query<any>("SELECT count(*)::int AS n FROM business_events"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await fetch(base + "/api/v3/analytics", {
          headers: { authorization: "user" },
        })
      ).status,
      403,
    );
    await db.query(
      "INSERT INTO point_entries(owner_id,amount,reason,hidden) VALUES($1,-20,'品牌加速',false),($1,20,'品牌加速退回',false)",
      [owner],
    );
    const stats = await (
      await fetch(base + "/api/v3/analytics?days=7", {
        headers: { authorization: "admin" },
      })
    ).json();
    assert.equal(stats.overview.pv, 1);
    assert.equal(stats.overview.uv, 1);
    assert.equal(stats.points.spent, 20);
    assert.equal(stats.points.granted, 20);
    assert.equal(
      (
        await send(
          "user",
          Array.from({ length: 31 }, () => event),
        )
      ).status,
      400,
    );
  } finally {
    a.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
