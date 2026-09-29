import {
  point,
  type Range,
  samePriceTolerance,
  unknown,
} from "./opportunity-score.js";
/** Only adapters with verified full rules may construct this normalized evidence. */
export type VerifiedTerms = {
  brandId: string;
  type: string;
  quality: string;
  unit: string;
  quantity: number;
  priceFen: number;
  storeIds: string[];
  qualification: string;
  feesFen: number;
  usableWindows: string;
  validFrom: string;
  validTo: string;
  evidenceComplete: boolean;
};
export function compareTerms(
  old: VerifiedTerms,
  current: VerifiedTerms,
): {
  kind:
    | "unverified"
    | "not_comparable"
    | "price_drop"
    | "quantity_increase"
    | "no_improvement";
  improvement: Range;
} {
  const valid = (x: VerifiedTerms) =>
    x.evidenceComplete &&
    [x.priceFen, x.quantity].every((v) => Number.isFinite(v) && v > 0) &&
    Number.isFinite(x.feesFen) &&
    x.feesFen >= 0 &&
    x.storeIds.length > 0 &&
    [
      x.brandId,
      x.type,
      x.quality,
      x.unit,
      x.qualification,
      x.usableWindows,
      x.validFrom,
      x.validTo,
    ].every(Boolean);
  if (!valid(old) || !valid(current))
    return { kind: "unverified", improvement: unknown() };
  const keys = [
    "brandId",
    "type",
    "quality",
    "unit",
    "qualification",
    "feesFen",
    "usableWindows",
    "validFrom",
    "validTo",
  ] as const;
  if (
    keys.some((k) => old[k] !== current[k]) ||
    JSON.stringify([...new Set(old.storeIds)].sort()) !==
      JSON.stringify([...new Set(current.storeIds)].sort())
  )
    return { kind: "not_comparable", improvement: unknown() };
  const oldPrice = old.priceFen + old.feesFen,
    newPrice = current.priceFen + current.feesFen;
  if (current.quantity === old.quantity && newPrice < oldPrice)
    return {
      kind: "price_drop",
      improvement: point(
        Math.min(100, ((oldPrice - newPrice) / oldPrice / 0.3) * 100),
      ),
    };
  if (
    Math.abs(newPrice - oldPrice) <= samePriceTolerance(oldPrice) &&
    current.quantity > old.quantity &&
    newPrice / current.quantity < oldPrice / old.quantity
  )
    return {
      kind: "quantity_increase",
      improvement: point(
        Math.min(
          100,
          ((current.quantity - old.quantity) / old.quantity / 0.3) * 100,
        ),
      ),
    };
  return { kind: "no_improvement", improvement: point(0) };
}
export function affordability(
  currentUnitFen: number,
  products: { id: string; unitFen: number }[],
): Range {
  if (!Number.isFinite(currentUnitFen) || currentUnitFen <= 0) return unknown();
  // Caller supplies one verified comparable group, as-of <= decision time, within 30 days.
  const distinct = [
    ...new Map(
      products
        .filter((p) => Number.isFinite(p.unitFen) && p.unitFen > 0)
        .map((p) => [p.id, p]),
    ).values(),
  ];
  if (distinct.length < 5) return unknown();
  const cheaper = distinct.filter((p) => p.unitFen > currentUnitFen).length;
  const ties = distinct.filter((p) => p.unitFen === currentUnitFen).length;
  return point(((cheaper + ties * 0.5) / distinct.length) * 100);
}
export function usability(parts: (boolean | null)[]): Range {
  if (parts.length !== 4) throw new Error("FOUR_USABILITY_FACTORS_REQUIRED");
  const low = parts.filter((v) => v === true).length * 25;
  return { low, high: low + parts.filter((v) => v === null).length * 25 };
}
