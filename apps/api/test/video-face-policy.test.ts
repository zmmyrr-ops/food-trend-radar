import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Asset,
  permittedAsset,
  requiresFaceScreen,
  validatePlan,
} from "../src/video-types.js";

const id = "11111111-1111-4111-8111-111111111111";
const asset: Asset = {
  id,
  source_id: id,
  title: "test",
  author: "",
  note_url: "",
  kind: "video",
  path: "/tmp/clip.mp4",
  accepted: true,
  duration: 12,
};
test("网络素材必须通过新版本正面人脸检查，用户上传豁免", () => {
  assert.equal(permittedAsset({ ...asset, origin: "upload" }), true);
  for (const status of [undefined, "present", "uncertain"] as const)
    assert.equal(
      permittedAsset({
        ...asset,
        origin: "network",
        face_screen: status,
        face_screen_version: 2,
      }),
      false,
    );
  assert.equal(
    permittedAsset({
      ...asset,
      origin: "network",
      face_screen: "clear",
      face_screen_version: 2,
    }),
    true,
  );
  assert.equal(
    permittedAsset({ ...asset, url: "https://sns-video.xhscdn.com/a.mp4" }),
    false,
  );
  assert.equal(
    permittedAsset({
      ...asset,
      note_url: "https://www.xiaohongshu.com/explore/abc",
    }),
    false,
  );
  assert.equal(
    permittedAsset({ ...asset, origin: "network", face_screen: "clear" }),
    false,
  );
  assert.equal(
    permittedAsset({
      ...asset,
      origin: "network",
      face_screen: "clear",
      face_screen_version: 1,
    }),
    false,
    "旧版放行结果不能绕过人物主体筛选",
  );
  const plan = Array.from({ length: 4 }, () => ({
    asset_id: id,
    start: 0,
    duration: 3,
    caption: "",
  }));
  assert.throws(
    () => validatePlan(plan, [{ ...asset, origin: "network" }], 12),
    /人物主体/,
  );
  assert.doesNotThrow(() =>
    validatePlan(plan, [{ ...asset, origin: "upload" }], 12),
  );
});

test("拒绝的网络素材不会阻挡只使用自有素材的成片", () => {
  const rejected = {
    ...asset,
    id: "22222222-2222-4222-8222-222222222222",
    origin: "network" as const,
    face_screen: "present" as const,
    face_screen_version: 2,
    accepted: false,
  };
  const plan = Array.from({ length: 4 }, () => ({
    asset_id: id,
    start: 0,
    duration: 3,
    caption: "",
  }));
  assert.equal(requiresFaceScreen({ assets: [asset, rejected], plan }), false);
  assert.equal(
    requiresFaceScreen({ assets: [{ ...asset, origin: "network" }], plan }),
    true,
  );
});
