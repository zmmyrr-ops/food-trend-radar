import { parseRestrictions } from "./rule-restrictions.js";
import type { RuleText } from "./rule-structure.js";
import { parseUsage } from "./rule-usage.js";

/** Explicit returned clauses only; missing text never proves a restriction was removed. */
export function conditionRisks(before: RuleText[], after: RuleText[]) {
  const old = parseRestrictions(before),
    current = parseRestrictions(after);
  const priorUsage = parseUsage(before),
    usage = parseUsage(after);
  const risks: {
    kind: string;
    message: string;
    before: string[];
    after: string[];
  }[] = [];
  const add = (
    kind: string,
    message: string,
    before: string[],
    after: string[],
  ) => risks.push({ kind, message, before, after });
  const restricted = new Set([
    "new_customer",
    "member",
    "student",
    "self_only",
    "non_transferable",
  ]);
  for (const fact of current.eligibility.facts) {
    if (
      restricted.has(fact.kind) &&
      !old.eligibility.facts.some((x) => x.kind === fact.kind)
    )
      add(
        "eligibility",
        "本轮出现资格限制，不能仅凭降价认定更优惠",
        old.eligibility.facts.map((x) => x.evidence),
        [fact.evidence],
      );
  }
  for (const charge of current.fees.charges) {
    const previous = old.fees.charges.filter(
      (x) => x.name === charge.name && x.basis === charge.basis,
    );
    if (
      !previous.length ||
      previous.some((x) => x.amount_fen < charge.amount_fen)
    )
      add(
        "fees",
        previous.length
          ? "同计费单位的附加费用上涨"
          : "本轮出现附加费用，上轮未识别不代表原来免费",
        previous.map((x) => x.evidence),
        [charge.evidence],
      );
  }
  for (const fact of usage.facts) {
    if (
      !["dine_in_only", "takeaway_only", "required", "forbidden"].includes(
        fact.value,
      )
    )
      continue;
    const previous = priorUsage.facts.filter(
      (x) => x.dimension === fact.dimension,
    );
    if (!previous.some((x) => x.value === fact.value))
      add(
        "usage",
        "本轮出现使用限制，需结合条件比较",
        previous.map((x) => x.evidence),
        [fact.evidence],
      );
  }
  const conflict = (
    r: ReturnType<typeof parseRestrictions>,
    u: ReturnType<typeof parseUsage>,
  ) =>
    r.eligibility.conflicting ||
    r.fees.conflicting ||
    r.purchase_limits.conflicting ||
    u.conflicts.length > 0;
  const conflicting = conflict(old, priorUsage) || conflict(current, usage);
  if (conflicting)
    add(
      "conflict",
      "前后条款中存在冲突，不能确认同条件优惠",
      before.flatMap((x) => x.value.map((v) => v.content)),
      after.flatMap((x) => x.value.map((v) => v.content)),
    );
  return { risks, conflicting, complete: false };
}
