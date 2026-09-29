/** V3 rule scores are opportunity intervals, never probabilities. */
export type Range = { low: number; high: number };
export const unknown = (): Range => ({ low: 0, high: 100 });
export function point(value: number): Range {
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error("INVALID_SCORE");
  return { low: value, high: value };
}
function weighted(parts: [Range, number][]): Range {
  for (const [r] of parts)
    if (
      !Number.isFinite(r.low) ||
      !Number.isFinite(r.high) ||
      r.low < 0 ||
      r.high > 100 ||
      r.low > r.high
    )
      throw new Error("INVALID_INTERVAL");
  return {
    low: parts.reduce((v, [r, w]) => v + r.low * w, 0),
    high: parts.reduce((v, [r, w]) => v + r.high * w, 0),
  };
}
export function novelty(ageHours: number, verified: boolean): Range {
  if (!verified) return point(30);
  if (!Number.isFinite(ageHours) || ageHours < 0) return unknown();
  return point(
    ageHours <= 24 ? 100 : ageHours <= 48 ? 70 : ageHours <= 72 ? 40 : 10,
  );
}
export function saturation(authors: number, complete: boolean): Range {
  if (!Number.isInteger(authors) || authors < 0)
    throw new Error("INVALID_AUTHORS");
  const low = authors < 5 ? 0 : authors < 15 ? 10 : authors < 30 ? 20 : 30;
  return { low, high: complete ? low : 30 };
}
export function valueScore(
  improvement = unknown(),
  affordability = unknown(),
  usability = unknown(),
) {
  return weighted([
    [improvement, 0.6],
    [affordability, 0.25],
    [usability, 0.15],
  ]);
}
export function samePriceTolerance(oldFen: number) {
  if (!Number.isFinite(oldFen) || oldFen <= 0) throw new Error("INVALID_PRICE");
  return Math.max(100, oldFen * 0.03);
}
export type Gates = Record<
  "identity" | "shanghai" | "available" | "value" | "creatorCoverage",
  boolean
>;
export function scoreOpportunity(input: {
  value: Range;
  novelty: Range;
  heat: Range;
  environment: Range;
  deduction: Range;
  gates: Gates;
  confirmedChange: boolean;
}) {
  const base = weighted([
    [input.value, 0.6],
    [input.novelty, 0.15],
    [input.heat, 0.15],
    [input.environment, 0.1],
  ]);
  const d = input.deduction;
  if (
    !Number.isFinite(d.low) ||
    !Number.isFinite(d.high) ||
    d.low < 0 ||
    d.high > 30 ||
    d.low > d.high
  )
    throw new Error("INVALID_DEDUCTION");
  const clip = (n: number) =>
    Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
  const range = { low: clip(base.low - d.high), high: clip(base.high - d.low) };
  const missing = Object.entries(input.gates)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  return {
    version: "V3.0",
    range,
    missing,
    gate: missing.length ? "watch" : "eligible",
    alert: !missing.length && input.confirmedChange && range.low >= 70,
  };
}
export function unverifiedOpportunity() {
  return scoreOpportunity({
    value: unknown(),
    novelty: novelty(0, false),
    heat: unknown(),
    environment: unknown(),
    deduction: saturation(0, false),
    gates: {
      identity: false,
      shanghai: false,
      available: false,
      value: false,
      creatorCoverage: false,
    },
    confirmedChange: false,
  });
}

/** Current product: native sales metrics, no uncalibrated weighted score. */
export function salesEvidenceAssessment(
  shanghai = false,
  salesMeasured = false,
) {
  return {
    version: "V4.2.sales-evidence",
    range: unknown(),
    score_status: "not_calibrated",
    missing: [
      "identity",
      "available",
      "value",
      "scoreCalibration",
      ...(!shanghai ? ["shanghai"] : []),
      ...(!salesMeasured ? ["salesHistory"] : []),
    ],
    gate: "watch",
    alert: false,
  };
}
