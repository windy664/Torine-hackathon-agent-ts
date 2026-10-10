import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Checkpoint, ControllerBudget, applicationDigest, repairImproves } from "../controller-state.js";
import { isShellTest, readEvents, runTests, sharedTestBudget, appendEvent, type TestSettings } from "../controller-tests.js";
import { runProcess } from "../controller-process.js";

function fixture(t: test.TestContext): { root: string; privateDir: string; settings: TestSettings } {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-controller-test-"));
  const root = path.join(temp, "app"); const privateDir = path.join(temp, "private");
  fs.mkdirSync(path.join(root, "frontend"), { recursive: true }); fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(root, "frontend/package.json"), JSON.stringify({ scripts: { test: "node fail.cjs" } }));
  fs.writeFileSync(path.join(root, "frontend/fail.cjs"), "console.error('AssertionError: expected trimmed value');process.exit(7)");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { root, privateDir, settings: { root, ledger: path.join(privateDir, "tests.jsonl"), control: path.join(privateDir, "stop.json"), turnId: "test", timeoutMs: 3000, repeatLimit: 2, failureLimit: 4 } };
}

test("controlled tests preserve real exit code, record input identity, and stop repeated unchanged failures", async (t) => {
  const { settings } = fixture(t);
  const first = await runTests(settings, "frontend");
  assert.equal(first.code, 7); assert.equal(fs.existsSync(settings.control), false);
  const second = await runTests(settings, "frontend");
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(fs.existsSync(settings.control), true);
  assert.equal(readEvents(settings.ledger).filter((e) => e.type === "test-end").length, 2);
  await assert.rejects(runTests(settings, "frontend"), /stopped this turn/);
});

test("changed inputs may retry, but total failure allowance still stops changing-test loops", async (t) => {
  const { root, settings } = fixture(t); settings.failureLimit = 3;
  const digests = new Set<string>();
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(root, "frontend/revision.txt"), String(i));
    digests.add((await runTests(settings, "frontend")).inputDigest);
  }
  assert.equal(digests.size, 3);
  assert.match(fs.readFileSync(settings.control, "utf8"), /allowance exhausted/);
});

test("successful tests execute again; source changes cannot reuse stale success", async (t) => {
  const { root, settings } = fixture(t);
  const source = path.join(root, "frontend/fail.cjs");
  fs.writeFileSync(source, "process.exit(0)");
  assert.equal((await runTests(settings, "frontend")).code, 0);
  fs.writeFileSync(source, "console.error('AssertionError: regression');process.exit(9)");
  assert.equal((await runTests(settings, "frontend")).code, 9);
});

