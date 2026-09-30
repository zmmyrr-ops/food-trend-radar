/** Detect the actual container; internal .source filenames carry no format. */
export function mediaFormat(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { extension: "jpg", type: "image/jpeg" };
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { extension: "png", type: "image/png" };
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return { extension: "webp", type: "image/webp" };
  if (b.toString("ascii", 4, 8) === "ftyp")
    return b.toString("ascii", 8, 12) === "qt  "
      ? { extension: "mov", type: "video/quicktime" }
      : { extension: "mp4", type: "video/mp4" };
  throw Error("无法识别素材格式，请重新获取素材");
}
