import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runEvolution } from "../evolution/index.js";

const testRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.TORINE_AGENT_ROOT || testRoot;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-controller-smoke-"));
const workspace = path.join(temp, "app"); fs.cpSync(path.join(testRoot, "tests/fixtures/app"), workspace, { recursive: true });
const target = path.join(workspace, "frontend/index.html"), originalHtml = fs.readFileSync(target, "utf8");
const quote = "A saved name survives page reload and the interface reports Saved.";
const plan = { cases: [{ id: "persist", kind: "evolution", sourceQuote: quote, steps: [
  { action: "goto", path: "/" }, { action: "value", target: { label: "Name" }, expected: "Original" }, { action: "fill", target: { label: "Name" }, value: "Updated" },
  { action: "click", target: { role: "button", name: "Save" } }, { action: "text", target: { role: "status", name: "" }, expected: "Saved" }, { action: "reload" }, { action: "value", target: { label: "Name" }, expected: "Updated" },
] }] };
let calls = 0, repairCalls = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
  const messages = body.messages, lastUser = messages.findLastIndex((message: any) => message.role === "user");
  const user = typeof messages[lastUser]?.content === "string" ? messages[lastUser].content : JSON.stringify(messages[lastUser]?.content);
  const afterUser = messages.slice(lastUser + 1);
  const used = (name: string) => afterUser.some((message: any) => message.tool_calls?.some((call: any) => call.function.name === name));
  const planning = /Return ONLY JSON/.test(user), repair = /Fix ONLY these observed failures/.test(user);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: any, reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `mock-${calls}`, object: "chat.completion.chunk", model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  const tool = (name: string, input: any) => { send({ role: "assistant", reasoning_content: "Local fixture only" }); send({ tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }); send({}, "tool_calls"); };
  if (planning) {
    assert.ok(!body.tools?.length, "Planner must be one tool-free conversion, not repository exploration");
    if (!body.stream) {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })); return;
    }
    send({ role: "assistant", content: JSON.stringify(plan) }); send({}, "stop");
  } else if (!body.tools?.length) { send({ role: "assistant", content: "Fixture title" }); send({}, "stop"); }
  else if (!used("read")) tool("read", { filePath: target });
  else if (!used("write")) { if (repair) repairCalls++; tool("write", { filePath: target, content: repair ? originalHtml : originalHtml.replace("'Saved'", "'Wrong'") }); }
  else { send({ role: "assistant", content: "Changed frontend/index.html; controller must independently verify." }); send({}, "stop"); }
  res.write(`data: ${JSON.stringify({ id: `mock-${calls}`, object: "chat.completion.chunk", model: body.model, created: 1, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const previous = { ...process.env };
Object.assign(process.env, { MODEL: "fixture-mock", OPENAI_API_KEY: "fixture-credential-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, TORINE_EVOLUTION_TOTAL_MS: "180000", TORINE_FINAL_RESERVE_MS: "30000" });
const events: any[] = [];
const runtime: any = { events: { markImplementationStarted: (...args: any[]) => events.push(args), markImplementationDone: (...args: any[]) => events.push(args) }, git: { commit: () => {} } };
try {
  await runEvolution(runtime, [{ nodeId: "REQ-1", name: "Fixture", rootContext: "This is a local fixture.", moduleContext: "Preserve the original application.", subtree: { id: "REQ-1", description: quote } }], workspace, root, 3000);
  const logDir = path.join(workspace, ".arc/torine", fs.readdirSync(path.join(workspace, ".arc/torine"))[0]);
  const report = JSON.parse(fs.readFileSync(path.join(logDir, "validation.json"), "utf8"));
  assert.equal(repairCalls, 1, "The injected product failure must cause exactly one repair");
  assert.equal(report.packets[0].checks.find((check: any) => check.id === "0-persist").state, "passed");
  assert.equal(report.final.find((check: any) => check.id === "0-persist").state, "passed");
  assert.equal(report.fullRequirementAcceptance, "unknown; local subset checks only");
  assert.equal(report.localStatus, "subset_checked");
  assert.ok(report.usage.gateway.requests >= 7); assert.equal(report.usage.gateway.missingUsageRequests, 0);
  assert.equal(fs.existsSync(path.join(workspace, "backend/data.json")), false, "No probe may write original application data");
  console.log(JSON.stringify({ result: "PASS", directory: temp, calls, repairCalls, report: path.join(logDir, "validation.json") }));
} finally {
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(previous, name)) delete process.env[name]; Object.assign(process.env, previous);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
