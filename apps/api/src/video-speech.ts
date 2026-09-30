import {
  type Cue,
  subtitleCues,
  synthesizeSpeech,
} from "./video-production.js";
export const expressiveModel = "qwen-audio-3.0-tts-plus";
export type SpeechWord = { text: string; start: number; end: number };
export const expressiveVoice = (voice: string) =>
  ["longanlingxin", "longanlufeng"].includes(voice);
export const speechInstruction =
  "用自然普通话给朋友分享探店发现，轻松亲切，语气有自然起伏，重点词稍强调，句内连贯，语速明快但不赶。不是新闻播音，不逐字重读，不叫卖，不拖长尾音，不添加原文没有的字词。";

/** Provider sends cumulative word arrays repeatedly. Keep the latest word per sentence/index. */
export function parseSpeechEvents(body: string) {
  const words = new Map<string, SpeechWord>();
  let url = "",
    complete = false;
  for (const event of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((s) => s.startsWith("data:"))
      .map((s) => s.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let value: any;
    try {
      value = JSON.parse(data);
    } catch {
      throw Error("语音服务返回了不完整数据，请重试");
    }
    if (value.code || value.error) throw Error("语音服务生成失败，请稍后重试");
    const out = value.output;
    if (!out) continue;
    if (out.audio?.url) url = out.audio.url;
    if (out.finish_reason === "stop") complete = true;
    for (const w of out.sentence?.words || []) {
      if (
        typeof w.text !== "string" ||
        !Number.isFinite(w.begin_time) ||
        !Number.isFinite(w.end_time) ||
        w.begin_time < 0 ||
        w.end_time < w.begin_time
      )
        throw Error("口播时间轴无效，请重试");
      words.set(`${out.sentence.index}:${w.begin_index}`, {
        text: w.text,
        start: w.begin_time / 1000,
        end: w.end_time / 1000,
      });
    }
  }
  if (!complete || !url || !words.size)
    throw Error("语音生成未完成或缺少时间轴，请重试");
  const timeline = [...words.values()];
  if (timeline.some((w, i) => i > 0 && w.start < timeline[i - 1].start))
    throw Error("口播时间轴顺序异常，请重试");
  return { url, words: timeline };
}
export async function synthesizeTimedSpeech(
  key: string,
  text: string,
  voice: string,
  fetcher: typeof fetch = fetch,
) {
  if (!expressiveVoice(voice))
    return {
      audio: await synthesizeSpeech(key, text, fetcher, voice),
      words: [] as SpeechWord[],
    };
  const response = await fetcher(
    "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify({
        model: expressiveModel,
        input: {
          text,
          voice,
          format: "wav",
          sample_rate: 24000,
          word_timestamp_enabled: true,
          instruction: speechInstruction,
          language_hints: ["zh"],
          enable_aigc_tag: true,
        },
      }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok || !response.body)
    throw Error(`新版口播服务暂不可用（${response.status}），请稍后重试`);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw Error("语音响应过大");
    chunks.push(chunk);
  }
  const result = parseSpeechEvents(Buffer.concat(chunks).toString("utf8"));
  const url = new URL(result.url);
  if (
    !/^dashscope-(?:result-[a-z0-9-]+|[a-f0-9]{4})\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
      url.hostname,
    ) ||
    !["https:", "http:"].includes(url.protocol) ||
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
  const buffers: Uint8Array[] = [];
  size = 0;
  for await (const chunk of audio.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Error("口播音频过大");
    buffers.push(chunk);
  }
  return { audio: Buffer.concat(buffers), words: result.words };
}
/** Punctuation can be prefixed to the next word by the provider; flush before it. */
export function speechCues(words: SpeechWord[], offset: number): Cue[] {
  const cues: Cue[] = [];
  let current: Cue | undefined;
  const flush = () => {
    if (current && current.text && current.end > current.start)
      cues.push(current);
    current = undefined;
  };
  for (const word of words) {
    if (/^[，。！？；]/.test(word.text)) flush();
    const text = word.text.replace(/[，。！？；]/g, "");
    if (!text) continue;
    if (
      current &&
      (current.text.length + text.length > 10 ||
        word.start + offset - current.end > 0.35)
    )
      flush();
    if (!current)
      current = {
        text: "",
        start: word.start + offset,
        end: word.end + offset,
      };
    current.text += text;
    current.end = word.end + offset;
    if (/[，。！？；]$/.test(word.text)) flush();
  }
  flush();
  return cues;
}
export function narrationCues(
  text: string,
  words: SpeechWord[],
  duration: number,
  offset: number,
) {
  return words.length
    ? speechCues(words, offset)
    : subtitleCues([text], [duration], offset);
}
