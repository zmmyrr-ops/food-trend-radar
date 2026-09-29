import type { RuleText } from "./rule-structure.js";

/** Recognize complete, explicit clauses; preserve everything else for later adapters. */
export function parseRestrictions(rules: RuleText[]) {
  const entries = rules.flatMap((r) =>
    r.value.map((v) => ({
      key: r.key,
      original: v.content,
      text: v.content
        .normalize("NFKC")
        .trim()
        .replace(/[。！!]$/u, ""),
    })),
  );
  const audience: { kind: string; evidence: string }[] = [];
  const charges: {
    name: string;
    amount_fen: number;
    basis: string;
    evidence: string;
  }[] = [];
  const limits: {
    quantity: number;
    period: string;
    basis: string;
    unit: string;
    evidence: string;
  }[] = [];
  const unparsedEligibility: string[] = [],
    unparsedFees: string[] = [],
    unparsedLimits: string[] = [];
  let explicitNoFees = false;
  for (const e of entries) {
    if (
      /新客|新用户|新老客|新老用户|会员|学生|本人|转赠|转售|儿童|身高|岁|同桌|同档/.test(
        e.text,
      )
    ) {
      const kind = (
        {
          仅限新客: "new_customer",
          仅限新用户: "new_customer",
          仅限会员: "member",
          仅限学生: "student",
          新老用户均可使用: "all_users",
          新老客均可使用: "all_users",
          仅限本人使用: "self_only",
          不可转赠转售: "non_transferable",
        } as Record<string, string>
      )[e.text];
      if (kind) audience.push({ kind, evidence: e.original });
      else unparsedEligibility.push(e.original);
    }
    if (
      /附加费|额外收费|额外费用|另付|另收|加收|服务费|锅底费|茶位费|补差|加价/.test(
        e.text,
      )
    ) {
      if (/^(?:无额外收费|无需支付额外费用|无附加费)$/.test(e.text)) {
        explicitNoFees = true;
        continue;
      }
      const match = e.text.match(
        /^(?:另收|加收|另付)?(服务费|锅底费|茶位费|附加费)\s*(\d+(?:\.\d{1,2})?)\s*元\s*\/\s*(人|位|桌|份|单)$/,
      );
      if (match) {
        const [whole, decimal = ""] = match[2].split(".");
        const fen = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
        if (Number.isSafeInteger(fen))
          charges.push({
            name: match[1],
            amount_fen: fen,
            basis: match[3],
            evidence: e.original,
          });
        else unparsedFees.push(e.original);
      } else unparsedFees.push(e.original);
    }
    if (e.key === "purchase_restriction_rule") {
      const m = e.text.match(
        /^每(人|单)(每天|每周|每月)?最多(?:买|购买)(\d+)(份|张)$/,
      );
      if (m && Number.isSafeInteger(+m[3]) && +m[3] > 0)
        limits.push({
          quantity: +m[3],
          period: m[2] ?? "unspecified",
          basis: m[1],
          unit: m[4],
          evidence: e.original,
        });
      else unparsedLimits.push(e.original);
    }
  }
  const audienceKinds = new Set(audience.map((x) => x.kind));
  const audienceConflict =
    audienceKinds.has("all_users") &&
    ["new_customer", "member", "student"].some((x) => audienceKinds.has(x));
  const feeConflict =
    (explicitNoFees && charges.some((x) => x.amount_fen > 0)) ||
    charges.some((x, i) =>
      charges.some(
        (y, j) =>
          i !== j &&
          x.name === y.name &&
          x.basis === y.basis &&
          x.amount_fen !== y.amount_fen,
      ),
    );
  const limitConflict = limits.some((x, i) =>
    limits.some(
      (y, j) =>
        i !== j &&
        x.period === y.period &&
        x.basis === y.basis &&
        x.unit === y.unit &&
        x.quantity !== y.quantity,
    ),
  );
  return {
    version: "restrictions-v2",
    eligibility: {
      facts: audience,
      conflicting: audienceConflict,
      unparsed: unparsedEligibility,
    },
    fees: {
      charges,
      explicit_no_extra_fees: explicitNoFees,
      conflicting: feeConflict,
      unparsed: unparsedFees,
      total_fen: null,
    },
    purchase_limits: {
      facts: limits,
      conflicting: limitConflict,
      unparsed: unparsedLimits,
    },
    complete: false,
  };
}
