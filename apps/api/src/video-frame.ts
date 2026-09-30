import { readFile, rm } from "node:fs/promises";
/** FFmpeg can exit successfully without output when seeking beyond the final frame. */
export async function extractVideoFrame(
  run: (args: string[]) => Promise<unknown>,
  source: string,
  destination: string,
  time: number,
  duration: number | undefined,
  scale: string,
) {
  const render = async (seek: string[], filter: string) => {
    await rm(destination, { force: true });
    await run([
      "-v",
      "error",
      "-threads",
      "1",
      ...seek,
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-y",
      destination,
    ]);
    try {
      const bytes = await readFile(destination);
      return bytes.length > 0 ? bytes : null;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      return null;
    }
  };
  const frame = await render(["-ss", String(Math.max(0, time))], scale);
  if (frame) return frame;
  if (duration && time >= duration - 0.5) {
    // Decode the tail and take its actual last frame, after scaling to bound memory.
    const tail = await render(
      ["-sseof", String(-Math.min(1, duration))],
      `${scale},reverse`,
    );
    if (tail) return tail;
  }
  throw Error("无法提取素材画面，请移除无法播放的素材后重试");
}
