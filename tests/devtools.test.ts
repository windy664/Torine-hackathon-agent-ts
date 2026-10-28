import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { DevTools } from "../evolution/devtools.js";
import { EventLog } from "../evolution/events.js";
import { SelfTestBudget } from "../evolution/selftest-budget.js";

function fixture(options: { startupMs?: number; leaseMs?: number; maxCheckMs?: number;
  maxChecks?: number; maxFailures?: number; maxSelfTestMs?: number; budget?: SelfTestBudget } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "torine-devtools-test-")), workspace = path.join(root, "app");
  fs.cpSync(path.resolve("tests/fixtures/app"), workspace, { recursive: true });
  execFileSync(process.execPath, ["build.cjs"], { cwd: path.join(workspace, "frontend") });
  const log = new EventLog(path.join(root, "logs"), ["fixture-model-credential"]);
  const tools = new DevTools({ workspace, log, reservedPort: 3000, context: { requirement: "fixture", phase: "implementation" }, ...options });
  return { root, workspace, log, tools, cleanup: async () => { await tools.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function terminated(pid: number) {
  const stat = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, "utf8") : "";
  return !stat || /\) Z /.test(stat);
}
test("managed app uses isolated source/data, serial starts, non-evaluation port and owned cleanup", async () => {
  const f = fixture(); let pid = 0;
  try {
    const [first, second] = await Promise.all([f.tools.invoke({ action: "start", readyPath: "/" }), f.tools.invoke({ action: "start", readyPath: "/" })]);
    assert.equal(first.baseURL, second.baseURL); assert.ok(first.ready); assert.notEqual(new URL(first.baseURL).port, "3000");
    const result = await f.tools.invoke({ action: "check", directory: "backend", timeoutSeconds: 2,
      command: `node -e 'fetch(process.env.BASE_URL+"/api/value",{method:"POST",body:JSON.stringify({name:"Private"})}).then(r=>r.text()).then(console.log)'` });
    assert.equal(result.passed, true); assert.match(result.output, /Private/);
    assert.equal(fs.existsSync(path.join(f.workspace, "backend/data.json")), false);
    const records = fs.readFileSync(path.join(f.log.root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const starts = records.filter((e: any) => e.event === "app_ready"); assert.equal(starts.length, 1); pid = starts[0].pid;
    await f.tools.invoke({ action: "stop" }); assert.equal((await f.tools.invoke({ action: "status" })).running, false);
    assert.ok(terminated(pid));
  } finally { await f.cleanup(); }
});
test("readiness is bounded, failed startup is not success and large service output is drained", async () => {
  const f = fixture({ startupMs: 3000 });
  try {
    fs.writeFileSync(path.join(f.workspace, "backend/server.cjs"), "process.stdout.write('x'.repeat(200000)); setInterval(()=>{},1000)");
    const started = Date.now(); await assert.rejects(f.tools.invoke({ action: "start", readyPath: "/" }), /readiness timed out/);
    assert.ok(Date.now() - started < 6000); assert.equal((await f.tools.invoke({ action: "status" })).running, false);
    fs.writeFileSync(path.join(f.workspace, "backend/server.cjs"), "process.stdout.write('x'.repeat(200000)); require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')");
    assert.equal((await f.tools.invoke({ action: "start", readyPath: "/" })).ready, true);
  } finally { await f.cleanup(); }
});
test("finite checks cap timeout, kill descendants, preserve failed exits, redact output and strip credentials", async () => {
  const f = fixture({ maxCheckMs: 1000 }), prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-model-credential";
  try {
    const env = await f.tools.invoke({ action: "check", directory: "project", timeoutSeconds: 50,
      command: "node -e 'console.log(process.env.OPENAI_API_KEY || \"NO_KEY\"); console.log(\"fixture-model-credential\")'" });
    assert.equal(env.passed, true); assert.match(env.output, /NO_KEY/); assert.ok(!env.output.includes("fixture-model-credential"));
    const bad = await f.tools.invoke({ action: "check", directory: "project", command: "exit 7", timeoutSeconds: 50 });
    assert.equal(bad.code, 7); assert.equal(bad.passed, false);
    const hung = await f.tools.invoke({ action: "check", directory: "project", timeoutSeconds: 50,
      command: `node -e 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log(c.pid); setInterval(()=>{},1000)'` });
    assert.equal(hung.timedOut, true); assert.equal(hung.passed, false); assert.equal(hung.code, null);
    const pid = Number(hung.output.trim()); assert.ok(pid > 0); assert.ok(terminated(pid));
  } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; await f.cleanup(); }
});
test("service lease expires, closes the owned service and does not become a functional pass", async () => {
  const f = fixture({ leaseMs: 70 });
  try {
    await f.tools.invoke({ action: "start", readyPath: "/" }); await pause(250);
    assert.equal((await f.tools.invoke({ action: "status" })).running, false);
    const text = fs.readFileSync(path.join(f.log.root, "events.jsonl"), "utf8"); assert.match(text, /app_lease_expired/);
    assert.ok(!text.includes('"fullRequirementAcceptance":true'));
  } finally { await f.cleanup(); }
});
test("lease expiry interrupts a hanging check before queued service cleanup", async () => {
  const f = fixture({ leaseMs: 150 });
  try {
    await f.tools.invoke({ action: "start", readyPath: "/" });
    const started = Date.now();
    const result = await f.tools.invoke({ action: "check", directory: "project", timeoutSeconds: 120, command: "node -e 'setInterval(()=>{},1000)'" });
    assert.equal(result.aborted, true); assert.equal(result.passed, false); assert.ok(Date.now() - started < 1800);
    await pause(100); assert.equal((await f.tools.invoke({ action: "status" })).running, false);
  } finally { await f.cleanup(); }
});
test("controller close cancels an in-flight check and is idempotent", async () => {
  const f = fixture();
  try {
    const check = f.tools.invoke({ action: "check", directory: "project", timeoutSeconds: 120, command: "node -e 'setInterval(()=>{},1000)'" });
    await pause(100); const started = Date.now(); await f.tools.close(); await f.tools.close();
    assert.ok(Date.now() - started < 2000); assert.equal((await check).aborted, true);
    await assert.rejects(f.tools.invoke({ action: "start" }), /closed/);
    assert.ok(fs.readdirSync(f.log.root).some(name => name.startsWith("selftest-")));
  } finally { await f.cleanup(); }
});
test("control endpoint refuses unauthenticated calls and aborts disconnected checks", async () => {
  const f = fixture();
  try {
    const endpoint = await f.tools.listen();
    assert.equal((await fetch(endpoint.baseURL + "/invoke", { method: "POST", body: "{}" })).status, 403);
    const controller = new AbortController();
    const call = fetch(endpoint.baseURL + "/invoke", { method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ action: "check", directory: "project", timeoutSeconds: 120, command: "node -e 'setInterval(()=>{},1000)'" }) });
    const rejected = assert.rejects(call); await pause(150); controller.abort(); await rejected; await pause(200);
    assert.equal(f.tools.receipts.at(-1)?.aborted, true);
  } finally { await f.cleanup(); }
});
test("Bash guard caps default/explicit timeouts and routes daemon commands to managed tools", async () => {
  const module = await import(pathToFileURL(path.resolve("evolution/devtools-plugin.mjs")).href);
  const plugin = await module.TorineDevTools(), before = plugin["tool.execute.before"];
  for (const command of ["npm run start", "node src/index.js", "nohup node x.js &", "setsid bash x.sh", "sleep 1 &", "x & disown"]) {
    await assert.rejects(before({ tool: "bash" }, { args: { command } }), /torine_app/);
  }
  for (const command of ["pkill -f 'node src/index.js'", "killall node", "kill -9 1234"]) await assert.rejects(before({ tool: "bash" }, { args: { command } }), /controller owns cleanup/);
  const ordinary = { args: { command: "npm run build 2>&1 | tail -20", timeout: undefined as number | undefined } };
  await before({ tool: "bash" }, ordinary); assert.equal(ordinary.args.timeout, 60000);
  ordinary.args.timeout = 600000; await before({ tool: "bash" }, ordinary); assert.equal(ordinary.args.timeout, 120000);
});
test("checks refuse global process kills and detached daemons", async () => {
  const f = fixture({ maxFailures: 10 });
  try {
    for (const command of ["pkill -f node", "killall node", "nohup node x.js &", "npm run start"]) {
      await assert.rejects(f.tools.invoke({ action: "check", directory: "backend", command, timeoutSeconds: 1 }), /torine_app/);
    }
  } finally { await f.cleanup(); }
});
test("two failures exhaust one requirement even after source edits and tool recreation", async () => {
  const budget = new SelfTestBudget(), f = fixture({ budget });
  let repairTools: DevTools | undefined;
  try {
    assert.equal((await f.tools.invoke({ action: "check", directory: "project", command: "exit 7" })).passed, false);
    fs.writeFileSync(path.join(f.workspace, "new-test.txt"), "Changed source does not reset the budget");
    assert.equal((await f.tools.invoke({ action: "check", directory: "project", command: "exit 8" })).passed, false);
    await f.tools.close();
    repairTools = new DevTools({ workspace: f.workspace, log: f.log, budget });
    await assert.rejects(repairTools.invoke({ action: "check", directory: "project", command: "exit 0" }), /failure-limit/);
    await assert.rejects(repairTools.invoke({ action: "start" }), /failure-limit/);
    assert.equal((await repairTools.invoke({ action: "status" })).budget.failures, 2);
    await repairTools.invoke({ action: "stop" });
    assert.equal(f.tools.receipts.length, 2);
    assert.equal(repairTools.receipts.length, 0);
  } finally { await repairTools?.close(); await f.cleanup(); }
});
test("successful checks retain the shared count limit; stop/status remain usable", async () => {
  const f = fixture({ maxChecks: 2 });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await f.tools.invoke({ action: "check", directory: "project", command: "exit 0" })).passed, true);
    await assert.rejects(f.tools.invoke({ action: "check", directory: "project", command: "exit 0" }), /check-limit/);
    assert.equal((await f.tools.invoke({ action: "status" })).checksRemaining, 0);
    await f.tools.invoke({ action: "stop" });
  } finally { await f.cleanup(); }
});
test("cumulative active time interrupts a long check and cannot be replenished", async () => {
  const f = fixture({ maxSelfTestMs: 200 });
  try {
    const started = Date.now();
    const result = await f.tools.invoke({ action: "check", directory: "project", timeoutSeconds: 120, command: "node -e 'setInterval(()=>{},1000)'" });
    assert.equal(result.passed, false);
    assert.ok(result.aborted || result.timedOut);
    assert.ok(Date.now() - started < 2000, "Includes bounded termination grace, not an exact wall-time ceiling");
    await assert.rejects(f.tools.invoke({ action: "check", directory: "project", command: "exit 0" }), /time-limit/);
    assert.ok((await f.tools.invoke({ action: "status" })).budget.elapsedMs >= 200);
  } finally { await f.cleanup(); }
});
test("source changes refresh managed scripts and data; unchanged checks share private data", async () => {
  const f = fixture();
  const script = path.join(f.workspace, "backend/probe.cjs");
  try {
    fs.writeFileSync(script, "fetch(process.env.BASE_URL+'/api/value',{method:'POST',body:JSON.stringify({name:'Private'})}).then(r=>r.text()).then(console.log)");
    await f.tools.invoke({ action: "start" });
    const invoke = () => f.tools.invoke({ action: "check", directory: "backend", command: "node probe.cjs" });
    assert.match((await invoke()).output, /Private/);
    const read = await f.tools.invoke({ action: "check", directory: "backend", command: "node -e 'fetch(process.env.BASE_URL+\"/api/value\").then(r=>r.text()).then(console.log)'" });
    assert.match(read.output, /Private/);
    fs.writeFileSync(script, "fetch(process.env.BASE_URL+'/api/value').then(r=>r.text()).then(v=>console.log('REFRESHED_SCRIPT',v))");
    const refreshed = await invoke();
    assert.match(refreshed.output, /REFRESHED_SCRIPT/); assert.match(refreshed.output, /Original/);
    assert.equal(fs.existsSync(path.join(f.workspace, "backend/data.json")), false);
    const status = await f.tools.invoke({ action: "status" });
    assert.equal(status.budget.checksStarted, 3, "Snapshot restart must not reset the budget");
    assert.match(fs.readFileSync(path.join(f.log.root, "events.jsonl"), "utf8"), /snapshot_refreshed/);
  } finally { await f.cleanup(); }
});
test("recognized Bash tests must use the budgeted tool, but source inspection/build remain available", async () => {
  const module = await import(pathToFileURL(path.resolve("evolution/devtools-plugin.mjs")).href);
  const before = (await module.TorineDevTools())["tool.execute.before"];
  for (const command of ["npm test", "npm run test:unit", "npx playwright test", "node --test checks.js", "node checks.test.js", "python -m pytest checks"]) {
    await assert.rejects(before({ tool: "bash" }, { args: { command } }), /torine_check/);
  }
  for (const command of ["rg something backend", "npm run build", "git diff --stat"]) await before({ tool: "bash" }, { args: { command } });
});
