// Read only local API; never replays upstream requests or reads credentials.
const runId = process.argv[2];
if (!/^[\da-f-]{36}$/i.test(runId ?? ""))
  throw new Error("请提供采集轮次 UUID");
async function read(path) {
  const response = await fetch(`http://127.0.0.1:3001/api/v3${path}`);
  if (!response.ok) throw new Error(`本地 API ${response.status}`);
  return response.json();
}
const [tasks, requests, status, runs] = await Promise.all([
  read(`/runs/${runId}`),
  read(`/runs/${runId}/requests?limit=1`),
  read("/status"),
  read("/runs"),
]);
console.log(
  JSON.stringify(
    {
      run_id: runId,
      exported_at: new Date().toISOString(),
      run: runs.items.find((r) => r.id === runId) ?? null,
      pause_reason: status.pause_reason,
      audit: requests.summary,
      totals: {
        brands: tasks.items.length,
        complete: tasks.items.filter((t) => t.state === "complete").length,
        pages: tasks.items.reduce((n, t) => n + t.pages, 0),
        recalled: tasks.items.reduce((n, t) => n + t.recalled, 0),
        name_matched: tasks.items.reduce((n, t) => n + t.matched, 0),
      },
      tasks: tasks.items,
      caveat: "分页完成不等于品牌全量覆盖；名称匹配不等于身份及权益核验。",
    },
    null,
    2,
  ),
);
