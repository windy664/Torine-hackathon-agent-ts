import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog } from "../evolution/events.js";
import { Engine } from "../evolution/engine.js";
import { startGateway } from "../evolution/gateway.js";

const root = process.env.TORINE_AGENT_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-protocol-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "sample.txt"), "fixture");
const requests: any[] = [];
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  assert.ok(!body.tools?.some((tool: any) => tool.function.name === "task"), "This candidate must not expose subagent dispatch");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const id = "chatcmpl-mock", model = body.model;
  const send = (delta: any, finish_reason: string | null = null, usage?: any) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  const hasToolResult = body.messages.some((message: any) => message.role === "tool");
  if (!hasToolResult) {
    send({ role: "assistant", reasoning_content: "Mock deliberation" });
    send({ tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: path.join(workspace, "sample.txt") }) } }] });
    send({}, "tool_calls", { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 });
  } else {
    send({ role: "assistant", content: "MOCK_OK" }); send({}, "stop", { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90, prompt_cache_hit_tokens: 20 });
  }
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
const log = new EventLog(path.join(tmp, "logs"), ["mock-key-secret"]);
const proxy = await startGateway(`http://127.0.0.1:${port}/v1`, log, () => ({ requirement: "mock" }), { thinking: "enabled", effort: "high" });
try {
  const engine = new Engine({ root, workspace, privateDir: tmp, baseURL: proxy.baseURL, model: "deepseek-mock", log, env: { OPENAI_API_KEY: "mock-key-secret" } });
  const firstTurn = engine.turn("module-one", "Read sample.txt then say MOCK_OK. This is a local protocol fixture.", 60_000, { phase: "first" });
  await assert.rejects(engine.turn("module-two", "Must not start concurrently", 1000), /Concurrent implementation turns/);
  const first = await firstTurn;
  assert.equal(first.code, 0, first.output.slice(-4000)); assert.match(first.text, /MOCK_OK/); assert.equal(first.observerReady, true);
  assert.ok(first.sessionId);
  const second = await engine.turn("module-one", "Say MOCK_OK again without tools.", 45_000, { phase: "resume" });
  assert.equal(second.code, 0, second.output.slice(-4000)); assert.equal(second.sessionId, first.sessionId);
  assert.ok(requests.length >= 3);
  assert.equal(requests.length, 3, "Explicit CLI title should avoid auxiliary title-generation requests in this fixture");
  assert.ok(requests.every(body => body.thinking?.type === "enabled" && body.reasoning_effort === "high"));
  const toolRequest = requests.find(body => body.messages.some((message: any) => message.role === "tool"));
  assert.ok(toolRequest?.messages.some((message: any) => message.role === "assistant" && message.tool_calls?.length && message.reasoning_content === "Mock deliberation"), "reasoning_content must survive tool-result replay");
  const third = await engine.turn("module-two", "Read sample.txt and say MOCK_OK in a new module.", 45_000, { phase: "new-module" });
  assert.equal(third.code, 0, third.output.slice(-4000)); assert.notEqual(third.sessionId, first.sessionId);
  engine.resetSession("module-one");
  const fourth = await engine.turn("module-one", "Read sample.txt and say MOCK_OK after reset.", 45_000, { phase: "reset" });
  assert.equal(fourth.code, 0, fourth.output.slice(-4000)); assert.notEqual(fourth.sessionId, first.sessionId);
  assert.equal(requests.length, 7, "Rejected concurrent turn must create no model request");
  const config = JSON.parse(fs.readFileSync(path.join(tmp, "opencode.json"), "utf8"));
  assert.equal(config.permission.task, "deny"); assert.equal(config.agent.torine.permission.task, "deny");
  assert.equal(log.summary().gateway.missingUsageRequests, 0);
  console.log(JSON.stringify({ result: "PASS", directory: tmp, sessionId: first.sessionId, requests: requests.length, realModelRequests: 0,
    checked: ["same-module continuation", "module isolation", "explicit reset", "no task dispatch", "single writer"], usage: log.summary().gateway }));
} finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
