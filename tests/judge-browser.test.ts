import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { buildJudgePackets, parseProbePlan } from "../judge-plan.js";
import { runProbes } from "../judge-runner.js";
import { runJudgePhase, type JudgeOptions } from "../judge.js";
import { createFixtureApp, fixturePlan, fixtureRoot } from "./judge-fixture.js";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command: JudgeOptions["command"] = (executable, argv, options) => new Promise((resolve) => {
  const child = spawn(executable, argv, { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk: Buffer): void => { output += chunk.toString(); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, options.timeoutMs || 60_000);
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, output: String(error) }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
});

for (const mode of ["regression", "no-improvement"] as const) {
  test(`Judge rejects ${mode} repair and replays the original application after rollback`, { timeout: 90_000 }, async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "torine-judge-rollback-"));
    const outputDir = path.join(temporary, "app"); const requirementsDir = path.join(temporary, "requirements");
    createFixtureApp(outputDir, true); fs.mkdirSync(requirementsDir);
    fs.writeFileSync(path.join(requirementsDir, "requirements.yaml"), YAML.stringify(fixtureRoot()));
    const source = path.join(outputDir, "backend/app.cjs"); const original = fs.readFileSync(source, "utf8");
    const packet = buildJudgePackets(fixtureRoot())[0];
    const gateway = http.createServer(async (req, res) => {
      for await (const _ of req) { /* drain request */ }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixturePlan(packet)) }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const env = { OPENAI_API_KEY: "local-fixture-key", OPENAI_BASE_URL: `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1`,
      TORINE_SKIP_JUDGE: "0", TORINE_JUDGE_BUDGET_MS: "180000", TORINE_JUDGE_MAX_PLAN_CALLS: "1", TORINE_JUDGE_MAX_REPAIRS: "1",
      TORINE_JUDGE_CASE_TIMEOUT_MS: "6000", TORINE_JUDGE_STEP_TIMEOUT_MS: "500", TORINE_JUDGE_BROWSER_INSTALL: "0" };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
    t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await new Promise<void>((resolve) => gateway.close(() => resolve())); fs.rmSync(temporary, { recursive: true, force: true }); });
    const receipt = await runJudgePhase({ agentRoot, outputDir, requirementsDir, evaluationPort: 3000, modelId: "fixture-model", command,
      log: () => {}, recordState: () => {}, repair: async () => {
        if (mode === "regression") fs.writeFileSync(source, original.replace("const next = input;", "const next = input.trim();").replace("if (next === 'Reserved')", "if (false)"));
        fs.writeFileSync(path.join(outputDir, "rejected.txt"), "unverified modification");
        fs.writeFileSync(path.join(outputDir, "backend/state.json"), JSON.stringify({ name: "corrupted", count: 42 }));
        // Restoring data is part of the rollback obligation, but each candidate
        // must still start from the specified seed during evaluation.
        if (mode === "regression") fs.writeFileSync(path.join(outputDir, "backend/state.json"), JSON.stringify({ name: "Old", count: 0 }));
        return { code: 0, output: "candidate repair" };
      } });
    assert.equal(fs.readFileSync(source, "utf8"), original);
    assert.equal(fs.existsSync(path.join(outputDir, "rejected.txt")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, "backend/state.json"), "utf8")), { name: "Old", count: 0 });
    assert.deepEqual(receipt.report.results.map((r) => r.status), ["failed", "passed", "passed", "passed"]);
    const summary = JSON.parse(fs.readFileSync(receipt.summaryPath, "utf8"));
    assert.match(summary.repairRejected, /improvement|regression/);
    assert.equal(summary.repairs, 1); assert.equal(summary.failedCases, 1);
  });
}

test("real Chromium finds a regression, saves evidence, and isolates every case's persisted data", { timeout: 60_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "torine-browser-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const outputDir = path.join(temporary, "app");
  createFixtureApp(outputDir, true);
  const packet = buildJudgePackets(fixtureRoot())[0];
  const plan = parseProbePlan(JSON.stringify(fixturePlan(packet)), packet);
  const reportPath = path.join(temporary, "evidence", "report.json");
  const report = await runProbes({ outputDir, evaluationPort: 3000, cases: plan.cases, caseTimeoutMs: 6000, stepTimeoutMs: 500, deadline: Date.now() + 45_000 }, reportPath);
  assert.equal(report.infrastructureError, undefined);
  assert.deepEqual(report.results.map((r) => r.status), ["failed", "passed", "passed", "passed"]);
  assert.equal(report.results[0].stepIndex, 4);
  assert.ok(report.results[0].screenshot && fs.existsSync(report.results[0].screenshot));
  assert.ok(report.results[0].error?.includes("Fresh"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, "backend", "state.json"), "utf8")), { name: "Old", count: 0 });
});

