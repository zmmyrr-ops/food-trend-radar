import { point, type Range, saturation, unknown } from "./opportunity-score.js";
export type VideoEvidence = {
  videoId: string;
  authorId: string | null;
  couponVersion: string | null;
  publishedAt: string;
  observedAt: string;
};
export function creatorDeduction(
  videos: VideoEvidence[],
  couponVersion: string,
  asOf: Date,
  queryComplete: boolean,
) {
  if (!Number.isFinite(+asOf) || !couponVersion.trim())
    throw new Error("INVALID_CREATOR_WINDOW");
  const byVideo = new Map<string, VideoEvidence[]>();
  let unresolved = false;
  for (const video of videos) {
    const published = Date.parse(video.publishedAt),
      observed = Date.parse(video.observedAt);
    if (
      !Number.isFinite(published) ||
      !Number.isFinite(observed) ||
      published > observed
    ) {
      if (video.couponVersion === couponVersion || video.couponVersion === null)
        unresolved = true;
      continue;
    }
    if (
      observed > +asOf ||
      published > +asOf ||
      published < +asOf - 72 * 3600000
    )
      continue;
    if (video.couponVersion === null) {
      unresolved = true;
      continue;
    }
    if (video.couponVersion !== couponVersion) continue;
    if (!video.videoId.trim() || !video.authorId?.trim()) {
      unresolved = true;
      continue;
    }
    byVideo.set(video.videoId, [...(byVideo.get(video.videoId) ?? []), video]);
  }
  const accepted: VideoEvidence[] = [];
  for (const group of byVideo.values()) {
    if (
      new Set(group.map((v) => v.authorId)).size !== 1 ||
      new Set(group.map((v) => Date.parse(v.publishedAt))).size !== 1
    ) {
      unresolved = true;
      continue;
    }
    accepted.push(group[0]);
  }
  const count = (start: number, end: number) => {
    const subset = accepted.filter(
      (v) =>
        Date.parse(v.publishedAt) >= start && Date.parse(v.publishedAt) < end,
    );
    return {
      videos: subset.length,
      authors: new Set(subset.map((v) => v.authorId)).size,
    };
  };
  const complete = queryComplete && !unresolved;
  const current = count(+asOf - 24 * 3600000, +asOf + 1),
    previous = count(+asOf - 48 * 3600000, +asOf - 24 * 3600000);
  const authors = new Set(accepted.map((v) => v.authorId)).size;
  return {
    authors,
    matchedVideos: accepted.length,
    coverage: complete ? "complete" : "partial",
    deduction: saturation(authors, complete),
    last24h: current,
    previous24h: previous,
    publishGrowth:
      complete && previous.videos > 0
        ? (current.videos - previous.videos) / previous.videos
        : null,
    countMeaning: complete
      ? "verified_source_coverage"
      : "observed_lower_bound",
  };
}

export type IndexPoint = {
  source: string;
  metric: string;
  value: number;
  validAt: string;
  observedAt: string;
};
export function heatGrowth(
  points: IndexPoint[],
  source: string,
  metric: string,
  asOf: Date,
): { growth: number | null; score: Range; samples: number } {
  // Require a real daily index series. Monthly coupon sales must never be passed as an index.
  if (!metric.endsWith("_index"))
    return { growth: null, score: unknown(), samples: 0 };
  const byDay = new Map<string, IndexPoint>();
  for (const p of [...points].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  )) {
    const valid = Date.parse(p.validAt),
      observed = Date.parse(p.observedAt);
    if (
      p.source !== source ||
      p.metric !== metric ||
      !Number.isFinite(valid) ||
      !Number.isFinite(observed) ||
      valid > +asOf ||
      observed > +asOf ||
      !Number.isFinite(p.value) ||
      p.value < 0
    )
      continue;
    byDay.set(
      new Date(valid).toLocaleDateString("en-CA", {
        timeZone: "Asia/Shanghai",
      }),
      p,
    );
  }
  const sorted = [...byDay.values()]
    .sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt))
    .slice(-8);
  if (
    sorted.length < 8 ||
    +asOf - Date.parse(sorted[7].validAt) > 48 * 3600000 ||
    sorted.some(
      (p, i) =>
        i > 0 &&
        Date.parse(p.validAt) - Date.parse(sorted[i - 1].validAt) !==
          24 * 3600000,
    )
  )
    return { growth: null, score: unknown(), samples: sorted.length };
  const baseline = sorted.slice(0, 7).reduce((sum, p) => sum + p.value, 0) / 7;
  if (!baseline) return { growth: null, score: unknown(), samples: 8 };
  return {
    growth: (sorted[7].value - baseline) / baseline,
    score: unknown(),
    samples: 8,
  };
}
export function growthPercentile(
  growth: number | null,
  comparableGrowths: number[],
): Range {
  const cohort = comparableGrowths.filter(Number.isFinite);
  if (growth === null || !Number.isFinite(growth) || cohort.length < 20)
    return unknown();
  return point(
    ((cohort.filter((v) => v < growth).length +
      cohort.filter((v) => v === growth).length * 0.5) /
      cohort.length) *
      100,
  );
}
