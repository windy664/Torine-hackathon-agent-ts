// Real CLI entrypoint, fake model only. No platform requests or hidden tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.TORINE_AGENT_ROOT || repo;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "torine-entrypoint-"));
const quote = "A saved name survives page reload and the interface reports Saved.";
const plan = { cases: [{ id: "save-reload", kind: "evolution", sourceQuote: quote, steps: [
  { action: "goto", path: "/" }, { action: "fill", target: { label: "Name" }, value: "Updated" },
  { action: "click", target: { role: "button", name: "Save" } }, { action: "text", target: { role: "status", name: "" }, expected: "Saved" },
  { action: "reload" }, { action: "value", target: { label: "Name" }, expected: "Updated" },
] }] };
let blockPlanning = false, mixedPlanning = false, recoverPlanning = false, interruptImplementation = false, implementationRequests = 0, planningRequests = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const lastUser = body.messages.findLast((message: any) => message.role === "user");
  const user = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content)
    ? lastUser.content.map((part: any) => part.text ?? "").join("\n") : JSON.stringify(lastUser?.content);
  if (!body.stream) {
    planningRequests++; assert.equal(body.tools, undefined); assert.match(user, /Return ONLY JSON/);
    res.writeHead(200, { "content-type": "application/json" });
    const repairing = user.includes("Previous conversion failed:");
    const invalid = { cases: [{ ...plan.cases[0], steps: [{ action: "goto", path: "/" }, { action: "api", path: "/api/save", method: "POST", status: "200" }] }] };
    const unavailable = blockPlanning || mixedPlanning && user.includes('"id": "REQ-1-2"');
    const answer = unavailable ? repairing ? { cases: [{ ...plan.cases[0], sourceQuote: "Invented reference text not in any requirement" }] } : invalid : recoverPlanning && !repairing ? invalid : plan;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })); return;
  }
  implementationRequests++;
  if (interruptImplementation) fs.appendFileSync(path.join(directory, "interruption-routing.jsonl"), JSON.stringify({
    matched: user.includes("INTERRUPT_FIXTURE_FIRST_PACKET"), userType: typeof lastUser?.content,
    parts: Array.isArray(lastUser?.content) ? lastUser.content.map((part: any) => part.type) : null,
    requirementIds: [...new Set(user.match(/REQ-\d+(?:-\d+)*/g) ?? [])],
  }) + "\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (interruptImplementation && user.includes("INTERRUPT_FIXTURE_FIRST_PACKET")) {
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `fail-${implementationRequests}`, type: "function", function: { name: "torine_check", arguments: JSON.stringify({ directory: "project", command: "exit 7", timeoutSeconds: 2 }) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })}\n\n`);
    res.end("data: [DONE]\n\n"); return;
  }
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture already has correct behavior; independently check it." }, finish_reason: "stop" }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const results: any[] = [];
const allKinds = ["github", "sheet", "degraded", "recovered", "mixed", "interrupted"];
const selectedKinds = process.argv.slice(2);
if (selectedKinds.some(kind => !allKinds.includes(kind))) throw new Error("Unknown entrypoint fixture case");
try {
  for (const kind of selectedKinds.length ? selectedKinds : allKinds) {
    blockPlanning = kind === "degraded"; recoverPlanning = kind === "recovered"; mixedPlanning = kind === "mixed"; interruptImplementation = kind === "interrupted";
    const area = path.join(directory, kind), requirements = path.join(area, "requirements"), workspace = path.join(area, "output");
    console.log(JSON.stringify({ event: "fixture_case_started", kind, directory: area, realModelRequests: 0 }));
    fs.mkdirSync(requirements, { recursive: true }); fs.cpSync(path.join(repo, "tests/fixtures/app"), workspace, { recursive: true });
    const before = fs.readFileSync(path.join(workspace, "frontend/index.html"));
    const document = { id: "ROOT", name: kind === "sheet" ? "Evolution Requirements for an Online Spreadsheet Data Workspace" : "GitHub Collaboration Platform Core Requirements", children: [
      { id: "REQ-1", name: "Local fixture", description: "Preserve the original application.", children: [{ id: "REQ-1-1", description: `Original Feature Description\nKeep the existing form.\nModified Feature Description\n${quote}` }] },
    ] };
    if (interruptImplementation) document.children[0].children[0].description += "\nINTERRUPT_FIXTURE_FIRST_PACKET";
    if (blockPlanning || mixedPlanning || interruptImplementation) document.children[0].children.push({ id: "REQ-1-2", description: `Modified Feature Description\n${quote}` });
    fs.writeFileSync(path.join(requirements, "requirements.yaml"), YAML.stringify(document));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|COOKIE|SECRET|ARCBENCH_|ARC_BENCH_/.test(key)) delete env[key];
    // Include cold pinned-OpenCode initialization and two browser-checked
    // packets; 100s of work can legitimately leave <60s for packet two.
    Object.assign(env, { MODEL: "fixture-mock", OPENAI_API_KEY: "fixture-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, TORINE_EVOLUTION_TOTAL_MS: "240000", TORINE_FINAL_RESERVE_MS: "30000" });
    const oldImplementations = implementationRequests, oldPlans = planningRequests;
    const result = await new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "index.ts"), requirements, "--output-dir", workspace, "--web-port", "3000"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => output += chunk);
      child.on("error", error => output += String(error));
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 180_000);
      child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    fs.writeFileSync(path.join(area, "cli.log"), result.output, { mode: 0o600 });
    assert.match(result.output, /"event":"entrypoint","mode":"evolution"/);
    const logs = path.join(workspace, ".arc/torine");
    const reportFile = path.join(logs, fs.readdirSync(logs)[0], "validation.json");
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    if (interruptImplementation) {
      assert.equal(result.code, 0, result.output.slice(-2500)); assert.equal(report.blocked, null);
      assert.equal(report.localStatus, "partial"); assert.equal(report.deliveryStatus, "ready_for_platform_evaluation");
      assert.deepEqual(report.incomplete, ["REQ-1-1"]); assert.deepEqual(report.unstarted, []);
      assert.equal(report.packets.length, 2); assert.equal(implementationRequests - oldImplementations, 3);
      assert.equal(report.packets[0].implementationAborted, true);
      assert.match(report.packets[0].implementationStopReason, /failure-limit/);
      assert.ok(report.packets[0].checks.some((check: any) => check.id === "implementation-execution" && check.state === "unchecked"));
      assert.equal(report.packets[1].implementationExit, 0, "Later packet must still reach real OpenCode");
      assert.ok(report.packets[1].checks.some((check: any) => check.id === "1-save-reload" && check.state === "passed"));
    } else if (blockPlanning) {
      assert.equal(result.code, 0, result.output.slice(-2000)); assert.equal(report.blocked, null);
      assert.equal(report.localStatus, "partial");
      assert.equal(implementationRequests - oldImplementations, 2, "Both packets must still reach real OpenCode despite rejected plans");
      assert.equal(planningRequests - oldPlans, 4, "Only two bounded planning attempts per packet");
      assert.equal(report.packets.length, 2); assert.deepEqual(report.unstarted, []);
      assert.deepEqual(report.incomplete, ["REQ-1-1", "REQ-1-2"]);
      assert.ok(report.packets.every((packet: any) => packet.planningStatus === "unavailable" && packet.checks.some((check: any) => check.state === "unchecked")));
      assert.equal(report.final.filter((check: any) => check.id.startsWith("unverified-")).length, 2);
      assert.ok(!result.output.includes('"event":"implementation_done"'), "Degraded checks cannot grant requirement completion");
      const receipts = fs.readdirSync(path.join(path.dirname(reportFile), "planning")); assert.equal(receipts.length, 4);
      assert.ok(!report.final.some((check: any) => check.id === "public-behavior" && check.state === "passed"));
    } else if (mixedPlanning) {
      assert.equal(result.code, 0, result.output.slice(-2500)); assert.equal(report.blocked, null);
      assert.equal(report.localStatus, "partial"); assert.equal(report.packets.length, 2);
      assert.deepEqual(report.incomplete, ["REQ-1-2"]); assert.deepEqual(report.unstarted, []);
      assert.equal(implementationRequests - oldImplementations, 2); assert.equal(planningRequests - oldPlans, 3);
      assert.equal(report.packets[0].planningStatus, "validated"); assert.equal(report.packets[1].planningStatus, "unavailable");
      assert.ok(report.packets[1].checks.some((check: any) => check.id === "0-save-reload" && check.state === "passed"));
      assert.ok(report.packets[1].checks.some((check: any) => check.id === "1-public-behavior" && check.state === "unchecked"), "Earlier successful checks cannot mask the missing current plan");
      assert.ok(report.final.some((check: any) => check.id === "unverified-REQ-1-2" && check.state === "unchecked"));
    } else {
      assert.equal(result.code, 0, result.output.slice(-2500)); assert.equal(report.blocked, null);
      assert.equal(report.localStatus, "subset_checked");
      assert.equal(report.packets[0].checks.find((check: any) => check.id === "0-save-reload").state, "passed");
      assert.equal(report.final.find((check: any) => check.id === "0-save-reload").state, "passed");
      if (recoverPlanning) assert.equal(planningRequests - oldPlans, 2, "Rejected API schema must recover with feedback");
    }
    assert.ok(fs.readFileSync(path.join(workspace, "frontend/index.html")).equals(before), "CLI must preserve injected baseline");
    assert.equal(fs.existsSync(path.join(workspace, "backend/data.json")), false, "Checks cannot write delivery data");
    results.push({ kind, code: result.code, report: reportFile, planningRequests: planningRequests - oldPlans, implementationRequests: implementationRequests - oldImplementations });
    console.log(JSON.stringify({ event: "fixture_case_completed", kind, code: result.code, localStatus: report.localStatus }));
  }
  console.log(JSON.stringify({ result: "PASS", directory, realModelRequests: 0, results }));
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
