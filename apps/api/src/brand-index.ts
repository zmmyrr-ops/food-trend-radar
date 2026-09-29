import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";

const day = z.iso.date();
export const indexSchema = z
  .object({
    brand_id: z.uuid(),
    keyword: z.string().trim().min(1).max(100),
    source: z.literal("baidu_web"),
    region: z.literal("上海"),
    device: z.literal("PC+移动"),
    metric: z.literal("search_index_7d_summary"),
    status: z.enum(["available", "not_indexed"]),
    period_start: day,
    period_end: day,
    observed_at: z.iso.datetime({ offset: true }),
    daily_average: z.number().finite().nonnegative().nullable(),
    mom: z.number().finite().min(-1).nullable(),
    source_url: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && u.hostname === "index.baidu.com";
    }),
  })
  .strict()
  .superRefine((x, ctx) => {
    if (Date.parse(x.period_end) - Date.parse(x.period_start) !== 6 * 86400000)
      ctx.addIssue({ code: "custom", message: "必须为连续7日概览" });
    const localDay = new Date(Date.parse(x.observed_at) + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (x.period_end >= localDay || Date.parse(x.observed_at) > Date.now())
      ctx.addIssue({ code: "custom", message: "不接受未来或未结束的统计窗口" });
    if (
      x.status === "available"
        ? x.daily_average === null || x.mom === null
        : x.daily_average !== null || x.mom !== null
    )
      ctx.addIssue({
        code: "custom",
        message: "未收录不得填零，已收录需有完整概览",
      });
  });
export type BrandIndex = z.infer<typeof indexSchema>;
export function indexAvailable(x: BrandIndex, now = Date.now()) {
  const end = Date.parse(`${x.period_end}T23:59:59+08:00`),
    at = Date.parse(x.observed_at);
  return (
    x.status === "available" &&
    at <= now &&
    now - at <= 72 * 3600000 &&
    end <= now &&
    now - end <= 72 * 3600000
  );
}
export async function createBrandIndex(db: PGlite) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS brand_index_observations(brand_id uuid NOT NULL REFERENCES brands(id),keyword text NOT NULL,period_end date NOT NULL,observed_at timestamptz NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(brand_id,keyword,period_end))`,
  );
  async function save(raw: unknown) {
    const x = indexSchema.parse(raw);
    await db.query(
      `INSERT INTO brand_index_observations VALUES($1,$2,$3,$4,$5) ON CONFLICT(brand_id,keyword,period_end) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload WHERE excluded.observed_at>=brand_index_observations.observed_at`,
      [x.brand_id, x.keyword, x.period_end, x.observed_at, JSON.stringify(x)],
    );
    return x;
  }
  async function read() {
    return (
      await db.query<{ payload: BrandIndex }>(
        `SELECT DISTINCT ON(brand_id) payload FROM brand_index_observations ORDER BY brand_id,period_end DESC,observed_at DESC,keyword`,
      )
    ).rows.map((x) => x.payload);
  }
  function register(app: Express) {
    app.get("/api/v3/brand-indices", async (_req, res) =>
      res.json({
        items: (await read()).map((x) => ({ ...x, usable: indexAvailable(x) })),
        collection_mode: "browser_observed",
        unattended_collection: false,
      }),
    );
    app.post("/api/v3/brand-indices", async (req, res) => {
      const parsed = indexSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: { message: "指数口径或数据不完整" } });
      const found = await db.query(
        "SELECT 1 FROM brands WHERE id=$1 AND active",
        [parsed.data.brand_id],
      );
      if (!found.rows.length)
        return res
          .status(404)
          .json({ error: { message: "品牌不存在或未启用" } });
      res.json(await save(parsed.data));
    });
  }
  return { save, read, register };
}
