import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { extractVideoFrame } from "../src/video-frame.js";

const require = createRequire(import.meta.url),
  ffmpeg = require("ffmpeg-static"),
  exec = promisify(execFile);
test("tail seek beyond last frame produces an actual JPEG instead of ENOENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tail-frame-"));
  try {
    const source = join(dir, "source.mp4"),
      output = join(dir, "frame.jpg");
    await exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x568:r=20",
      "-frames:v",
      "36",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-y",
      source,
    ]);
    const frame = await extractVideoFrame(
      (args) => exec(ffmpeg, args),
      source,
      output,
      1.768,
      1.808,
      "scale=160:284",
    );
    assert.equal(frame[0], 0xff);
    assert.equal(frame[1], 0xd8);
    assert.ok(frame.length > 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("missing middle frame cannot silently reuse a stale image or pass review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "missing-frame-"));
  const output = join(dir, "frame.jpg");
  try {
    await writeFile(output, "stale frame");
    let calls = 0;
    await assert.rejects(
      extractVideoFrame(
        async () => {
          calls++;
        },
        "source",
        output,
        1,
        10,
        "scale=160:284",
      ),
      /无法提取素材画面/,
    );
    assert.equal(calls, 1);
    await assert.rejects(readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
