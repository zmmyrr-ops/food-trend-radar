import {
  productionOptionsSchema,
  subtitleFonts,
  type VideoProductionOptions,
} from "@radar/contracts";
import { z } from "zod";
import { bailianError } from "./bailian-error.js";
export const narrationModel = "qwen3-tts-instruct-flash";
export const scriptSchema = z.object({
  sentences: z.array(z.string().trim().min(4).max(1000)).min(1).max(20),
});
export function validateScript(raw: unknown, seconds: number) {
  const parsed = scriptSchema.safeParse(raw);
  if (!parsed.success) throw Error("视频稿格式不完整，需要重新整理");
  const text = parsed.data.sentences
    .join("")
    .replace(/[【】「」“”]/g, "")
    .trim();
  if (/[{}<>\[\]\\]|全网最低|闭眼冲|百分百/.test(text))
    throw Error("视频稿包含占位符或夸张承诺，需要改为真实画面描述");
  const limit = Math.floor(seconds * 5.8);
  const parts = (text.match(/[^。！？；，]+[。！？；，]?/gu) || []).filter(
    (part) =>
      !/(?:[0-9一二三四五六七八九十]+(?:到|至|—|-)?)\s*(?:岁|元|折|小时|平米|平方米)|免费|每日消毒|保证安全|(?:体验票|门票|通票).*(?:可入|包含)|所有场景/.test(
        part,
      ),
  );
  const result: string[] = [];
  let length = 0;
  for (const part of parts) {
    if (length + part.length > limit) break;
    result.push(part);
    length += part.length;
  }
  if (length < 15) throw Error("视频稿有效内容不足，需要补充画面细节");
  // Trim only at a natural clause boundary; preserve words and punctuation.
  if (result.length && /[，；]$/.test(result[result.length - 1]))
    result[result.length - 1] = result[result.length - 1].slice(0, -1) + "。";
  return [result.join("")];
}
export type Cue = { text: string; start: number; end: number };
export function subtitleCues(
  sentences: string[],
  durations: number[],
  offset = 0.25,
): Cue[] {
  let at = offset;
  return sentences.flatMap((s, i) => {
    const duration = durations[i];
    if (!Number.isFinite(duration) || duration <= 0)
      throw Error("字幕时长无效");
    // Phrase-level subtitles keep punctuation; no second, independently generated text.
    const phrases = s.match(/[^，。！？；、]+[，。！？；、]?/gu) || [s];
    const parts = phrases.flatMap((phrase) => {
      const chars = Array.from(phrase);
      const count = Math.ceil(chars.length / 10);
      const size = Math.ceil(chars.length / count);
      return Array.from({ length: count }, (_, index) =>
        chars.slice(index * size, (index + 1) * size).join(""),
      ).filter(Boolean);
    });
    const total = parts.join("").length;
    const out = parts.map((text) => {
      const start = at;
      at += (duration * text.length) / total;
      return { text, start, end: at };
    });
    return out;
  });
}
export function assDocument(
  cues: Cue[],
  w: number,
  h: number,
  raw: Partial<VideoProductionOptions> = {},
) {
  const options = productionOptionsSchema.parse(raw);
  const font = subtitleFonts.find((f) => f.id === options.subtitleFont)!;
  const color = (hex: string) =>
    "&H00" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);

  const time = (n: number) => {
    const t = Math.round(n * 100);
    return `${Math.floor(t / 360000)}:${String(Math.floor(t / 6000) % 60).padStart(2, "0")}:${String(Math.floor(t / 100) % 60).padStart(2, "0")}.${String(t % 100).padStart(2, "0")}`;
  };
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\nStyle: Default,${font.family},${Math.round((options.subtitleSize * w) / 1080)},${color(options.subtitleColor)},${color(options.subtitleOutlineColor)},1,${(options.subtitleOutline * w) / 1080},0,2,45,45,${Math.round(h * (1 - options.subtitlePosition / 100))}\n[Events]\nFormat: Layer, Start, End, Style, Text\n` +
    cues
      .map(
        (c) =>
          `Dialogue: 0,${time(c.start)},${time(c.end)},Default,${c.text.replace(/[{}\\\r\n]/g, "")}`,
      )
      .join("\n")
  );
}
/** Download only the provider's audio result, never a model-supplied arbitrary URL. */
export async function synthesizeSpeech(
  key: string,
  text: string,
  fetcher: typeof fetch = fetch,
  voice = "Cherry",
): Promise<Buffer> {
  voice = productionOptionsSchema.parse({ voice }).voice;
  const res = await fetcher(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: narrationModel,
        input: {
          text,
          voice,
          language_type: "Chinese",
          instructions:
            "自然中文探店分享，亲切清楚，有轻微起伏，明快流畅的语速，约每秒五个汉字，句间停顿短而自然，不叫卖，不夸张，不加词。",
          optimize_instructions: true,
        },
      }),
    },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Error(bailianError(res.status, data).message);
  const url = new URL(data?.output?.audio?.url || "https://invalid.invalid");
  if (
    !/^dashscope-(?:result-[a-z0-9-]+|[a-f0-9]{4})\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
      url.hostname,
    ) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("语音返回地址无效");
  url.protocol = "https:";
  const audio = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!audio.ok || !audio.body) throw Error("口播音频获取失败，请重试");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of audio.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Error("口播音频过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** Locally composed instrumental bed: no downloaded commercial recording. */
export function musicBed(seconds: number, leisure: boolean): Buffer {
  const rate = 24000,
    n = Math.ceil(seconds * rate),
    samples = new Float32Array(n);
  const bpm = leisure ? 108 : 88,
    beat = 60 / bpm;
  const chords = leisure
    ? [
        [60, 64, 67, 71],
        [57, 60, 64, 67],
        [53, 57, 60, 64],
        [55, 59, 62, 67],
      ]
    : [
        [60, 64, 67, 71],
        [57, 60, 64, 67],
        [62, 65, 69, 72],
        [55, 59, 62, 65],
      ];
  const note = (
    start: number,
    duration: number,
    midi: number,
    gain: number,
  ) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (
      let i = 0;
      i < duration * rate && Math.round(start * rate) + i < n;
      i++
    ) {
      const t = i / rate;
      const env =
        Math.min(1, t / 0.018) *
        Math.exp((-t * 3) / duration) *
        Math.min(1, (duration - t) / 0.08);
      samples[Math.round(start * rate) + i] +=
        gain *
        env *
        (Math.sin(2 * Math.PI * f * t) + 0.24 * Math.sin(4 * Math.PI * f * t));
    }
  };
  for (let b = 0; b * beat < seconds; b++) {
    const chord = chords[Math.floor(b / 4) % 4];
    note(b * beat, beat * 2, chord[0] - 24, 0.13);
    for (let k = 0; k < 2; k++)
      note((b + k / 2) * beat, beat * 1.4, chord[(b * 2 + k) % 4] + 12, 0.07);
    if (b % 4 === 0)
      for (const m of chord) note(b * beat, beat * 3.8, m, 0.035);
  }
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF");
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / rate / 0.4, (seconds - i / rate) / 0.8);
    out.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, samples[i] * fade)) * 32767),
      44 + i * 2,
    );
  }
  return out;
}
