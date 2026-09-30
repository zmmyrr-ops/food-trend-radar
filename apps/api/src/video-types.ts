import { z } from "zod";
import { FACE_SCREEN_VERSION } from "./video-face-policy.js";
export const clipSchema = z.object({
  asset_id: z.string().regex(/^[a-f0-9-]{36}$/),
  start: z.number().min(0).max(120),
  duration: z.number().min(1).max(5),
  caption: z.string().max(40),
});
export const planSchema = z.array(clipSchema).min(4).max(12);
export type Clip = z.infer<typeof clipSchema>;
export type Asset = {
  id: string;
  source_id: string;
  origin?: "network" | "upload";
  face_screen?: "clear" | "present" | "uncertain";
  face_screen_version?: number;
  url?: string;
  path?: string;
  title: string;
  author: string;
  note_url: string;
  kind: "video" | "image";
  duration?: number;
  width?: number;
  height?: number;
  score?: number;
  accepted?: boolean;
  reason?: string;
  tags?: string[];
  best_start?: number;
  best_end?: number;
  hash?: string;
};
export { productionOptionsSchema } from "@radar/contracts";
export type ProductionOptions = Partial<
  import("@radar/contracts").VideoProductionOptions
> & { subtitles: boolean; narration: boolean; music: boolean };
export type VideoProject = {
  production_options?: ProductionOptions;
  script?: string;
  script_segments?: string[];
  script_revision?: number;
  narration_revision?: number;
  subtitle_cues?: { text: string; start: number; end: number }[];
  channel?: "food" | "leisure";
  category?: string;
  visit_store_id?: string;
  visit_plan_id?: string;
  visit_store_name?: string;
  visit_plan_name?: string;
  visit_date?: string;
  id: string;
  brand_id: string;
  product_id: string;
  brand_name: string;
  title: string;
  seconds: number;
  assets: Asset[];
  plan: Clip[];
  state: string;
  progress: string;
  error: string | null;
  revision: number;
  preview_revision?: number;
  export_revision?: number;
  cost: number;
  rights_confirmed: boolean;
  created_at: string;
  updated_at: string;
  music_id?: string;
  captions_pending?: boolean;
  coupon_facts?: {
    name: string;
    price_min_fen: number | null;
    price_max_fen: number | null;
    observed_at: string;
  };
};
export function networkAsset(a: Asset) {
  return a.origin === "network" || !!a.url || !!a.note_url;
}
export function permittedAsset(a: Asset) {
  return (
    !networkAsset(a) ||
    (a.face_screen === "clear" && a.face_screen_version === FACE_SCREEN_VERSION)
  );
}
export function requiresFaceScreen(p: Pick<VideoProject, "plan" | "assets">) {
  return (
    p.plan?.some((c) => {
      const a = p.assets.find((a) => a.id === c.asset_id);
      return !a || !permittedAsset(a);
    }) ?? false
  );
}
export function validatePlan(plan: Clip[], assets: Asset[], seconds: number) {
  planSchema.parse(plan);
  if (Math.abs(plan.reduce((n, c) => n + c.duration, 0) - seconds) > 1 / 30)
    throw Error("镜头总时长必须等于目标时长");
  for (const c of plan) {
    const a = assets.find((a) => a.id === c.asset_id);
    if (a && !permittedAsset(a))
      throw Error("网络素材需按新版人物主体规则重新检查，请重新分析素材");
    if (!a || !a.accepted || !a.path) throw Error("镜头素材不可用");
    if (a.kind === "video" && c.start + c.duration > (a.duration ?? 0) + 0.02)
      throw Error("片段超出素材时长");
  }
  return plan;
}
export function automaticPlan(
  assets: Asset[],
  seconds: number,
  preserveOrder = false,
): Clip[] {
  const usable = assets.filter(
    (a) =>
      permittedAsset(a) &&
      a.accepted &&
      a.path &&
      (a.kind === "image" ||
        (a.best_end ?? a.duration ?? 0) - (a.best_start ?? 0) >= 1.5),
  );
  // One use per asset; varied tags win ties. Never loop a short clip to fill time.
  const selected: Asset[] = [];
  while (usable.length && selected.length < 12) {
    if (!preserveOrder) usable.sort((a, b) => value(b) - value(a));
    selected.push(usable.shift()!);
  }
  function value(a: Asset) {
    return (
      (a.score ?? 0) -
      selected.filter((b) => b.tags?.[0] === a.tags?.[0]).length * 12
    );
  }
  let remaining = seconds;
  const out: Clip[] = [];
  for (const [index, a] of selected.entries()) {
    if (remaining <= 0) break;
    const capacity =
      a.kind === "image"
        ? 3
        : Math.min(3, (a.best_end ?? a.duration ?? 0) - (a.best_start ?? 0));
    const later = selected
      .slice(index + 1)
      .reduce(
        (sum, next) =>
          sum +
          (next.kind === "image"
            ? 3
            : Math.min(
                3,
                (next.best_end ?? next.duration ?? 0) - (next.best_start ?? 0),
              )),
        0,
      );
    const beat = [1.7, 1.4, 2, 1.6, 1.8][index % 5];
    let duration = Math.min(
      capacity,
      remaining,
      Math.max(beat, remaining - later),
    );
    if (remaining - duration > 0 && remaining - duration < 1)
      duration = Math.min(capacity, remaining);
    duration = Math.round(duration * 30) / 30;
    if (duration < 1) {
      if (out.length) {
        const last = out[out.length - 1];
        if (last.duration + duration <= 3) {
          const prev = assets.find((x) => x.id === last.asset_id)!;
          if (
            prev.kind === "image" ||
            last.start + last.duration + duration <= (prev.duration ?? 0)
          ) {
            last.duration += duration;
            remaining = 0;
          }
        }
      }
      break;
    }
    out.push({
      asset_id: a.id,
      start: a.kind === "image" ? 0 : (a.best_start ?? 0),
      duration,
      caption: "",
    });
    remaining -= duration;
  }
  if (remaining > 0.02 || out.length < 4)
    throw Error("优质素材不足以达到目标时长");
  return validatePlan(out, assets, seconds);
}

/** Keep the preferred duration when possible, otherwise fit down to 12 seconds. */
export function adaptivePlan(assets: Asset[], preferredSeconds: number) {
  for (let seconds = Math.floor(preferredSeconds); seconds >= 12; seconds--) {
    try {
      return { seconds, plan: automaticPlan(assets, seconds) };
    } catch {
      // A shorter complete edit is preferable to looping or extending poor footage.
    }
  }
  throw Error("优质素材不足12秒，请补充素材后重试");
}
