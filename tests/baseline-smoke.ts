// Explicit local diagnostic only. This file is never used as task-specific
// implementation logic by the submitted agent. No model requests are made.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { EventLog } from "../evolution/events.js";
import { publicText, parsePlan, runCases, type Plan } from "../evolution/checks.js";

const [baselineRoot, requirementZip, reportDir] = process.argv.slice(2);
if (!baselineRoot || !requirementZip || !reportDir) throw new Error("Usage: tsx tests/baseline-smoke.ts BASELINE_ROOT PUBLIC_REQUIREMENTS_ZIP REPORT_DIR");
const log = new EventLog(reportDir);
const reports: any[] = [];
for (const task of ["sheet", "github"]) {
  const requirement = YAML.parse(execFileSync("unzip", ["-p", requirementZip, `hackathon-evolution--${task}/requirements.yaml`], { encoding: "utf8", maxBuffer: 3_000_000 }));
  const source = publicText(requirement);
  const key = task === "sheet" ? "workbook" : "Sign in", position = source.indexOf(key);
  if (position < 0) throw new Error(`Public source does not support diagnostic ${task}`);
  const quote = source.slice(Math.max(0, position - 30), position + 80);
  const cases: Plan = task === "sheet" ? { cases: [{ id: "sheet-navigation", kind: "regression", sourceQuote: quote, steps: [
    { action: "goto", path: "/" }, { action: "visible", target: { role: "button", name: "New blank workbook" } },
    { action: "click", target: { role: "link", name: "Q3 Sales" } }, { action: "visible", target: { role: "gridcell", name: "A1" } },
    { action: "visible", target: { role: "tab", name: "Sheet1" } }, { action: "reload" }, { action: "visible", target: { role: "gridcell", name: "A1" } },
  ] }] } : { cases: [{ id: "github-auth-navigation", kind: "regression", sourceQuote: quote, steps: [
    { action: "goto", path: "/" }, { action: "click", target: { role: "link", name: "Sign in" } },
    { action: "visible", target: { label: "Username or email" } }, { action: "visible", target: { label: "Password" } },
  ] }, { id: "github-login-persistence", kind: "regression", sourceQuote: "account `alice-dev`, email `alice.dev@example.test`, password `Valid-password-123!`", steps: [
    { action: "goto", path: "/" }, { action: "click", target: { role: "link", name: "Sign in" } },
    { action: "fill", target: { label: "Username or email" }, value: "alice-dev" }, { action: "fill", target: { label: "Password" }, value: "Valid-password-123!" },
    { action: "click", target: { role: "button", name: "Sign in" } }, { action: "visible", target: { role: "button", name: "Account menu" } },
    { action: "reload" }, { action: "visible", target: { role: "button", name: "Account menu" } },
    { action: "click", target: { role: "button", name: "Account menu" } }, { action: "click", target: { role: "link", name: "Settings" } },
    { action: "visible", target: { role: "heading", name: "Settings" } },
  ] }] };
  parsePlan(JSON.stringify(cases), source);
  const before = new Map<string, Buffer>();
  for (const file of ["backend/database.db", "backend/src/database/db_runtime.js"]) before.set(file, fs.readFileSync(path.join(baselineRoot, task, file)));
  const result = await runCases(path.join(baselineRoot, task), cases, log, Date.now() + 120_000, 3000);
  for (const [file, bytes] of before) if (!fs.readFileSync(path.join(baselineRoot, task, file)).equals(bytes)) throw new Error(`Diagnostic mutated original baseline ${task}/${file}`);
  reports.push({ task, result, originalDataUnchanged: true, caveat: "Small baseline smoke only; not evolution acceptance or a comparison run. Dependencies reused locally; not a clean container test." });
}
fs.writeFileSync(path.join(reportDir, "baseline-smoke.json"), JSON.stringify(reports, null, 2) + "\n");
console.log(JSON.stringify(reports));
