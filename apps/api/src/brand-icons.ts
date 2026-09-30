import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import officialLogos from "./official-brand-logos.json" with { type: "json" };

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
      ON CONFLICT(brand_id) DO UPDATE SET source_url=excluded.source_url,kind=excluded.kind,mime=excluded.mime,content=excluded.content,updated_at=now() WHERE brand_icons.kind<>'official_logo'`,
      [brand, url, kind, mime, bytes.toString("base64")],
    );
    await tx.query(
      "UPDATE brands SET icon_url=$2 WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM brand_icons WHERE brand_id=$1 AND kind='official_logo')",
      [brand, `/api/v3/brands/${brand}/icon`],
    );
  });
}

/** Exact-name/alias matches only; curated official logos outrank shop photos. */
export async function seedOfficialBrandIcons(db: PGlite) {
  for (const logo of officialLogos) {
    const matches = await db.query<{ id: string }>(
      "SELECT id FROM brands WHERE name=ANY($1::text[]) OR aliases ?| $1::text[]",
      [logo.names],
    );
    const revision = createHash("sha256")
      .update(logo.content)
      .digest("hex")
      .slice(0, 12);
    for (const { id } of matches.rows) {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO brand_icons(brand_id,source_url,kind,mime,content)
          VALUES($1,$2,'official_logo',$3,$4) ON CONFLICT(brand_id) DO UPDATE
          SET source_url=excluded.source_url,kind=excluded.kind,mime=excluded.mime,content=excluded.content,updated_at=now()
          WHERE brand_icons.kind<>'official_logo' OR brand_icons.content<>excluded.content`,
          [id, logo.source_url, logo.mime, logo.content],
        );
        await tx.query(
          "UPDATE brands SET icon_url=$2 WHERE id=$1 AND icon_url IS DISTINCT FROM $2",
          [id, `/api/v3/brands/${id}/icon?v=${revision}`],
        );
      });
    }
  }
}
