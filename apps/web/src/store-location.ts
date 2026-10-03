export function streetAddress(address: string) {
  return address
    .normalize("NFKC")
    .trim()
    .replace(/(?:地下|地上)?\s*[BＦF]?\d+\s*(?:楼|层|[ＦF])(?:.*)?$/i, "")
    .replace(/\s+/g, "");
}
export function storeLocationQueries(name: string, address: string) {
  const street = streetAddress(address);
  return [
    ...new Set(
      [
        name && street ? `${name.trim()} ${street}` : "",
        name.trim(),
        street,
      ].filter(Boolean),
    ),
  ];
}
export function matchesStreet(candidate: string, expected: string) {
  const road = streetAddress(expected).match(
    /([^区市街道]{2,}(?:路|街|道|弄))\s*(\d+)号/,
  );
  if (!road) return false;
  const normalized = candidate.normalize("NFKC").replace(/\s/g, "");
  return normalized.includes(`${road[1]}${road[2]}号`);
}