test("controlled tests return a bounded timeout rather than hanging indefinitely", async (t) => {
  const { root, privateDir, settings } = fixture(t); settings.timeoutMs = 700;
  fs.writeFileSync(path.join(root, "frontend/package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "frontend/hang.test.cjs"), "setInterval(()=>{},1000)");
  const result = await runTests(settings, "frontend", "hang.test.cjs");
  assert.equal(result.code, 124, fs.readFileSync(result.outputFile, "utf8")); assert.equal(result.timedOut, true);
});

test("interrupting a ready process kills its hanging grandchild", async (t) => {
  const { privateDir } = fixture(t);
  const pidFile = path.join(privateDir, "pid");
  const abort = new AbortController();
  const pending = runProcess("node", ["-e", `const {spawn}=require('node:child_process');const p=spawn('node',['-e','setInterval(()=>{},1000)']);require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},1000);`], { cwd: privateDir, signal: abort.signal, timeoutMs: 10_000, echo: false });
  const deadline = Date.now() + 8_000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  abort.abort();
  const result = await pending;
  assert.equal(result.code, 125); assert.ok(fs.existsSync(pidFile), "fixture must signal readiness before testing descendant cleanup");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let running = false;
  try { const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]; running = state !== "Z"; } catch { /* reaped */ }
  assert.equal(running, false);
});

test("external stop request interrupts a running command instead of waiting for the turn timeout", async (t) => {
  const { privateDir, settings } = fixture(t);
  const timer = setTimeout(() => fs.writeFileSync(settings.control, "{}"), 150);
  t.after(() => clearTimeout(timer));
  const result = await runProcess("node", ["-e", "setInterval(()=>{},1000)"], { cwd: privateDir, controlFile: settings.control, timeoutMs: 10_000, echo: false });
  assert.equal(result.code, 125); assert.equal(result.stopped, true);
});

test("checkpoint restores source, DB, removed files and build artifacts while preserving evidence", (t) => {
  const { root, privateDir } = fixture(t);
  fs.mkdirSync(path.join(root, ".arc")); fs.writeFileSync(path.join(root, ".arc/evidence"), "keep");
  fs.mkdirSync(path.join(root, "frontend/dist")); fs.writeFileSync(path.join(root, "frontend/dist/index.html"), "old build");
  fs.writeFileSync(path.join(root, "data.db"), "old data");
  const original = applicationDigest(root); const checkpoint = new Checkpoint(root, privateDir);
  fs.writeFileSync(path.join(root, "data.db"), "bad data"); fs.rmSync(path.join(root, "frontend/fail.cjs"));
  fs.writeFileSync(path.join(root, "new.js"), "rejected");
  fs.symlinkSync(privateDir, path.join(root, "rejected-link"));
  fs.writeFileSync(path.join(root, "frontend/dist/index.html"), "bad build");
  checkpoint.restore();
  assert.equal(applicationDigest(root), original);
  assert.equal(fs.readFileSync(path.join(root, "data.db"), "utf8"), "old data");
  assert.equal(fs.readFileSync(path.join(root, "frontend/dist/index.html"), "utf8"), "old build");
  assert.equal(fs.readFileSync(path.join(root, ".arc/evidence"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(root, "new.js")), false); checkpoint.dispose();
});

test("repair acceptance requires improvement and preservation of every previously passed case", () => {
  const before = [{ caseId: "old", status: "passed" }, { caseId: "new", status: "failed" }];
  assert.equal(repairImproves(before, [{ caseId: "old", status: "passed" }, { caseId: "new", status: "passed" }]), true);
  assert.equal(repairImproves(before, before), false);
  assert.equal(repairImproves(before, [{ caseId: "old", status: "failed" }, { caseId: "new", status: "passed" }]), false);
  assert.equal(repairImproves(before, [{ caseId: "new", status: "passed" }]), false);
  assert.equal(repairImproves(before, [{ caseId: "old", status: "passed" }, { caseId: "new", status: "passed" }], "partial run"), false);
});

test("stage budgets reserve delivery time, engine turns, and planner calls", () => {
  let now = 0; const budget = new ControllerBudget(10000, 4, 3, () => now);
  assert.equal(budget.takeTurn("implementation"), true); assert.equal(budget.takeTurn("implementation"), true);
  assert.equal(budget.takeTurn("implementation"), false);
  // maxPlans=3 reserves 2 calls for delivery; boundary may consume at most 1.
  assert.equal(budget.takePlan("boundary"), true);
  assert.equal(budget.takePlan("boundary"), false);
  assert.equal(budget.takePlan("delivery"), true);
  assert.equal(budget.takePlan("delivery"), true);
  assert.equal(budget.takePlan("delivery"), false);
  // implementation owns 0.8 of the wall clock; boundary 0.9; delivery 1.0.
  now = 6000; assert.equal(budget.remaining("implementation"), 2000);
  now = 8000; assert.equal(budget.remaining("implementation"), 0);
  assert.equal(budget.takeTurn("delivery"), true); now = 10000; assert.equal(budget.takeTurn("delivery"), false);
});

test("shell test recognition covers pipes and common invocations without rejecting searches/builds", () => {
  for (const command of ["cd frontend && npm run test 2>&1 | head -60", "timeout 60 npx vitest run tests/a.ts", "node --test a.test.js", "pnpm --dir frontend test", "npm test"]) assert.equal(isShellTest(command), true, command);
  for (const command of ["rg vitest package.json", "npm run build", "echo test", "git diff -- tests/a.ts"]) assert.equal(isShellTest(command), false, command);
});

test("requirement failures persist across fresh implementation and repair turns but do not block unrelated work", async (t) => {
  const { settings, privateDir, root } = fixture(t);
  settings.scopeIds = ['REQ-A']; settings.failureLimit = 2;
  await runTests(settings, 'frontend');
  const repair = { ...settings, turnId: 'fresh-repair', control: path.join(privateDir, 'repair-stop.json') };
  fs.writeFileSync(path.join(root,'frontend/revision.txt'),'source changed');
  await runTests(repair, 'frontend');
  const again = { ...repair, turnId: 'another-reset', control: path.join(privateDir,'another-stop.json') };
  await assert.rejects(runTests(again,'frontend'), /Shared requirement/);
  const other = { ...again, scopeIds: ['REQ-B'], control: path.join(privateDir,'other-stop.json') };
  assert.equal((await runTests(other,'frontend')).code,7);
  assert.equal(readEvents(settings.ledger).filter(e=>e.type==='test-end').length,3);
});

test("successful repeated checks and elapsed time cannot reset the shared allowance", async (t) => {
  const { settings, privateDir, root } = fixture(t);
  fs.writeFileSync(path.join(root,'frontend/fail.cjs'),'process.exit(0)');
  settings.scopeIds=['REQ-A']; settings.maxChecks=1;
  assert.equal((await runTests(settings,'frontend')).code,0);
  await assert.rejects(runTests({...settings,turnId:'reset',control:path.join(privateDir,'reset.json')},'frontend'),/Shared requirement/);
  const timed={...settings,scopeIds:['REQ-B'],maxChecks:20,maxActiveMs:1,control:path.join(privateDir,'timed.json')};
  await runTests(timed,'frontend');
  await assert.rejects(runTests({...timed,turnId:'reset-again',control:path.join(privateDir,'timed2.json')},'frontend'),/Shared requirement/);
});

test("a worker killed before test-end cannot replenish its requirement budget", t => {
  const {settings}=fixture(t); settings.scopeIds=['REQ-A']; settings.failureLimit=1;
  appendEvent(settings.ledger,{type:'test-start',id:'abandoned',turnId:'old-worker',scopeIds:['REQ-A'],startedAtMs:Date.now()-3000,timeoutMs:1000});
  const budget=sharedTestBudget({...settings,turnId:'fresh-worker',maxActiveMs:4000});
  assert.equal(budget.exhausted,true); assert.equal(budget.remainingMs,3000);
});
