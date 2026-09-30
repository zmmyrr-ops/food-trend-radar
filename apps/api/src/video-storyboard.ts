import { z } from "zod";
import type { Asset, Clip } from "./video-types.js";
export type StoryBlock = {
  asset_ids: string[];
  text: string;
  start?: number;
  duration?: number;
};
const schema = z.object({
  blocks: z
    .array(
      z.object({
        asset_ids: z.array(z.string()).min(1).max(4),
        text: z.string().trim().max(120),
      }),
    )
    .min(1)
    .max(24),
});
export function validateStoryboard(raw: unknown, plan: Clip[]): StoryBlock[] {
  const result = schema.safeParse(raw);
  if (!result.success) throw Error("视频稿分段格式不完整");
  const ids = result.data.blocks.flatMap((b) => b.asset_ids);
  if (
    ids.length !== plan.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id, i) => id !== plan[i].asset_id)
  )
    throw Error("文案与镜头顺序不匹配");
  for (const block of result.data.blocks) {
    if (
      !block.text &&
      plan
        .filter((c) => block.asset_ids.includes(c.asset_id))
        .reduce((n, c) => n + c.duration, 0) > 2.5
    )
      throw Error("主要画面缺少口播内容");
    if (
      /[{}<>\[\]\\]|全网最低|闭眼冲|百分百|免费|保证安全|每日消毒|(?:\d|[一二三四五六七八九十百千万两])+(?:多|余|来)?\s*(?:平米|平方米|岁|元|折|小时)|(?:门票|通票|体验票).*(?:包含|可入)|所有项目|随便玩|玩一天/.test(
        block.text,
      )
    )
      throw Error("文案含未核实的面积、优惠或使用承诺");
  }
  return result.data.blocks;
}
export function blockCapacity(clips: Clip[], assets: Asset[]) {
  return clips.map((c) => {
    const a = assets.find((a) => a.id === c.asset_id)!;
    return a.kind === "image"
      ? 3
      : Math.min(5, (a.best_end ?? a.duration ?? 0) - c.start);
  });
}
/** Allocate real speech duration only inside the corresponding visual block. No frozen frames or loops. */
export function fitBlock(
  clips: Clip[],
  assets: Asset[],
  duration: number,
): Clip[] {
  const caps = blockCapacity(clips, assets);
  if (
    !Number.isFinite(duration) ||
    duration < clips.length ||
    duration > caps.reduce((a, b) => a + b, 0) + 0.001
  )
    throw Error("口播与对应画面时长不匹配，需要缩短该段文案");
  let remaining = duration - clips.length;
  const lengths = clips.map(() => 1);
  for (
    let iteration = 0;
    iteration < clips.length + 1 && remaining > 0.00001;
    iteration++
  ) {
    const available = caps
      .map((cap, i) => ({ i, room: cap - lengths[i] }))
      .filter((x) => x.room > 0.00001);
    const each = remaining / available.length;
    for (const { i, room } of available) {
      const extra = Math.min(room, each);
      lengths[i] += extra;
      remaining -= extra;
    }
  }
  if (remaining > 0.001) throw Error("可用画面时长不足");
  return clips.map((c, i) => ({ ...c, duration: lengths[i] }));
}
/** Last-resort shortening keeps complete clauses; never slice Chinese mid-phrase. */
export function compactNarration(text: string, limit: number) {
  const clauses = text.match(/[^，。！？；]+[，。！？；]?/gu) || [];
  const kept: string[] = [];
  let size = 0;
  for (const clause of clauses) {
    if (size + clause.length <= limit) {
      kept.push(clause);
      size += clause.length;
    }
  }
  if (!kept.length) return null;
  return kept
    .join("")
    .replace(/[，；]?$/, "")
    .replace(/[^。！？]$/, (s) => s + "。");
}

/** Round cumulative boundaries so fractional speech seconds never become fractional frame counts. */
export function clipFrameCounts(clips: Pick<Clip, "duration">[], fps = 30) {
  let seconds = 0,
    frames = 0;
  return clips.map((clip) => {
    seconds += clip.duration;
    const end = Math.round(seconds * fps);
    const count = end - frames;
    frames = end;
    return count;
  });
}
