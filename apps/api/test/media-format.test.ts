import assert from "node:assert/strict";
import test from "node:test";
import { mediaFormat } from "../src/media-format.js";

test("source files use real media containers for browser playback and downloads", () => {
  const mp4 = Buffer.alloc(32);
  mp4.write("ftyp", 4);
  mp4.write("isom", 8);
  assert.deepEqual(mediaFormat(mp4), { extension: "mp4", type: "video/mp4" });
  mp4.write("qt  ", 8);
  assert.equal(mediaFormat(mp4).extension, "mov");
  assert.equal(mediaFormat(Buffer.from([255, 216, 255])).extension, "jpg");
  assert.equal(
    mediaFormat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).extension,
    "png",
  );
  assert.equal(mediaFormat(Buffer.from("RIFF0000WEBP")).extension, "webp");
  assert.throws(
    () => mediaFormat(Buffer.from("<html>error</html>")),
    /无法识别/,
  );
});
