import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { runProcess } from "../controller-process.js";
import { readEvents } from "../controller-tests.js";

test("real OpenCode loads the plugin, rejects shell tests, and stops after two observable failures", { timeout: 90_000 }, async (t) => {
  const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-opencode-test-"));
  const root = path.join(temp, "app"); fs.mkdirSync(path.join(root, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend/package.json"), JSON.stringify({ scripts: { test: "node fail.cjs" } }));
  fs.writeFileSync(path.join(root, "frontend/fail.cjs"), "console.error('AssertionError: expected trimmed value');process.exit(7)");
  const requests: Record<string, any>[] = [];
  let toolRequests = 0;
  const gateway = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (!body) { res.writeHead(404); res.end(); return; }
    requests.push(JSON.parse(body));
    if (!requests.at(-1)?.tools?.length) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ id: "title", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Local controller check" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const n = ++toolRequests;
    const call = n === 1 ? { name: "bash", arguments: JSON.stringify({ command: "cd frontend && npm run test | head -1", description: "try shell tests" }) }
      : { name: "run_tests", arguments: JSON.stringify({ target: "frontend" }) };
    const delta = n <= 3 ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${n}`, type: "function", function: call }] }
      : { role: "assistant", content: "Completed with unresolved tests." };
    res.setHeader("Content-Type", "text/event-stream");
    for (const [d, finish] of [[delta, null], [{}, n <= 3 ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: `mock-${n}`, object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise<void>((resolve) => gateway.close(() => resolve())); fs.rmSync(temp, { recursive: true, force: true }); });
  const port = (gateway.address() as { port: number }).port;
  const config = path.join(temp, "config.json"); const ledger = path.join(temp, "tests.jsonl"); const control = path.join(temp, "stop.json");
  fs.writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { title: { disable: true } }, plugin: [pathToFileURL(path.join(agentRoot, "controller-plugin.ts")).href],
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "local-fixture-key" }, models: { "fixture-model": { name: "fixture-model" } } } } }));
  const result = await runProcess(path.join(agentRoot, "node_modules/.bin/opencode"), ["run", "--dir", root, "-m", "fixture/fixture-model", "--auto", "Use the testing tool to check the application."], {
    cwd: root, timeoutMs: 70_000, echo: false, controlFile: control, ledgerFile: ledger, turnId: "smoke",
    env: { OPENAI_API_KEY: "local-fixture-key", OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: path.join(temp, "oc-config"),
      XDG_CONFIG_HOME: path.join(temp, "config-home"), XDG_DATA_HOME: path.join(temp, "data-home"), XDG_CACHE_HOME: path.join(temp, "cache-home"),
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", TORINE_TEST_LEDGER: ledger, TORINE_TURN_CONTROL: control, TORINE_TURN_ID: "smoke" },
  });
  const events = readEvents(ledger);
  const diagnostic = JSON.stringify({ events, requests: requests.map((r) => ({ tools: r.tools?.map((item: any) => item.function?.name),
    messages: r.messages?.map((m: any) => ({ role: m.role, tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content.slice(-1000) : "structured" })) })) });
  assert.ok(events.some((e) => e.type === "plugin-ready"), result.output.slice(-8000));
  assert.ok(requests.some((r) => r.tools?.some((tool: any) => tool.function?.name === "run_tests")), result.output.slice(-8000));
  assert.equal(events.filter((e) => e.type === "test-command-rejected").length, 1, diagnostic);
  assert.equal(events.filter((e) => e.type === "test-end" && e.code === 7).length, 2, result.output.slice(-8000));
  assert.equal(result.code, 125, result.output.slice(-8000));
  assert.ok(fs.existsSync(control));
  assert.ok(requests.every((r) => r.tools?.length), "Disabled title agent must not make extra title-generation model calls");
});
