import { z } from "zod";
import type { Clip } from "./video-types.js";
export function applyCaptions(plan: Clip[], raw: unknown): Clip[] {
  const data = z
    .object({
      captions: z
        .array(
          z.object({
            index: z.number().int(),
            text: z.string().trim().min(1).max(40),
          }),
        )
        .min(4)
        .max(12),
    })
    .parse(raw);
  if (
    data.captions.length !== plan.length ||
    new Set(data.captions.map((c) => c.index)).size !== plan.length
  )
    throw Error("字幕数量与镜头不一致，请重新生成字幕");
  return plan.map((clip, index) => {
    const text = data.captions.find((c) => c.index === index + 1)?.text;
    if (
      !text ||
      text.length > Math.min(24, Math.floor(clip.duration * 7)) ||
      /[\r\n{}\\]/.test(text)
    )
      throw Error("字幕过长或镜头对应不完整，请重新生成字幕");
    if (/开场|收尾|提前预约|双人份量|搭配均衡/.test(text))
      throw Error("字幕包含未经核实的条件或机械画面描述，请重新生成字幕");
    return { ...clip, caption: text };
  });
}
