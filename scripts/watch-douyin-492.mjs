import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// One-off observer for the user-requested run, not a scheduler or collector.
// Only localhost is read; the service remains the sole upstream requester.
const script = new URL("./report-douyin-492.mjs", import.meta.url);
const output = new URL(
  "../catalog/douyin-492-results-2026-09-29.json",
  import.meta.url,
);
for (;;) {
  const child = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
  });
  if (child.status !== 0) {
    console.error("Local reporting failed; collector was not modified.");
    process.exitCode = 1;
    break;
  }
  const report = JSON.parse(await readFile(output, "utf8"));
  console.log(
    JSON.stringify({
      time: report.updated_at,
      phase: report.phase,
      complete: report.completed_brands,
      pages: report.pages,
      groups: report.groups,
      pause_reason: report.pause_reason,
    }),
  );
  if (report.phase !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 45000));
}
