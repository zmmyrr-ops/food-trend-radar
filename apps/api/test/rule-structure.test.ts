import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  type RuleText,
  ruleChanges,
  structureRules,
} from "../src/rule-structure.js";

const rule = (key: string, ...values: string[]): RuleText => ({
  key,
  name: key,
  value: values.map((content) => ({ content })),
});
test("real rules expose expiry, excluded days and exact windows without assuming full eligibility", async () => {
  const f = JSON.parse(
    await readFile(
      new URL("./fixtures/commodity-sanitized.json", import.meta.url),
      "utf8",
    ),
  );
  const r = structureRules(f.commodity_info.item_groups, f.use_rule_info.body);
  assert.equal(r.validity.purchase_relative_days, 7);
  assert.deepEqual(r.availability.excluded_weekdays, ["周六", "周日"]);
  assert.equal(r.availability.windows.length, 2);
  assert.equal(r.availability.windows[0].start, "11:00");
  assert.equal(r.comparable, false);
  assert.equal(r.fees.amount_fen, null);
  assert.equal(r.benefits[0].items[0].quantity, 1);
});
test("conflicting dates, overnight hours, unknown fees and exceptions stay explicit", () => {
  const r = structureRules(
    [],
    [
      rule(
        "use_date",
        "有效期: 购买后7天内有效",
        "有效期: 购买后30天内有效",
        "可用日期: 周六、周日",
      ),
      rule("use_time", "22:00-02:00", "周末除外 11:00-12:00", "25:00-26:00"),
      rule("other_rules", "非新客也可购买，但会员另付服务费"),
    ],
  );
  assert.equal(r.validity.purchase_relative_days, null);
  assert.equal(r.validity.conflicting, true);
  assert.deepEqual(r.availability.excluded_weekdays, []);
  assert.equal(r.availability.windows[0].overnight, true);
  assert.equal(r.availability.unparsed_times.length, 2);
  assert.equal(r.eligibility.evidence[0], "非新客也可购买，但会员另付服务费");
  assert.equal(r.fees.amount_fen, null);
  assert.equal(structureRules([], []).eligibility.status, "unknown");
});
test("condition comparison ignores order but never treats more restrictions as better value", () => {
  const old = {
    groups: [{ item_list: [{ name: "套餐", count: 1, unit: "份" }] }],
    rules: [
      rule("use_date", "购买后30天内有效"),
      rule("other_rules", "无需预约"),
    ],
  };
  assert.equal(ruleChanges(old).status, "first_baseline");
  assert.equal(
    ruleChanges({ ...old, rules: [...old.rules].reverse() }, old).status,
    "same_returned_conditions",
  );
  const diff = ruleChanges(
    {
      ...old,
      groups: [{ item_list: [{ name: "套餐", count: 2, unit: "份" }] }],
      rules: [
        rule("use_date", "购买后7天内有效"),
        rule("other_rules", "仅限新客"),
      ],
    },
    old,
  );
  assert.deepEqual(diff.changes, [
    "套餐内容或数量",
    "有效期或可用日期",
    "其他限制",
  ]);
  assert.equal(diff.value_verdict, "unverified");
});

test("negated expiry and exception wording cannot turn into hard restrictions", () => {
  const r = structureRules(
    [],
    [
      rule(
        "use_date",
        "不是购买后7天内有效",
        "不可用日期: 周六除外、国庆节除外、周一至周三",
      ),
    ],
  );
  assert.equal(r.validity.purchase_relative_days, null);
  assert.deepEqual(r.availability.excluded_weekdays, ["周一", "周二", "周三"]);
  assert.deepEqual(r.availability.excluded_holidays, []);
});

test("rule difference explains exact old/new restrictions and item quantities, not value", async () => {
  const { ruleDifferences } = await import("../src/rule-structure.js");
  const previous = {
    groups: [
      {
        group_name: "套餐",
        item_list: [{ name: "牛肉", count: 1, unit: "份" }],
      },
    ],
    rules: [
      rule("use_date", "购买后30天内有效"),
      rule("other_rules", "另收服务费10元/人"),
    ],
  };
  const current = {
    groups: [
      {
        group_name: "套餐",
        item_list: [{ name: "牛肉", count: 2, unit: "份" }],
      },
    ],
    rules: [rule("use_date", "购买后7天内有效")],
  };
  const d = ruleDifferences(current, previous);
  assert.equal(d[0].before[0], "套餐：牛肉 × 1份");
  assert.equal(d[0].after[0], "套餐：牛肉 × 2份");
  assert.deepEqual(d.find((x) => x.field === "use_date")?.before, [
    "购买后30天内有效",
  ]);
  assert.deepEqual(d.find((x) => x.field === "other_rules")?.after, []);
  assert.deepEqual(
    ruleDifferences(previous, {
      ...previous,
      rules: [...previous.rules].reverse(),
    }),
    [],
  );
});

test("second precision windows retain exact boundaries and reject invalid seconds or contextual exceptions", () => {
  const r = structureRules(
    [],
    [
      rule(
        "use_time",
        "00:00:00-23:59:59",
        "22:00:30-02:00:15",
        "12:00:01-12:00",
        "11:00:60-12:00:00",
        "周末除外 11:00:00-12:00:00",
      ),
    ],
  );
  assert.deepEqual(r.availability.windows[0], {
    start: "00:00:00",
    end: "23:59:59",
    overnight: false,
  });
  assert.equal(r.availability.windows[1].overnight, true);
  assert.equal(r.availability.windows[2].overnight, true);
  assert.equal(r.availability.unparsed_times.length, 2);
  assert.equal(r.comparable, false);
});
