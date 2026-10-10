import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { runProcess } from "../controller-process.js";
import { readEvents, sharedTestBudget } from "../controller-tests.js";
import type { JudgePacket } from "../judge-plan.js";
import { createFixtureApp, fixturePlan, fixtureRoot } from "./judge-fixture.js";

for (const { regress, priority } of [{regress:false,priority:false},{regress:true,priority:false},{regress:false,priority:true}]) test(`${priority ? "delta priority and shared allowance: " : ""}full controller stops a self-test loop, ${priority ? "skips an exhausted diagnosis" : "diagnoses once"}, reuses plans and ${regress ? "rolls back module regression" : "delivers unchanged working behavior"}`, { timeout: 240_000 }, async (t) => {
  const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-pipeline-test-"));
  const root = path.join(temp, "app"); const requirements = path.join(temp, "requirements");
  createFixtureApp(root, false); fs.mkdirSync(requirements);
  const originalBackend = fs.readFileSync(path.join(root, "backend/app.cjs"), "utf8");
  fs.writeFileSync(path.join(root, "frontend/fail.cjs"), "console.error('AssertionError: generated self-test fixture is broken');process.exit(7)");
  const pkgPath = path.join(root, "frontend/package.json"); const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.scripts.test = "node fail.cjs"; fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const contract = fixtureRoot() as any;
  contract.children.push({ ...structuredClone(contract.children[0]), id: "REQ-2", name: "Second module" });
  if (priority) {
    contract.children[0].description = "Existing behavior: Trim names and reject Reserved.";
    contract.children[1].description += "\nModified Feature Description\nRetain the published behavior.";
  }
  const firstId = priority ? "REQ-2" : "REQ-1";
  fs.writeFileSync(path.join(requirements, "requirements.yaml"), YAML.stringify(contract));
  let plannerCalls = 0; let titleCalls = 0;
  const diagnosticPrompts = new Set<string>();
  const gateway = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (!body) { res.writeHead(404); res.end(); return; }
    const request = JSON.parse(body);
    if (!request.tools?.length && /black-box acceptance planner/.test(request.messages?.[0]?.content || "")) {
      plannerCalls++;
      const packet = JSON.parse(request.messages[1].content) as JudgePacket;
      const cases = packet.requirements.flatMap((requirement) => {
        const plan = fixturePlan({ ...packet, requirements: [requirement] }) as any;
        return plan.cases.map((c: any) => ({ ...c, id: `${requirement.id}-${c.id}` }));
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "planner", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ packetId: packet.id, cases, uncovered: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    if (!request.tools?.length) titleCalls++;
    const user = request.messages?.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n") || "";
    const toolCount = request.messages?.filter((m: any) => m.role === "tool").length || 0;
    const diagnostic = /DIAGNOSTIC: The controller/.test(user);
    if (diagnostic) diagnosticPrompts.add(user);
    const loop = /Incrementally implement ROOT module 1\/2/.test(user) && !diagnostic;
    const introduceRegression = regress && /Incrementally implement ROOT module 2\/2/.test(user) && toolCount === 0;
    const callTest = loop || diagnostic && toolCount === 0;
    const callTool = callTest || introduceRegression;
    const selectedTool = introduceRegression ? { name: "write", arguments: JSON.stringify({ filePath: path.join(root, "backend/app.cjs"), content: originalBackend.replace("const next = input.trim()", "const next = input") }) }
      : { name: "run_tests", arguments: JSON.stringify({ target: "frontend" }) };
    const delta = callTool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${toolCount}`, type: "function", function: selectedTool }] }
      : { role: "assistant", content: diagnostic ? "Generated self-tests still fail; unresolved. Stop and retain the runnable application." : "Completed; existing application preserved." };
    res.setHeader("Content-Type", "text/event-stream");
    for (const [d, finish] of [[delta, null], [{}, callTool ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise<void>((resolve) => gateway.close(() => resolve())); fs.rmSync(temp, { recursive: true, force: true }); });
  const port = (gateway.address() as { port: number }).port;
  const result = await runProcess("node", [path.join(agentRoot, "node_modules/tsx/dist/cli.mjs"), path.join(agentRoot, "index.ts"), requirements, "--output-dir", root], {
    cwd: agentRoot, timeoutMs: 210_000, echo: false,
    env: { MODEL: "fixture/fixture-model", OPENAI_API_KEY: "local-fixture-key", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      XDG_CONFIG_HOME: path.join(temp, "config-home"), XDG_DATA_HOME: path.join(temp, "data-home"), XDG_CACHE_HOME: path.join(temp, "cache-home"),
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      TORINE_TEST_FAILURE_LIMIT: priority ? "2" : "4",
      TORINE_RUN_BUDGET_MS: "240000", TORINE_MAX_ENGINE_TURNS: "6", TORINE_JUDGE_MAX_PLAN_CALLS: "1",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache/ms-playwright"),
      TORINE_JUDGE_BROWSER_INSTALL: "0", TORINE_JUDGE_STEP_TIMEOUT_MS: "500", TORINE_JUDGE_CASE_TIMEOUT_MS: "6000" },
  });
  assert.equal(result.code, 0, result.output.slice(-15000));
  assert.equal(diagnosticPrompts.size, priority ? 0 : 1, result.output.slice(-15000));
  assert.equal(plannerCalls, 1, result.output.slice(-15000)); assert.equal(titleCalls, 0);
  assert.ok(result.output.includes(`[boundary] independently checking ${firstId}`));
  assert.ok(result.output.indexOf(`[boundary] independently checking ${firstId}`) < result.output.indexOf("[module 2/2]"));
  if (priority) {
    assert.ok(result.output.indexOf("[module 1/2] REQ-2") < result.output.indexOf("[module 2/2] REQ-1"));
    const evidenceDir = result.output.match(/evidence saved to (.+)\/judge\//)?.[1];
    assert.ok(evidenceDir, "controller must retain its independent evidence directory");
    const ledger = path.join(evidenceDir, "tests.jsonl");
    const checks = readEvents(ledger).filter(e => e.type === "test-end");
    assert.equal(checks.length, 2, "shared allowance must stop the deliberately looping model after two tests");
    assert.ok(checks.every(e => JSON.stringify(e.scopeIds) === '["REQ-2"]' && e.code === 7));
    assert.equal(sharedTestBudget({ root, ledger, control: "", turnId: "fresh-repair", scopeIds: [firstId], timeoutMs: 120000, repeatLimit: 2, failureLimit: 2 }).exhausted, true);
  }
  const receipts = fs.readdirSync(path.join(root, ".arc/controller")).filter((f) => f.startsWith("verification-")).map((f) => JSON.parse(fs.readFileSync(path.join(root, ".arc/controller", f), "utf8")));
  assert.equal(receipts.length, regress ? 4 : 3, result.output.slice(-15000));
  if (regress) {
    assert.match(result.output, /lost previously passing evidence; restoring its application checkpoint/);
    assert.ok(receipts.some((r) => r.states["REQ-1"] === "failed"));
  }
  assert.equal(fs.readFileSync(path.join(root, "backend/app.cjs"), "utf8"), originalBackend);
  assert.equal(receipts.find((r) => r.scopeIds === "final").states["REQ-2"], "passed");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "backend/state.json"), "utf8")), { name: "Old", count: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, `.arc/controller/${firstId}.json`), "utf8")).diagnosticUsed, !priority);
});