test("unresolved locator assumptions remain blocked rather than authorizing product repairs", { timeout: 30_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "torine-locator-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const outputDir = path.join(temporary, "app"); createFixtureApp(outputDir, false);
  const plan = parseProbePlan(JSON.stringify(fixturePlan(buildJudgePackets(fixtureRoot())[0])), buildJudgePackets(fixtureRoot())[0]);
  const action = structuredClone(plan.cases[0]); action.id = "missing-action";
  action.steps[1].locator!.text = "Unsupported name locator";
  const assertion = structuredClone(plan.cases[0]); assertion.id = "missing-assertion";
  assertion.steps.at(-1)!.locator!.text = "Unsupported name locator";
  const report = await runProbes({ outputDir, evaluationPort: 3000, cases: [action, assertion], caseTimeoutMs: 6000, stepTimeoutMs: 500, deadline: Date.now() + 20_000 }, path.join(temporary, "report.json"));
  assert.deepEqual(report.results.map((r) => [r.status, r.failureKind]), [["blocked", "locator"], ["blocked", "locator"]]);
});

test("independent mock planner -> browser failure -> bounded repair -> frozen-plan rerun", { timeout: 90_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "torine-judge-loop-"));
  const outputDir = path.join(temporary, "app");
  const requirementsDir = path.join(temporary, "requirements");
  createFixtureApp(outputDir, true);
  fs.mkdirSync(requirementsDir);
  fs.writeFileSync(path.join(requirementsDir, "requirements.yaml"), YAML.stringify(fixtureRoot()));
  const packet = buildJudgePackets(fixtureRoot())[0];
  const requests: Record<string, unknown>[] = [];
  const gateway = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "mock", object: "chat.completion", created: 0, model: "fixture-model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(fixturePlan(packet)) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as { port: number }).port;
  const env: Record<string, string> = {
    OPENAI_API_KEY: "local-fixture-key", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    TORINE_SKIP_JUDGE: "0", TORINE_JUDGE_BUDGET_MS: "180000", TORINE_JUDGE_MAX_PLAN_CALLS: "1", TORINE_JUDGE_MAX_REPAIRS: "1",
    TORINE_JUDGE_CASE_TIMEOUT_MS: "6000", TORINE_JUDGE_STEP_TIMEOUT_MS: "500", TORINE_JUDGE_BROWSER_INSTALL: "0",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  let repairs = 0;
  const states: string[] = [];
  await runJudgePhase({
    agentRoot, outputDir, requirementsDir, evaluationPort: 3000, modelId: "fixture-model", command,
    log: () => {}, recordState: (id, state) => states.push(`${id}:${state}`),
    repair: async (prompt, _timeout, _log, scopeIds) => {
      assert.deepEqual(scopeIds, ["REQ-1"]);
      repairs += 1;
      assert.match(prompt, /trimmed name survives reload/);
      assert.match(prompt, /Do not edit Judge plans/);
      const source = path.join(outputDir, "backend", "app.cjs");
      fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("const next = input;", "const next = input.trim();"));
      // A Builder editing an on-disk artifact cannot weaken the next run.
      const judge = path.join(outputDir, ".arc", "judge");
      const dir = path.join(judge, fs.readdirSync(judge)[0]);
      fs.writeFileSync(path.join(dir, "plans.json"), JSON.stringify({ cases: [] }));
      return { code: 0, output: "fixed trimming" };
    },
  });
  assert.equal(requests.length, 1);
  const requestText = JSON.stringify(requests[0]);
  assert.ok(!requestText.includes("app.cjs"));
  assert.ok(!requestText.includes("repair-marker"));
  assert.equal(repairs, 1);
  assert.ok(states.includes("REQ-1:failed"));
  assert.equal(states.at(-1), "REQ-1:passed");
  const judgeRoot = path.join(outputDir, ".arc", "judge");
  const dir = path.join(judgeRoot, fs.readdirSync(judgeRoot)[0]);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  assert.equal(summary.status, "completed");
  assert.equal(summary.plannerCalls, 1);
  assert.equal(summary.repairs, 1);
  assert.equal(summary.passedCases, 4);
  assert.equal(summary.failedCases, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plans.json"), "utf8"))[0].cases.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, "backend", "state.json"), "utf8")), { name: "Old", count: 0 });
});
