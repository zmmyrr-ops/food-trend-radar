import { createHash } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { createOpportunityBoard } from "./opportunity-board.js";

export const creatorSource = {
  status: "blocked_source" as const,
  reason:
    "尚无通过验证的自动视频搜索来源；选品会话不等于开放平台视频搜索权限。",
  documentation_url:
    "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/douyin-search-capability/aweme-dy-video-search",
  required_fields: [
    "视频唯一 ID",
    "稳定作者 ID（非昵称）",
    "发布时间",
    "采集时间",
    "视频正文/券关联证据",
    "当前券版本关联",
    "分页与检索覆盖说明",
  ],
  caveat:
    "搜索结果仅是已观察样本；翻完分页也不证明覆盖平台全部相关视频。未取得数据时人数、视频数与增速为空，不按零扣分。",
};
type Target = {
  brand_id: string;
  brand_name: string;
  product_id: string;
  revision: string;
  title: string;
  current_price_fen: number | null;
  current_price_max_fen: number | null;
  observed_at: string;
  disposition: string;
  kind: string;
};
export function creatorSearchPlan(target: Target) {
  const clean = (v: string) =>
    v
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const title = clean(target.title),
    brand = clean(target.brand_name);
  const price =
    target.current_price_fen !== null &&
    target.current_price_fen === target.current_price_max_fen
      ? `${(target.current_price_fen / 100)
          .toFixed(2)
          .replace(/\.00$/, "")
          .replace(/(\.\d)0$/, "$1")}元`
      : null;
  const terms = [
    `${brand} ${title} 上海`,
    ...(price ? [`${brand} ${title} ${price}`] : []),
  ];
  const queries = [...new Set(terms.map(clean))].map((keyword) => ({
    keyword,
    url: `https://www.douyin.com/search/${encodeURIComponent(keyword)}`,
  }));
  return {
    brand_id: target.brand_id,
    brand_name: target.brand_name,
    product_id: target.product_id,
    title: target.title,
    target_revision: target.revision,
    plan_id: createHash("sha256")
      .update(
        JSON.stringify([
          target.brand_id,
          target.product_id,
          target.revision,
          queries,
        ]),
      )
      .digest("hex"),
    observed_at: target.observed_at,
    status: "blocked_source" as const,
    queries,
    windows_hours: [24, 72],
    video_count: null,
    author_count: null,
    publish_growth: null,
    deduction: { low: 0, high: 30 },
    match_requirements: [
      "只提品牌不算同券",
      "标题和价格同时命中仍只算候选",
      "券关联、价格、套餐及限制须对应当前版本",
      "旧价格内容不借用为当前优惠的达人覆盖",
    ],
    price_mode: price ? "fixed" : "range_or_unknown",
  };
}
export function createCreatorSearch(
  candidates: Awaited<ReturnType<typeof createOpportunityBoard>>["candidates"],
) {
  async function read(brandId?: string) {
    const all = await candidates();
    const targets = all.filter(
      (x) =>
        x.disposition !== "dismissed" &&
        (!brandId || x.brand_id === brandId) &&
        [
          "price_drop",
          "quantity_increase",
          "first_observed",
          "terms_changed",
          "watched",
        ].includes(x.kind),
    );
    return {
      generated_at: new Date().toISOString(),
      source: creatorSource,
      total: targets.length,
      items: targets.map(creatorSearchPlan),
      automatic_collection: false,
    };
  }
  function register(app: Express) {
    app.get("/api/v3/creator-search", async (req, res) =>
      res.json(await read(z.uuid().optional().parse(req.query.brand_id))),
    );
  }
  return { read, register };
}
