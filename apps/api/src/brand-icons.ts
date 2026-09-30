import type { PGlite } from "@electric-sql/pglite";

export function platformImage(value: unknown): string | null {
  const raw =
    typeof value === "string" ? value : (value as { url?: unknown })?.url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /(?:^|\.)douyinpic\.com$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Stored bytes survive CDN signature expiry. Never use a product cover as a brand logo.
export async function cacheBrandIcon(
  db: PGlite,
  brand: string,
  url: string,
  kind: string,
) {
  if (!platformImage(url)) return;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !response.body) throw new Error("ICON_FETCH_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 300_000) throw new Error("ICON_TOO_LARGE");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mime =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? "image/jpeg"
      : bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw new Error("ICON_FORMAT_INVALID");
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO brand_icons(brand_id,source_url,kind,mime,content) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(brand_id) DO UPDATE SET source_url=excluded.source_url,kind=excluded.kind,mime=excluded.mime,content=excluded.content,updated_at=now()`,
      [brand, url, kind, mime, bytes.toString("base64")],
    );
    await tx.query("UPDATE brands SET icon_url=$2 WHERE id=$1", [
      brand,
      `/api/v3/brands/${brand}/icon`,
    ]);
  });
}
