// Actual pinned OpenCode, local deterministic gateway, real owned app processes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Engine } from "../evolution/engine.js";
import { EventLog } from "../evolution/events.js";
import { startGateway } from "../evolution/gateway.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))), root = process.env.TORINE_AGENT_ROOT || repo;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-devtools-protocol-"));
const workspace = path.join(temp, "app"); fs.cpSync(path.join(repo, "tests/fixtures/app"), workspace, { recursive: true });
execFileSync(process.execPath, ["build.cjs"], { cwd: path.join(workspace, "frontend") });
const log = new EventLog(path.join(temp, "logs"), ["fixture-not-real"]);
const calls: any[] = []; let failure: Error | undefined;
const tasks = [
  { name: "bash", args: { command: "npm run start", description: "Should be refused in favor of managed app" } },
  { name: "torine_app", args: { action: "start", readyPath: "/" } },
  { name: "torine_check", args: { directory: "backend", timeoutSeconds: 10,
    command: `node -e 'fetch(process.env.BASE_URL+"/api/value",{method:"POST",body:JSON.stringify({name:"Private change"})}).then(r=>{if(!r.ok)process.exit(3);return r.text()}).then(console.log)'` } },
  { name: "torine_check", args: { directory: "project", timeoutSeconds: 1, command: "node -e 'setInterval(()=>{},1000)'" } },
  { name: "torine_app", args: { action: "status", readyPath: "/" } },
];
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    assert.ok(body.tools.some((tool: any) => tool.function.name === "torine_app"), "Custom managed app tool must be exposed by actual OpenCode");
    assert.ok(!body.tools.some((tool: any) => tool.function.name === "task"), "No all-task subagent fan-out");
    const results = body.messages.filter((message: any) => message.role === "tool");
    const userText = JSON.stringify(body.messages.filter((message: any) => message.role === "user"));
    const timedTurn = userText.includes("TIMEOUT_FIXTURE"), failBudget = userText.includes("FAIL_BUDGET"), otherBudget = userText.includes("OTHER_BUDGET");
    if (timedTurn && results.length) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": intentionally hanging local fixture\n\n"); return; }
    const budgetTask = { name: "torine_check", args: { directory: "project", timeoutSeconds: 2, command: failBudget ? "exit 7" : "exit 0" } };
    const task = timedTurn ? tasks[1] : failBudget ? (results.length < 2 ? budgetTask : undefined) : otherBudget ? (results.length < 1 ? budgetTask : undefined) : tasks[results.length];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: any, reason: string | null) => res.write(`data: ${JSON.stringify({ id: `fixture-${calls.length}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    if (task) send({ role: "assistant", reasoning_content: "Local fixture only", tool_calls: [{ index: 0, id: `call-${results.length}`, type: "function", function: { name: task.name, arguments: JSON.stringify(task.args) } }] }, "tool_calls");
    else send({ role: "assistant", content: "DEVTOOLS_OK" }, "stop");
    res.write(`data: ${JSON.stringify({ id: "fixture-usage", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { failure = error as Error; res.writeHead(500); res.end("Fixture assertion failed"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const gateway = await startGateway(`http://127.0.0.1:${(server.address() as any).port}/v1`, log);
try {
  const engine = new Engine({ root, workspace, privateDir: temp, baseURL: gateway.baseURL, model: "fixture-mock", log,
    reservedPort: 3000, env: { OPENAI_API_KEY: "fixture-not-real" } });
  const result = await engine.turn("fixture", "Exercise managed development tools; this is a local fixture.", 45_000, { phase: "implementation" });
  if (failure) throw failure;
  assert.equal(result.code, 0, result.output.slice(-4000)); assert.match(result.text, /DEVTOOLS_OK/);
  const results = calls.at(-1).messages.filter((message: any) => message.role === "tool");
  assert.equal(results.length, tasks.length); assert.match(JSON.stringify(results[0]), /torine_app/);
  assert.match(JSON.stringify(results[1]), /baseURL/); assert.match(JSON.stringify(results[2]), /Private change/);
  assert.match(JSON.stringify(results[3]), /timedOut/); assert.match(JSON.stringify(results[3]), /true/);
  assert.match(JSON.stringify(results[4]), /running/);
  assert.equal(fs.existsSync(path.join(workspace, "backend/data.json")), false);
  const events = fs.readFileSync(path.join(log.root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const started = events.find(event => event.event === "app_ready"), stopped = events.find(event => event.event === "app_stopped");
  assert.ok(started && stopped && started.pid === stopped.pid, "Turn-end must stop its parent-owned service without asking the model");
  assert.ok(events.some(event => event.event === "tool_progress" && event.tool === "torine_app"));
  assert.ok(events.some(event => event.event === "check_end" && event.timedOut && event.passed === false));
  assert.ok(!fs.readFileSync(path.join(log.root, "progress.log"), "utf8").includes("fixture-not-real"));
  const timed = await engine.turn("timeout-fixture", "TIMEOUT_FIXTURE: start managed app then wait for this local fixture.", 20_000, { phase: "timeout-fixture" });
  assert.equal(timed.timedOut, true); assert.equal(timed.code, null);
  const afterTimeout = fs.readFileSync(path.join(log.root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const timedStart = afterTimeout.find(event => event.phase === "timeout-fixture" && event.event === "app_ready");
  assert.ok(timedStart, "Timeout fixture must actually start a service before interruption");
  assert.ok(afterTimeout.some(event => event.event === "app_stopped" && event.pid === timedStart.pid), "Engine timeout must close parent-owned app");
  const failed = await engine.turn("budget-module", "FAIL_BUDGET: exercise local repeated-failure interruption.", 45_000, { requirement: "REQ-budget", phase: "implementation" });
  assert.equal(failed.aborted, true); assert.equal(failed.code, null); assert.match(failed.stopReason ?? "", /failure-limit/);
  engine.resetSession("budget-module");
  const retry = await engine.turn("budget-module", "FAIL_BUDGET: recreated session must not replenish checks.", 45_000, { requirement: "REQ-budget", phase: "repair" });
  assert.equal(retry.aborted, true); assert.match(retry.stopReason ?? "", /failure-limit/);
  assert.notEqual(retry.sessionId, failed.sessionId);
  const independent = await engine.turn("other-module", "OTHER_BUDGET: independent requirement may still check.", 45_000, { requirement: "REQ-other", phase: "implementation" });
  assert.equal(independent.code, 0, independent.output.slice(-4000));
  const finalEvents = fs.readFileSync(path.join(log.root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(finalEvents.filter(event => event.requirement === "REQ-budget" && event.event === "check_end").length, 2, "Repair session must not execute another test command");
  assert.equal(finalEvents.filter(event => event.requirement === "REQ-budget" && event.event === "selftest_limit_interrupt").length, 2);
  assert.ok(finalEvents.some(event => event.requirement === "REQ-other" && event.event === "check_end" && event.passed === true));
  console.log(JSON.stringify({ result: "PASS", directory: temp, requests: calls.length, realModelRequests: 0,
    checked: ["actual plugin registration", "Bash daemon refusal", "managed readiness", "isolated API write", "finite check timeout", "turn-end service cleanup", "engine-timeout cleanup", "visible tool progress", "failure limit interrupts implementation", "session reset retains requirement budget", "next requirement continues"] }));
} finally { await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
