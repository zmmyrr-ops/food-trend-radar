import type { Group } from "./rule-structure.js";
/** This compares returned item quantities only, not full entitlement or real-world value. */
export function increasedQuantities(previous: Group[], current: Group[]) {
  const index = (groups: Group[]) => {
    const entries = new Map<
      string,
      { name: string; unit: string; quantity: number }
    >();
    if (!groups.length) return null;
    for (const group of groups) {
      if (!group.item_list.length) return null;
      if (
        (group.option_count != null || group.total_count != null) &&
        (group.option_count == null ||
          group.total_count == null ||
          group.option_count !== group.total_count)
      )
        return null;
      for (const item of group.item_list) {
        if (
          !item.name ||
          !item.unit ||
          item.count == null ||
          !Number.isFinite(item.count) ||
          item.count <= 0
        )
          return null;
        const key = JSON.stringify([
          group.group_name ?? "",
          group.option_count ?? null,
          group.total_count ?? null,
          item.name,
          item.unit,
        ]);
        if (entries.has(key)) return null;
        entries.set(key, {
          name: item.name,
          unit: item.unit,
          quantity: item.count,
        });
      }
    }
    return entries;
  };
  const before = index(previous),
    after = index(current);
  if (!before || !after || before.size !== after.size) return [];
  const changes: {
    name: string;
    unit: string;
    before: number;
    after: number;
  }[] = [];
  for (const [key, value] of before) {
    const next = after.get(key);
    if (!next || next.quantity < value.quantity) return [];
    if (next.quantity > value.quantity)
      changes.push({
        name: value.name,
        unit: value.unit,
        before: value.quantity,
        after: next.quantity,
      });
  }
  return changes;
}
