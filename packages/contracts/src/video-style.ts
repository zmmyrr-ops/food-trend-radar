import { z } from "zod";
export const videoVoices = [
  { id: "Cherry", name: "芊悦 · 亲切女声" },
  { id: "Serena", name: "苏瑶 · 温柔女声" },
  { id: "Ethan", name: "晨煦 · 阳光男声" },
  { id: "Maia", name: "四月 · 知性女声" },
  { id: "Moon", name: "月白 · 清爽男声" },
  { id: "Kai", name: "凯 · 低沉男声" },
  { id: "Vincent", name: "田叔 · 沙哑男声" },
  { id: "Neil", name: "阿闻 · 清晰男声" },
] as const;
export const subtitleFonts = [
  { id: "sans", name: "思源黑体", family: "Noto Sans CJK SC" },
  { id: "serif", name: "思源宋体", family: "Noto Serif SC" },
] as const;
export const productionOptionsSchema = z.object({
  subtitles: z.boolean().default(false),
  narration: z.boolean().default(false),
  music: z.boolean().default(false),
  voice: z
    .enum([
      "Cherry",
      "Serena",
      "Ethan",
      "Maia",
      "Moon",
      "Kai",
      "Vincent",
      "Neil",
    ])
    .default("Cherry"),
  subtitleFont: z.enum(["sans", "serif"]).default("sans"),
  subtitleSize: z.number().int().min(36).max(88).default(64),
  subtitlePosition: z.number().int().min(20).max(88).default(72),
  subtitleOutline: z.number().min(0).max(8).default(3),
  subtitleColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#FFFFFF"),
  subtitleOutlineColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#202020"),
});
export type VideoProductionOptions = z.infer<typeof productionOptionsSchema>;
export const defaultVideoProductionOptions = productionOptionsSchema.parse({});
