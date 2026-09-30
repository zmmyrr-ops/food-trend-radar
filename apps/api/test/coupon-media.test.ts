import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  couponMediaTerms,
  createCouponMedia,
  extractLiveResources,
  mediaUrl,
  rankCouponResource,
} from "../src/coupon-media.js";
import { openDatabase } from "../src/db.js";

const search = "https://so.xiaohongshu.com/api/sns/web/v2/search/notes",
  detail = "https://edith.xiaohongshu.com/api/sns/web/v1/feed";
function response(id: string, count = 11) {
  return {
    code: 0,
    success: true,
    data: {
      items: [
        {
          id,
          note_card: {
            title: "品牌甲 套餐实况",
            desc: "探店",
            user: { nickname: "作者" },
            image_list: Array.from({ length: count }, (_, i) => ({
              file_id: `${id}-${i}`,
              live_photo: true,
              url_default: "http://sns-webpic-qc.xhscdn.com/p.jpg",
              stream: {
                EF4: [
                  {
                    master_url: `http://sns-video-v6.xhscdn.com/${id}-${i}.mp4?sign=test`,
                  },
                ],
              },
            })),
          },
        },
      ],
    },
  };
}
test("只接受关联品牌的实况视频，媒体URL限制CDN且升级HTTPS", () => {
  assert.equal(mediaUrl("https://xhscdn.com.evil.test/a.mp4"), "");
  assert.equal(mediaUrl("javascript:alert(1)"), "");
  assert.equal(mediaUrl("http://127.0.0.1/a"), "");
  const r = extractLiveResources(response("abc"), "abc", "token", ["品牌甲"]);
  assert.equal(r.length, 11);
  assert.match(r[0].video_url, /^https:/);
  assert.equal(
    extractLiveResources(response("abc"), "abc", "token", ["其他品牌"]).length,
    0,
  );
  const raw = response("abc");
  raw.data.items[0].note_card.image_list[0].live_photo = false;
  assert.equal(
    extractLiveResources(raw, "abc", "token", ["品牌甲"]).length,
    10,
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-media-"));
  const path = join(dir, "requests.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        url: search,
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      {
        url: detail,
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ]),
  );
  const db = await openDatabase();
  const brand = randomUUID(),
    run = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','media-fixture','火锅','https://example.com')",
    [brand],
  );
  await db.query(
    "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'coupon',$3)",
    [run, brand, JSON.stringify({ name: "双人套餐", identity: "name_match" })],
  );
  return {
    db,
    brand,
    path,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("重复点击复用任务，串行获取到40即停止，成功缓存不再请求", async () => {
  const f = await fixture();
  let requests = 0,
    active = 0,
    peak = 0;
  const delays: number[] = [];
  const starts: number[] = [];
  const service = await createCouponMedia(f.db, f.path, {
    wait: async (ms) => {
      delays.push(ms);
    },
    transport: async (url, _headers, body) => {
      requests++;
      starts.push(Date.now());
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (url === search)
        return {
          code: 0,
          success: true,
          data: {
            has_more: true,
            items: Array.from({ length: 20 }, (_, i) => ({
              model_type: "note",
              id: `note${i}`,
              xsec_token: "token",
            })),
          },
        };
      return response(JSON.parse(body).source_note_id);
    },
  });
  try {
    const first = await service.start(f.brand, "coupon");
    const second = await service.start(f.brand, "coupon");
    assert.equal(first.id, second.id);
    await service.drain();
    const job = (await f.db.query<any>("SELECT * FROM coupon_media_jobs"))
      .rows[0];
    assert.equal(job.state, "complete");
    assert.equal(job.resources.length, 40);
    assert.equal(job.inspected, 4);
    assert.equal(requests, 5);
    assert.equal(peak, 1);
    assert.ok(delays.every((ms) => ms >= 0 && ms <= 5000));
    assert.ok(
      starts
        .slice(1)
        .every((at, index) => at - starts[index] + delays[index + 1] >= 2990),
    );
    await service.start(f.brand, "coupon");
    await service.drain();
    assert.equal(requests, 5);
    await service.start(f.brand, "coupon", true);
    await service.drain();
    const more = (await f.db.query<any>("SELECT * FROM coupon_media_jobs"))
      .rows[0];
    assert.equal(more.resources.length, 60);
    assert.deepEqual(more.resources.slice(0, 40), job.resources);
    assert.equal(new Set(more.resources.map((x: any) => x.id)).size, 60);
    assert.equal(more.next_page, 1); // Consume the remaining items of this page first.
    assert.equal(peak, 1);
    await service.start(f.brand, "coupon", true);
    await service.drain();
    const third = (await f.db.query<any>("SELECT * FROM coupon_media_jobs"))
      .rows[0];
    assert.equal(third.resources.length, 80);
    assert.equal(new Set(third.resources.map((x: any) => x.id)).size, 80);
  } finally {
    await service.stop();
    await f.cleanup();
  }
});
test("授权失败后不反复请求，不把错误当作无素材", async () => {
  const f = await fixture();
  let requests = 0;
  const service = await createCouponMedia(f.db, f.path, {
    wait: async () => {},
    transport: async () => {
      requests++;
      return { success: false, code: -100 };
    },
  });
  try {
    await service.start(f.brand, "coupon");
    await service.drain();
    const job = (await f.db.query<any>("SELECT * FROM coupon_media_jobs"))
      .rows[0];
    assert.equal(job.state, "failed");
    assert.equal(job.error_code, "AUTH_EXPIRED");
    await f.db.exec(
      "UPDATE coupon_media_jobs SET updated_at=now()-interval '2 minutes'",
    );
    await service.start(f.brand, "coupon");
    await service.drain();
    assert.equal(requests, 1);
    await service.start(f.brand, "coupon", false, true);
    await service.drain();
    assert.equal(requests, 1); // 重置不解除账号失效或风控闸门。
  } finally {
    await service.stop();
    await f.cleanup();
  }
});

test("等待间隔时取消，不再发下一次详情请求", async () => {
  const f = await fixture();
  let waits = 0,
    requests = 0;
  const service = await createCouponMedia(f.db, f.path, {
    wait: async () => {
      if (++waits === 2)
        await f.db.exec(
          "UPDATE coupon_media_jobs SET state='cancelled' WHERE state='running'",
        );
    },
    transport: async () => {
      requests++;
      return {
        code: 0,
        success: true,
        data: {
          has_more: false,
          items: [{ model_type: "note", id: "note", xsec_token: "token" }],
        },
      };
    },
  });
  try {
    await service.start(f.brand, "coupon");
    await service.drain();
    assert.equal(requests, 1);
    assert.equal(
      (await f.db.query<any>("SELECT state FROM coupon_media_jobs")).rows[0]
        .state,
      "cancelled",
    );
  } finally {
    await service.stop();
    await f.cleanup();
  }
});

test("仅搜索品牌；重置绕过失效详情缓存与耗尽状态，保持其他券素材", async () => {
  const f = await fixture();
  const queries: any[] = [];
  let details = 0;
  const service = await createCouponMedia(f.db, f.path, {
    wait: async () => {},
    transport: async (url, _headers, body) => {
      if (url === search) {
        queries.push(JSON.parse(body));
        return {
          success: true,
          code: 0,
          data: {
            has_more: false,
            items: [{ model_type: "note", id: "same", xsec_token: "token" }],
          },
        };
      }
      const raw = response("same", 2);
      for (const image of raw.data.items[0].note_card.image_list)
        image.stream.EF4[0].master_url += `&generation=${++details}`;
      return raw;
    },
  });
  try {
    const first = await service.start(f.brand, "coupon");
    await service.drain();
    const before = (await f.db.query<any>("SELECT * FROM coupon_media_jobs"))
      .rows[0];
    assert.equal(before.exhausted, true);
    await f.db.query(
      "INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,resources) VALUES($1,$2,'other','品牌甲','[]','complete',$3)",
      [randomUUID(), f.brand, JSON.stringify(before.resources)],
    );
    const reset = await service.start(f.brand, "coupon", false, true);
    assert.notEqual(reset.id, first.id);
    assert.equal(reset.resources.length, 0);
    assert.equal(reset.next_page, 1);
    assert.equal(reset.exhausted, false);
    await service.drain();
    const after = (
      await f.db.query<any>(
        "SELECT * FROM coupon_media_jobs WHERE product_id='coupon'",
      )
    ).rows[0];
    assert.equal(details, 4);
    assert.notEqual(
      after.resources[0].video_url,
      before.resources[0].video_url,
    );
    assert.deepEqual(
      queries.map((q) => q.keyword),
      ["品牌甲", "品牌甲"],
    );
    assert.deepEqual(
      queries.map((q) => q.page),
      [1, 1],
    );
    assert.notEqual(queries[0].search_id, queries[1].search_id);
    assert.deepEqual(
      (
        await f.db.query<any>(
          "SELECT resources FROM coupon_media_jobs WHERE product_id='other'",
        )
      ).rows[0].resources,
      before.resources,
    );
    await f.db.exec(
      "UPDATE coupon_media_jobs SET state='running' WHERE product_id='coupon'",
    );
    await assert.rejects(
      service.start(f.brand, "coupon", false, true),
      /JOB_RUNNING/,
    );
  } finally {
    await service.stop();
    await f.cleanup();
  }
});

test("券线索过滤金额/品牌/营销词，不把代金券当具体商品", () => {
  assert.deepEqual(
    couponMediaTerms("品牌甲【国庆】100元代金券【买单专用】", ["品牌甲"]),
    [],
  );
  assert.ok(
    couponMediaTerms("品牌甲双拼奶昔2选1", ["品牌甲"]).includes("奶昔"),
  );
  assert.ok(
    couponMediaTerms("品牌甲轮滑体验三节课", ["品牌甲"]).includes("轮滑"),
  );
  const item = extractLiveResources(response("a", 1), "a", "t", ["品牌甲"])[0];
  assert.equal(
    rankCouponResource({ ...item, note_text: "这次尝了奶昔" }, ["奶昔"])
      .relevance,
    "coupon",
  );
  assert.equal(
    rankCouponResource({ ...item, note_text: "这次尝了奶昔" }, ["轮滑"])
      .relevance,
    "brand",
  );
});

test("泛品牌素材先出现也不抢满名额；正文券线索优先，不足才补通用，追加不重复", async () => {
  const f = await fixture();
  let active = 0,
    peak = 0;
  const keywords: string[] = [];
  await f.db.exec(
    "UPDATE coupon_items SET payload=jsonb_set(payload,'{name}','\"品牌甲奶昔\"')",
  );
  const service = await createCouponMedia(f.db, f.path, {
    wait: async () => {},
    transport: async (url, _h, body) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      const q = JSON.parse(body);
      if (url === search) {
        keywords.push(q.keyword);
        return {
          success: true,
          code: 0,
          data: {
            has_more: false,
            items: ["generic", "related"].map((id) => ({
              id,
              model_type: "note",
              xsec_token: "t",
              note_card: { display_title: "品牌甲探店" },
            })),
          },
        };
      }
      const r = response(
        q.source_note_id,
        q.source_note_id === "generic" ? 45 : 12,
      );
      r.data.items[0].note_card.desc =
        q.source_note_id === "related"
          ? "招牌奶昔味道不错"
          : "餐厅环境和座位展示";
      return r;
    },
  });
  try {
    await service.start(f.brand, "coupon");
    await service.drain();
    let j = (await f.db.query<any>("SELECT * FROM coupon_media_jobs")).rows[0];
    assert.equal(j.resources.length, 40);
    assert.ok(
      j.resources.slice(0, 12).every((r: any) => r.relevance === "coupon"),
    );
    assert.ok(j.resources.slice(12).every((r: any) => r.relevance === "brand"));
    assert.equal(j.exhausted, false);
    await service.start(f.brand, "coupon", true);
    await service.drain();
    j = (await f.db.query<any>("SELECT * FROM coupon_media_jobs")).rows[0];
    assert.equal(j.resources.length, 57);
    assert.equal(new Set(j.resources.map((r: any) => r.id)).size, 57);
    assert.equal(j.exhausted, true);
    assert.equal(peak, 1);
    assert.ok(keywords.every((k) => k === "品牌甲"));
  } finally {
    await service.stop();
    await f.cleanup();
  }
});

test("同券跨账号复用公开素材并续期，任务与私人作品仍隔离", async () => {
  const f = await fixture();
  let requests = 0;
  const service = await createCouponMedia(f.db, f.path, {
    wait: async () => {},
    transport: async () => {
      requests++;
      throw Error("不应请求外部平台");
    },
  });
  const source = randomUUID(),
    ownerA = randomUUID(),
    ownerB = randomUUID();
  try {
    await f.db.query(
      `INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,resources,coupon_title,owner_id,updated_at) VALUES($1,$2,'coupon','品牌甲','["品牌甲"]','complete',$3,'双人套餐',$4,now()-interval '2 hours')`,
      [
        source,
        f.brand,
        JSON.stringify([
          {
            id: "public-network-clip",
            note_id: "note",
            title: "品牌甲",
            video_url: "https://sns-video.xhscdn.com/test.mp4",
            note_url: "https://www.xiaohongshu.com/explore/note",
            poster: "",
            author: "public",
            match: "brand",
          },
        ]),
        ownerA,
      ],
    );
    const b = await service.start(f.brand, "coupon", false, false, ownerB);
    await service.drain();
    assert.equal(requests, 0);
    assert.notEqual(b.id, source);
    assert.equal(b.owner_id, ownerB);
    assert.equal(b.resources[0].id, "public-network-clip");
    const renewed = (
      await f.db.query<{ updated_at: string }>(
        "SELECT updated_at FROM coupon_media_jobs WHERE id=$1",
        [source],
      )
    ).rows[0];
    assert.ok(Date.now() - new Date(renewed.updated_at).getTime() < 5000);
    const again = await service.start(f.brand, "coupon", false, false, ownerB);
    assert.equal(again.id, b.id);
    assert.equal(requests, 0);
  } finally {
    await service.drain();
    await f.cleanup();
  }
});
