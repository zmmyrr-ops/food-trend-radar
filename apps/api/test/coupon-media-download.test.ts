import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createCouponMedia } from "../src/coupon-media.js";

test("material download restricts lookup to current owner and rejects foreign resources", async () => {
  const queries: unknown[][] = [];
  const db = {
    exec: async () => {},
    query: async (_sql: string, params: unknown[]) => {
      queries.push(params);
      return { rows: [] };
    },
  };
  const media = await createCouponMedia(db as any, "/unused");
  const app = express();
  app.use((req, _res, next) => {
    (req as any).account = { id: "owner-a" };
    next();
  });
  media.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v3/coupon-media/download?brand_id=11111111-1111-4111-8111-111111111111&product_id=coupon&resource_id=foreign`,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(queries[0], [
      "11111111-1111-4111-8111-111111111111",
      "coupon",
      "owner-a",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
