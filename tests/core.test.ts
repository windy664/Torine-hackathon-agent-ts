import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventLog, JsonLines, safeText } from "../evolution/events.js";
import { normalizeUsage, startGateway } from "../evolution/gateway.js";
import { command } from "../evolution/process.js";
import { parsePlan, browserInstallCli } from "../evolution/checks.js";
import { preservationFailures } from "../evolution/index.js";

function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), "torine-test-")); }
test("pinned Playwright installer resolves through its declared package bin", async () => {
  const root = fixture(), log = new EventLog(root);
  try {
    const cli = browserInstallCli(); assert.equal(path.basename(cli), "cli.js");
    const result = await command(process.execPath, [cli, "--version"], { cwd: root, timeoutMs: 5000, log });
    assert.equal(result.code, 0, result.output); assert.match(result.output, /Version 1\.57\.0/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("NDJSON handles fragmented UTF-8, garbage and trailing line", () => {
  const values: any[] = [], errors: string[] = [];
  const parser = new JsonLines(value => values.push(value), line => errors.push(line));
  const buffer = Buffer.from('{"text":"你好"}\nnoise\n{"last":true}');
  for (let i = 0; i < buffer.length; i++) parser.push(buffer.subarray(i, i + 1)); parser.finish();
  assert.deepEqual(values, [{ text: "你好" }, { last: true }]); assert.deepEqual(errors, ["noise"]);
});
test("deduplicate CLI/plugin steps, include child sessions and retain unknown billing", () => {
  const root = fixture(), log = new EventLog(root);
  log.ingest({ type: "session.created", properties: { info: { id: "child", parentID: "root" } } });
  log.ingest({ type: "session.created", properties: {} });
  const part = { id: "one", sessionID: "child", type: "step-finish", tokens: { input: 5, cache: { read: 2 } } };
  log.ingest({ type: "step_finish", part }); log.ingest({ type: "message.part.updated", part });
  log.ingest({ type: "gateway.usage", requestId: "good", usage: { input: 9, output: 3 } });
  log.ingest({ type: "gateway.usage", requestId: "missing", usage: null });
  log.ingest({ type: "gateway.request", requestId: "in-flight" });
  assert.equal(log.summary().steps, 1); assert.equal(log.summary().reportedTokens.input, 5);
  assert.equal(log.summary().reportedTokens.output, undefined); assert.equal(log.summary().costCny, null);
  assert.equal(log.summary().gateway.missingUsageRequests, 1);
  assert.equal(log.summary().gateway.pendingRequests, 1);
  assert.equal(log.summary().gateway.allObservedRequestsReportedUsage, false);
  assert.deepEqual(log.summary().sessions, [{ sessionId: "child", parentSessionId: "root" }]);
  fs.rmSync(root, { recursive: true });
});
test("logs redact configured credentials, bearer and common access keys", () => {
  const root = fixture(), secret = "a-local-secret-without-prefix", log = new EventLog(root, [secret]);
  log.emit("model", "sample", { value: secret, bearer: "Bearer xYz12345", key: "ak_abcdefghijklmnopqrstuvw" });
  log.raw("stdout", secret.slice(0, 12)); log.raw("stdout", secret.slice(12)); log.flushRaw();
  for (const file of ["events.jsonl", "stdout.log"]) { const value = fs.readFileSync(path.join(root, file), "utf8"); assert.ok(!value.includes(secret)); assert.ok(!value.includes("xYz12345")); }
  assert.ok(!safeText('authorization=hello').includes("hello")); fs.rmSync(root, { recursive: true });
});
test("usage missing/invalid is not fabricated zero", () => {
  assert.equal(normalizeUsage({}), null); assert.equal(normalizeUsage({ prompt_tokens: -1, completion_tokens: 2 }), null);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 3 }), { input: 10, output: 5, cacheRead: 3 });
});
test("process drains final output and bounds/kills descendants", async () => {
  const root = fixture(), log = new EventLog(root);
  const final = await command(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));"], { cwd: root, timeoutMs: 3000, log });
  assert.equal(final.code, 0); assert.equal(final.output.length, 100000);
  // Allow instrumented Node to spawn its child before measuring termination;
  // a 250ms deadline can expire before the PID exists under parallel load.
  const timed = await command(process.execPath, ["-e", "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(child.pid); setInterval(()=>{},1000);"], { cwd: root, timeoutMs: 1000, log });
  assert.equal(timed.timedOut, true); assert.equal(timed.code, null);
  const pid = Number(timed.output.trim()); assert.ok(pid > 0);
  assert.equal(timed.signal, "SIGTERM");
  const signalled = await command(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], { cwd: root, timeoutMs: 3000, log });
  assert.equal(signalled.code, null); assert.equal(signalled.signal, "SIGTERM"); assert.equal(signalled.timedOut, false);
  // A reparented zombie is terminated, even before PID 1 reaps it.
  if (fs.existsSync(`/proc/${pid}/stat`)) assert.match(fs.readFileSync(`/proc/${pid}/stat`, "utf8"), /\) Z /);
  fs.rmSync(root, { recursive: true });
});
test("public check plans reject invented anchors, code and external navigation", () => {
  const source = "The saved name survives a page reload.";
  const value = { cases: [{ id: "persist", kind: "evolution", sourceQuote: source, steps: [{ action: "goto", path: "/" }, { action: "value", target: { label: "Name" }, expected: "New" }] }] };
  assert.equal(parsePlan(JSON.stringify(value), source).cases.length, 1);
  assert.throws(() => parsePlan(JSON.stringify(value), "Different requirement"), /Unanchored/);
  value.cases[0].steps[0].path = "//external.test/"; assert.throws(() => parsePlan(JSON.stringify(value), source), /relative/);
  value.cases[0].steps[0].path = "/"; (value.cases[0].steps[1] as any).action = "evaluate"; assert.throws(() => parsePlan(JSON.stringify(value), source), /assertion|Unsupported/);
});
test("preservation flags deletion of original database", () => {
  const root = fixture(); assert.match(preservationFailures(root, { "backend/database.db": "missing" }).join(" "), /database/); fs.rmSync(root, { recursive: true });
});
test("proxy counts retry/error and missing-usage requests without logging credentials", async () => {
  const root = fixture(), log = new EventLog(root, ["fixture-credential"]);
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers["x-torine-session-id"], undefined);
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(calls === 1 ? 429 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(calls === 1 ? { error: "rate-limited" } : { usage: { prompt_tokens: 7, completion_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = await startGateway(`http://127.0.0.1:${(server.address() as any).port}/v1`, log);
  try {
    for (let i = 0; i < 2; i++) { const response = await fetch(`${gateway.baseURL}/chat/completions`, { method: "POST", headers: { authorization: "Bearer fixture-credential", "x-torine-session-id": "session", "content-type": "application/json" }, body: JSON.stringify({ model: "mock", messages: [], stream: false }) }); await response.text(); }
    assert.equal(log.summary().gateway.requests, 2); assert.equal(log.summary().gateway.missingUsageRequests, 1);
    assert.ok(!fs.readFileSync(path.join(root, "events.jsonl"), "utf8").includes("fixture-credential"));
  } finally { await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true }); }
});
