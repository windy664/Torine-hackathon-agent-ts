// Explicit development diagnostic against the user's public baseline only.
// Not packed, no model requests, no platform/hidden tests.
import fs from "node:fs";
import path from "node:path";
import { DevTools } from "../evolution/devtools.js";
import { EventLog } from "../evolution/events.js";

const [baselineRoot, reportRoot] = process.argv.slice(2);
if (!baselineRoot || !reportRoot) throw new Error("Usage: tsx tests/devtools-baseline-smoke.ts BASELINE_ROOT REPORT_ROOT");
fs.mkdirSync(reportRoot, { recursive: true });
const reports = [];
for (const task of ["sheet", "github"]) {
  const workspace = path.join(baselineRoot, task), original = fs.readFileSync(path.join(workspace, "backend/database.db"));
  const log = new EventLog(path.join(reportRoot, task));
  const tools = new DevTools({ workspace, log, reservedPort: 3000, context: { phase: "baseline-devtools", requirement: task } });
  try {
    const app = await tools.invoke({ action: "start", readyPath: "/api/health" });
    if (!app.ready || new URL(app.baseURL).port === "3000") throw new Error("Baseline managed app failed readiness/port isolation");
    const check = await tools.invoke({ action: "check", directory: "backend", timeoutSeconds: 5,
      command: `node -e 'fetch(process.env.BASE_URL+"/api/health").then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())})'` });
    if (!check.passed) throw new Error(JSON.stringify(check));
    await tools.invoke({ action: "stop" });
    if (!fs.readFileSync(path.join(workspace, "backend/database.db")).equals(original)) throw new Error("Diagnostic modified baseline database");
    reports.push({ task, app, check, originalDatabaseUnchanged: true, realModelRequests: 0,
      scope: "Managed service lifecycle and existing health route only; not evolution behavior acceptance" });
  } finally { await tools.close(); }
}
fs.writeFileSync(path.join(reportRoot, "result.json"), JSON.stringify(reports, null, 2) + "\n");
console.log(JSON.stringify({ result: "PASS", reports }));
