import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";

type Event = {
  id: string;
  owner_id: string | null;
  name: string;
  page: string;
  channel: string;
  status: number | null;
  duration_ms: number | null;
  occurred_at: string;
};
const sinks = new WeakMap<PGlite, (event: Event) => void>();
export function recordBusinessOutcome(
  db: PGlite,
  owner: string,
  name: string,
  key: string,
  success: boolean,
) {
  try {
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    sinks.get(db)?.({
      id,
      owner_id: owner,
      name,
      page: "studio",
      channel: "server",
      status: success ? 200 : 500,
      duration_ms: null,
      occurred_at: new Date().toISOString(),
    });
  } catch {
    /* Telemetry must never interrupt the business operation. */
  }
}
export function createAnalytics(db: PGlite) {
  const ready =
    db.exec(`CREATE TABLE IF NOT EXISTS business_events(id uuid PRIMARY KEY,owner_id uuid,name text NOT NULL,page text NOT NULL,channel text NOT NULL,status int,duration_ms int,occurred_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS business_events_time ON business_events(occurred_at);
    CREATE INDEX IF NOT EXISTS business_events_owner_time ON business_events(owner_id,occurred_at);`);
  let queue: Event[] = [],
    writing = false,
    dropped = 0,
    lastCleanup = 0;
  function enqueue(event: Event) {
    if (queue.length >= 10000) {
      dropped++;
      return;
    }
    queue.push(event);
  }
  sinks.set(db, enqueue);
  async function flush() {
    if (writing) return;
    writing = true;
    const batch = queue.splice(0, 500);
    try {
      await ready;
      if (batch.length)
        await db.query(
          `INSERT INTO business_events SELECT * FROM jsonb_to_recordset($1) AS x(id uuid,owner_id uuid,name text,page text,channel text,status int,duration_ms int,occurred_at timestamptz) ON CONFLICT DO NOTHING`,
          [JSON.stringify(batch)],
        );
      if (Date.now() - lastCleanup > 3600000) {
        await db.query(
          "DELETE FROM business_events WHERE occurred_at<now()-interval '90 days'",
        );
        lastCleanup = Date.now();
      }
    } catch {
      queue = [...batch, ...queue].slice(0, 10000);
      console.warn("analytics batch deferred");
    } finally {
      writing = false;
    }
  }
  const timer = setInterval(() => void flush(), 10000);
  timer.unref();
  function observe(app: Express) {
    app.use((req, res, next) => {
      const start = Date.now(),
        path = req.path.replace(/^\/api\/mini\//, "/api/v3/");
      const match = path.match(
        /^\/api\/(?:v3\/)?(auth|member|mini|coupon-picks|coupons|coupon-media|video-projects|video-assets|visit-plans|visit-stores|maps|shop-reports|brand-subscriptions|brand-blacklist|brand-boost|studio-copy|topic-plays|ai-recommendations)(?:\/|$)/,
      );
      if (
        !path.includes("/analytics") &&
        match &&
        (!["GET", "HEAD"].includes(req.method) || /download|summary/.test(path))
      ) {
        // No query strings, request bodies, cookies, phone numbers or generated text.
        const suffix = path
          .split("/")
          .filter((x) =>
            [
              "login",
              "register",
              "logout",
              "password",
              "preview",
              "export",
              "generate",
              "render",
              "download",
              "text",
              "review",
              "complete",
              "read",
              "messages",
              "summary",
              "analyze",
              "cancel",
              "invitation",
              "daily-login",
              "sms",
            ].includes(x),
          )
          .join(".");
        res.once("finish", () =>
          enqueue({
            id: randomUUID(),
            owner_id: res.locals.account?.id || null,
            name: `${req.method}.${match[1]}${suffix ? "." + suffix : ""}${match[1] === "studio-copy" && ["titles", "topics"].includes(req.body?.kind) ? "." + req.body.kind : ""}`,
            page: match[1],
            channel:
              req.headers["x-client-channel"] === "mini" ? "mini" : "web",
            status: res.statusCode,
            duration_ms: Math.min(Date.now() - start, 2147483647),
            occurred_at: new Date().toISOString(),
          }),
        );
      }
      next();
    });
  }
  const eventSchema = z
    .object({
      id: z.uuid(),
      name: z.enum([
        "page_view",
        "coupon_search",
        "coupon_filter",
        "coupon_sort",
      ]),
      page: z.string().regex(/^[a-z0-9_/-]{1,60}$/),
      channel: z.enum(["web", "mini"]).default("web"),
    })
    .strict();
  const limits = new Map<string, { at: number; count: number }>();
  function register(app: Express) {
    app.post("/api/v3/analytics/events", (req, res) => {
      const owner = res.locals.account?.id;
      if (!owner) return res.sendStatus(401);
      const parsed = z
        .object({ events: z.array(eventSchema).max(30) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: { message: "埋点格式不正确" } });
      const now = Date.now(),
        old = limits.get(owner),
        limit = old && now - old.at < 60000 ? old : { at: now, count: 0 };
      if (limit.count + parsed.data.events.length > 300)
        return res.status(429).json({ error: { message: "上报频率过高" } });
      limit.count += parsed.data.events.length;
      limits.set(owner, limit);
      if (limits.size > 5000)
        for (const [key, v] of limits)
          if (now - v.at > 60000) limits.delete(key);
      for (const event of parsed.data.events)
        enqueue({
          ...event,
          owner_id: owner,
          status: null,
          duration_ms: null,
          occurred_at: new Date().toISOString(),
        });
      res.status(202).json({ accepted: parsed.data.events.length });
    });
    app.get("/api/v3/analytics", async (req, res) => {
      if (res.locals.account?.role !== "admin") return res.sendStatus(403);
      await ready;
      const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(90)
        .default(7)
        .parse(req.query.days);
      const since =
        "occurred_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') - (($1::int-1)*interval '1 day')";
      const overview = (
        await db.query(
          `SELECT count(*) FILTER(WHERE name='page_view')::int AS pv,count(DISTINCT owner_id) FILTER(WHERE name='page_view')::int AS uv,count(*) FILTER(WHERE status IS NOT NULL)::int AS operations,count(*) FILTER(WHERE status>=400)::int AS failures FROM business_events WHERE ${since}`,
          [days],
        )
      ).rows[0];
      const daily = (
        await db.query(
          `SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,count(*) FILTER(WHERE name='page_view')::int AS pv,count(DISTINCT owner_id) FILTER(WHERE name='page_view')::int AS uv FROM business_events WHERE ${since} GROUP BY 1 ORDER BY 1`,
          [days],
        )
      ).rows;
      const events = (
        await db.query(
          `SELECT name,page,channel,count(*)::int AS count,count(DISTINCT owner_id)::int AS users,count(*) FILTER(WHERE status>=400)::int AS failures,round(avg(duration_ms)) AS avg_ms FROM business_events WHERE ${since} GROUP BY name,page,channel ORDER BY count(*) DESC LIMIT 150`,
          [days],
        )
      ).rows;
      // Financial totals always come from the authoritative ledger, never client events.
      const pointWhere =
        "created_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') - (($1::int-1)*interval '1 day')";
      const points = (
        await db.query(
          `SELECT coalesce(sum(-amount) FILTER(WHERE amount<0),0)::int AS spent,coalesce(sum(amount) FILTER(WHERE amount>0),0)::int AS granted,count(DISTINCT owner_id) FILTER(WHERE amount<0)::int AS spenders FROM point_entries WHERE ${pointWhere}`,
          [days],
        )
      ).rows[0];
      const pointReasons = (
        await db.query(
          `SELECT split_part(reason,'：',1) AS reason,count(*)::int AS count,sum(amount)::int AS amount FROM point_entries WHERE ${pointWhere} GROUP BY 1 ORDER BY count(*) DESC LIMIT 50`,
          [days],
        )
      ).rows;
      const pointDetails = (
        await db.query(
          `SELECT owner_id,amount,reason,hidden,created_at FROM point_entries WHERE ${pointWhere} ORDER BY created_at DESC LIMIT 100`,
          [days],
        )
      ).rows;
      res.json({
        overview,
        daily,
        events,
        points,
        pointReasons,
        pointDetails,
        queued: queue.length,
        dropped,
        days,
      });
    });
  }
  return {
    observe,
    register,
    flush,
    stop() {
      clearInterval(timer);
    },
    enqueue,
  };
}
