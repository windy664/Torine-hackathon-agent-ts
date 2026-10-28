import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { detectRunMode } from "../evolution/mode.js";
import { estimate, type Prices } from "../evolution/billing.js";
import { EventLog } from "../evolution/events.js";
import { startGateway } from "../evolution/gateway.js";
import { planPublicChecks, sourceSnapshot } from "../evolution/planner.js";
import { checksSatisfied } from "../evolution/checks.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "torine-observe-test-"));
const prices: Prices = { source: "TEST ONLY", checkedAt: new Date().toISOString(), unit: "CNY / 1M tokens", models: { mock: { input: 3, cacheHit: 0.1, output: 9 } } };
const source = "A saved name survives page reload and the interface reports Saved.";
const validPlan = { cases: [{ id: "persist", kind: "evolution", sourceQuote: source, steps: [
  { action: "goto", path: "/" }, { action: "fill", target: { label: "Name" }, value: "Changed" }, { action: "click", target: { role: "button", name: "Save" } }, { action: "reload" }, { action: "value", target: { label: "Name" }, expected: "Changed" },
] }] };

test("neutral mount path identifies changes in body, not only root title", () => {
  const directory = temp(), file = path.join(directory, "requirements.yaml");
  try {
    for (const payload of [
      { name: "GitHub Collaboration Platform Core Requirements", children: [{ description: "Original Feature Description\nOld\nModified Feature Description\nNew" }] },
      { name: "Original", children: [{ scenarios: [{ name: "Feature - Evolution Scenario 1" }] }] },
      { name: "Evolution Requirements for an Online Spreadsheet Data Workspace" },
    ]) { fs.writeFileSync(file, YAML.stringify(payload)); assert.equal(detectRunMode(directory), "evolution"); }
    fs.writeFileSync(file, YAML.stringify({ name: "Ordinary initial app", description: "Product" })); assert.equal(detectRunMode(directory), "initial");
    const zip = process.env.TORINE_PUBLIC_REQUIREMENTS_ZIP;
    if (zip) for (const task of ["sheet", "github"]) {
      fs.writeFileSync(file, execFileSync("unzip", ["-p", zip, `hackathon-evolution--${task}/requirements.yaml`]));
      assert.equal(detectRunMode(directory), "evolution", `Actual public ${task} document under neutral directory`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("cache-aware CNY estimate never adds reasoning or cache tokens twice", () => {
  const row = { model: "mock", usage: { input: 1_000_000, cacheRead: 900_000, output: 100_000, reasoning: 80_000 } };
  const result = estimate([row], prices);
  assert.ok(Math.abs(result.estimatedCny! - 1.29) < 1e-9); assert.equal(result.billedCny, null); assert.equal(result.complete, true);
  const missing = estimate([row, { model: "mock", usage: null }, { model: "mock", pending: true }], prices);
  assert.equal(missing.estimatedCny, null); assert.equal(missing.upperBoundCny, null); assert.equal(missing.lowerBoundCny, result.estimatedCny);
  const cacheUnknown = estimate([{ model: "mock", usage: { input: 1_000_000, output: 0 } }], prices);
  assert.equal(cacheUnknown.lowerBoundCny, 0.1); assert.equal(cacheUnknown.upperBoundCny, 3); assert.equal(cacheUnknown.complete, false);
  assert.equal(estimate([{ model: "unknown", usage: row.usage }], prices).unpricedRequests, 1);
  assert.equal(estimate([row], prices, Date.now() + 8 * 86400_000).stalePrices, true);
  assert.equal(estimate([{ model: "mock", usage: { input: 10, output: 1, cacheRead: 11 } }], prices).missingUsageRequests, 1);
});
test("hierarchy/severity, compact progress and per-owner costs", () => {
  const directory = temp(), log = new EventLog(directory, [], { runId: "fixture-run", prices });
  try {
    log.phaseStart({ requirement: "REQ-1", phase: "implementation" });
    log.ingest({ type: "gateway.request", requestId: "one", model: "mock", requirement: "REQ-1", phase: "implementation", sessionId: "child" });
    log.ingest({ type: "gateway.usage", requestId: "one", model: "mock", requirement: "REQ-1", phase: "implementation", sessionId: "child", usage: { input: 100, output: 10, cacheRead: 0 } });
    log.emit("model", "reasoning", { text: "DEBUG_DETAIL_ONLY" }); log.phaseEnd("completed");
    const all = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8");
    const progress = fs.readFileSync(path.join(directory, "progress.jsonl"), "utf8");
    assert.match(all, /DEBUG_DETAIL_ONLY/); assert.ok(!progress.includes("DEBUG_DETAIL_ONLY"));
    const events = all.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.every(event => event.runId === "fixture-run" && event.scopePath[0] === "fixture-run" && event.level));
    assert.equal(log.summary().phases[0].status, "completed");
    assert.equal(log.summary().byRequirement['REQ-1'].requests, 1); assert.equal(log.summary().bySession.child.requests, 1);
    assert.equal(log.summary().billing.estimatedCny, log.summary().byRequirement['REQ-1'].billing.estimatedCny);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("interrupted engine turn clears orphan active tools without reporting fake success", () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  try {
    log.ingest({ type: "session.created", properties: { info: { id: "child", parentID: "parent" } } });
    log.ingest({ type: "tool_use", part: { type: "tool", id: "running", sessionID: "child", tool: "read", state: { status: "running", input: { filePath: "app.js" } } } });
    assert.equal(log.summary().activity.activeToolCount, 1); log.endTurn("parent");
    assert.equal(log.summary().activity.activeToolCount, 0); assert.equal(log.summary().activity.completedByCategory.inspection, undefined);
    assert.equal(log.summary().activity.lastObservedTool!.status, "interrupted");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("normal tool progress is visible; heartbeat distinguishes model wait and active command", () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  try {
    log.ingest({ type: "gateway.request", requestId: "waiting", model: "mock", startedAt: new Date(Date.now() - 95000).toISOString() });
    assert.equal(log.summary().activity.waitingOn, "model_request"); assert.ok(log.summary().gateway.oldestPendingRequestMs >= 95000);
    log.heartbeat();
    const part = { type: "tool", id: "a", sessionID: "main", tool: "bash", state: { status: "running", input: { command: "npm run build" } } };
    log.ingest({ type: "tool_use", part }); assert.equal(log.summary().activity.waitingOn, "tool_execution");
    assert.equal(log.summary().activity.activeTools[0].target, "npm run build");
    part.state.status = "completed"; log.ingest({ type: "tool_use", part });
    assert.equal(log.summary().activity.activeToolCount, 0); assert.ok(log.summary().activity.lastCompletedActionAgeMs! < 100);
    const progress = fs.readFileSync(path.join(directory, "progress.jsonl"), "utf8");
    assert.match(progress, /tool_progress/); assert.match(progress, /npm run build/); assert.match(progress, /"level":"WARN"/);
    assert.match(fs.readFileSync(path.join(directory, "progress.log"), "utf8"), /bash completed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("source snapshot is bounded and skips tests, dependencies, secrets and symlinks", () => {
  const directory = temp();
  try {
    fs.mkdirSync(path.join(directory, "frontend/src/tests"), { recursive: true });
    fs.writeFileSync(path.join(directory, "frontend/src/App.tsx"), "const workbook = 1;\n".repeat(10000));
    fs.writeFileSync(path.join(directory, "frontend/src/tests/hidden.test.ts"), "DO_NOT_READ");
    fs.writeFileSync(path.join(directory, "frontend/src/credentials.json"), "DO_NOT_READ");
    fs.symlinkSync("/etc", path.join(directory, "frontend/src/external"));
    const snapshot = sourceSnapshot(directory, "workbook");
    assert.ok(snapshot.text.length <= 20_000); assert.ok(!snapshot.text.includes("DO_NOT_READ"));
    assert.deepEqual(snapshot.paths, ["frontend/src/App.tsx"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("tool-free planner retries malformed/empty plans but refuses silent startup fallback", async () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  let calls = 0, fail = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.tools, undefined); calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fail || calls === 1 ? { cases: [] } : validPlan) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const options = { baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, key: "test-not-real", model: "mock", requirement: source, source, snapshot: "", deadline: Date.now() + 2000, log, context: { phase: "check-planning" } };
  try {
    assert.equal((await planPublicChecks(options)).cases[0].id, "persist"); assert.equal(calls, 2);
    fail = true; await assert.rejects(planPublicChecks(options), /after bounded attempts/); assert.equal(calls, 4);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("planner timeout is bounded and a short second attempt can recover", async () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ } calls++;
    if (calls === 1) return; // Deliberately never finish first response.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const started = Date.now();
  try {
    const plan = await planPublicChecks({ baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, key: "test-not-real", model: "mock", requirement: source, source, snapshot: "", deadline: Date.now() + 1000, log, context: { phase: "check-planning" } });
    assert.equal(plan.cases.length, 1); assert.equal(calls, 2); assert.ok(Date.now() - started < 1500);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("planner repairs API schema with exact feedback, resolves canonical anchors and saves redacted evidence", async () => {
  const directory = temp(), secret = "test-private-model-key", log = new EventLog(directory, [secret], { prices });
  let calls = 0;
  const malformed = { cases: [{ ...validPlan.cases[0], steps: [{ action: "goto", path: "/" }, { action: "api", method: "POST", path: "/api/save", status: "200", body: { note: secret } }] }] };
  const recovered = { cases: [{ ...validPlan.cases[0], sourceQuote: "not a literal quote", sourceRef: "R1" }] };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    const prompt = body.messages[1].content;
    assert.ok(prompt.includes(source)); assert.match(prompt, /"R1"/);
    if (calls === 2) { assert.match(prompt, /steps\[1\]/); assert.match(prompt, /integer status/); assert.match(prompt, /Rejected JSON/); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls === 1 ? malformed : recovered) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const plan = await planPublicChecks({ baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, key: secret, model: "mock", requirement: JSON.stringify({ description: source }), source, snapshot: "", deadline: Date.now() + 3000, log, context: { requirement: "REQ-1", phase: "check-planning" } });
    assert.equal(plan.cases[0].sourceQuote, source); assert.equal(calls, 2);
    const receipts = fs.readdirSync(path.join(directory, "planning")).sort().map(file => fs.readFileSync(path.join(directory, "planning", file), "utf8"));
    assert.equal(receipts.length, 2); assert.ok(receipts.every(text => !text.includes(secret)));
    assert.deepEqual(receipts.map(text => JSON.parse(text).state), ["rejected", "validated"]);
    assert.match(receipts[0], /REDACTED/); assert.match(receipts[0], /Invalid API assertion/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("invented source references remain rejected and every attempt is retained", async () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases: [{ ...validPlan.cases[0], sourceRef: "INVENTED" }] }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(planPublicChecks({ baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, key: "mock", model: "mock", requirement: source, source, snapshot: "", deadline: Date.now() + 2000, log, context: {} }), /Unknown public sourceRef/);
    assert.equal(fs.readdirSync(path.join(directory, "planning")).length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("optional absent helper is not an acceptance failure; required unchecked behavior is", () => {
  assert.equal(checksSatisfied([{ id: "helper", state: "unchecked", required: false, detail: "not applicable" }, { id: "behavior", state: "passed", detail: "executed" }]), true);
  assert.equal(checksSatisfied([{ id: "public-behavior", state: "unchecked", detail: "empty plan" }]), false);
});
test("DeepSeek planning disables thinking while implementation retains high; no silent fallback", async () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  let phase = "check-planning";
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = await startGateway(`http://127.0.0.1:${(server.address() as any).port}/v1`, log, () => ({ phase }), { thinking: "enabled", effort: "high" });
  try {
    for (phase of ["check-planning", "implementation"]) {
      const response = await fetch(`${gateway.baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: false }) }); await response.text();
    }
    assert.deepEqual(bodies[0].thinking, { type: "disabled" }); assert.equal(bodies[0].reasoning_effort, undefined);
    assert.deepEqual(bodies[1].thinking, { type: "enabled" }); assert.equal(bodies[1].reasoning_effort, "high");
  } finally { await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("proxy enforces budget before paid request; records scoped thinking and exact cached price", async () => {
  const directory = temp(), log = new EventLog(directory, [], { prices });
  let calls = 0;
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString())); calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = await startGateway(`http://127.0.0.1:${(server.address() as any).port}/v1`, log, () => ({ requirement: "REQ-1", phase: "implementation" }), { thinking: "enabled", effort: "high" }, { maxEstimatedCny: 0.001 });
  try {
    const call = () => fetch(`${gateway.baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mock", messages: [], stream: false }) });
    assert.equal((await call()).status, 200); assert.equal((await call()).status, 402); assert.equal(calls, 1);
    assert.deepEqual(bodies[0].thinking, { type: "enabled" }); assert.equal(bodies[0].reasoning_effort, "high");
    assert.equal(log.summary().gateway.requests, 1); assert.ok(log.summary().billing.estimatedCny! > 0.001);
  } finally { await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
