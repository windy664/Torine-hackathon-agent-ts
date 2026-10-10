import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applicationDigest } from "./controller-state.js";
import { runProcess } from "./controller-process.js";

export type TestSettings = { root: string; ledger: string; control: string; turnId: string; timeoutMs: number; repeatLimit: number; failureLimit: number; scopeIds?: string[]; maxChecks?: number; maxActiveMs?: number };
export type TestRecord = {
  type: "test-end"; turnId: string; scopeIds?: string[]; id: string; target: string; filter: string; inputDigest: string;
  code: number | null; timedOut: boolean; durationMs: number; category: "passed" | "timeout" | "environment" | "failure";
  failure: string; fingerprint: string; outputFile: string; pid?: number;
};

export function appendEvent(file: string, event: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

export function readEvents(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

export function settingsFromEnv(root: string, env: NodeJS.ProcessEnv = process.env): TestSettings {
  const ledger = env.TORINE_TEST_LEDGER;
  const control = env.TORINE_TURN_CONTROL;
  if (!ledger || !control) throw new Error("Controller test ledger/control unavailable; refuse unobserved test execution");
  const settings = { root, ledger, control, turnId: env.TORINE_TURN_ID || "unknown",
    scopeIds: JSON.parse(env.TORINE_TEST_SCOPE || "[]") as string[],
    maxChecks: Number(env.TORINE_TEST_MAX_CHECKS || 8),
    maxActiveMs: Number(env.TORINE_TEST_MAX_ACTIVE_MS || 240_000),
    timeoutMs: Number(env.TORINE_TEST_TIMEOUT_MS || 120_000),
    repeatLimit: Number(env.TORINE_TEST_REPEAT_LIMIT || 2), failureLimit: Number(env.TORINE_TEST_FAILURE_LIMIT || 4) };
  if (![settings.timeoutMs, settings.repeatLimit, settings.failureLimit, settings.maxChecks, settings.maxActiveMs].every((v) => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid controller test limits");
  if (!Array.isArray(settings.scopeIds) || settings.scopeIds.some(id => typeof id !== "string" || !id)) throw new Error("Invalid test requirement scope");
  return settings;
}

export function requestDiagnostic(settings: TestSettings, reason: string): void {
  if (fs.existsSync(settings.control)) return;
  fs.mkdirSync(path.dirname(settings.control), { recursive: true });
  const temporary = `${settings.control}.${randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify({ turnId: settings.turnId, reason }));
  fs.renameSync(temporary, settings.control);
}

export function isShellTest(command: string): boolean {
  // Recognize executable commands rather than searches mentioning "test".
  // This is a tool policy, not a shell parser or an OS sandbox.
  const segments = command.split(/&&|\|\||[;|\n]/);
  return segments.some((raw) => {
    const s = raw.trim().replace(/^(?:[A-Za-z_]\w*=\S+\s+|timeout\s+\S+\s+)*/, "");
    return /^(?:npm|pnpm|yarn|bun)\s+(?:(?:--prefix|--cwd|--dir)\s+\S+\s+)?(?:(?:run|exec|x)\s+)?(?:test(?:[\s:.-]|$)|vitest\b|jest\b|playwright\s+test\b)/i.test(s)
      || /^(?:npx\s+(?:--yes\s+)?|.*[\\/])?(?:vitest|jest)\b/.test(s)
      || /^node\s+(?:--\S+\s+)*--test(?:\s|$)/.test(s)
      || /^npx\s+playwright\s+test\b/.test(s);
  });
}

export function rejectShellTest(settings: TestSettings, command: string): void {
  appendEvent(settings.ledger, { type: "test-command-rejected", turnId: settings.turnId, command: command.slice(0, 1200) });
  const rejected = readEvents(settings.ledger).filter((e) => e.turnId === settings.turnId && e.type === "test-command-rejected").length;
  if (rejected >= 3) requestDiagnostic(settings, "Repeated attempts to bypass run_tests; controller needs a focused diagnostic");
  throw new Error("Run tests with run_tests {target:'frontend'|'backend'|'all',filter?:'file'}; shell test pipelines are rejected so exit codes and repeated failures remain observable.");
}

export function sharedTestBudget(settings: TestSettings): { remainingMs: number; exhausted: boolean } {
  const scopes = settings.scopeIds?.length ? settings.scopeIds : [settings.turnId];
  const events = readEvents(settings.ledger);
  const records = events.filter(e => e.type === "test-end");
  const ended = new Set(records.map(e => e.id));
  // A killed worker may never write test-end. Charge its started check rather
  // than replenishing the allowance in the next implementation/repair session.
  for (const start of events.filter(e => e.type === "test-start" && !ended.has(e.id))) {
    records.push({ ...start, code: 124, durationMs: Math.min(Number(start.timeoutMs ?? settings.timeoutMs), Math.max(0, Date.now() - Number(start.startedAtMs ?? Date.now()))) });
  }
  let remainingMs = settings.maxActiveMs ?? Infinity, exhausted = false;
  for (const id of scopes) {
    const scoped = records.filter(e => (Array.isArray(e.scopeIds) && e.scopeIds.length ? e.scopeIds : [e.turnId]).includes(id));
    remainingMs = Math.min(remainingMs, (settings.maxActiveMs ?? Infinity) - scoped.reduce((sum, e) => sum + Number(e.durationMs || 0), 0));
    if (scoped.length >= (settings.maxChecks ?? Infinity) || scoped.filter(e => e.code !== 0).length >= settings.failureLimit) exhausted = true;
  }
  return { remainingMs: Math.max(0, remainingMs), exhausted: exhausted || remainingMs <= 0 };
}

export async function runTests(settings: TestSettings, target: "frontend" | "backend", filter = "", signal?: AbortSignal): Promise<TestRecord> {
  if (fs.existsSync(settings.control)) throw new Error("Controller stopped this turn for diagnosis; do not repeat tests");
  if (filter.startsWith("-") || filter.includes("\0") || path.isAbsolute(filter) || filter.split(/[\\/]/).includes("..")) throw new Error("filter must be an application-relative test file/pattern");
  const budget = sharedTestBudget(settings);
  if (budget.exhausted) {
    requestDiagnostic(settings, "Shared requirement self-test allowance exhausted; preserve partial work and continue scheduling");
    throw new Error("Shared requirement self-test allowance exhausted");
  }
  const cwd = path.join(settings.root, target);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  const script = String(manifest.scripts?.test || "");
  const vitest = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
  const nodeTest = /\bnode\s+--test\b/.test(script);
  const executable = /\bvitest\b/.test(script) && fs.existsSync(vitest) || nodeTest ? "node" : "npm";
  const argv = executable === "npm" ? ["run", "test", ...(filter ? ["--", filter] : [])]
    : nodeTest ? ["--test", "--test-concurrency=1", ...(filter ? [filter] : [])]
      : [vitest, "run", "--maxWorkers=1", ...(filter ? [filter] : [])];
  const inputDigest = applicationDigest(settings.root);
  const id = randomUUID();
  const outputFile = path.join(path.dirname(settings.ledger), `test-${id}.log`);
  const started = Date.now();
  let pid: number | undefined;
  const result = await runProcess(executable, argv, { cwd, signal, timeoutMs: Math.min(settings.timeoutMs, budget.remainingMs), echo: false, logFile: outputFile,
    env: { CI: "1", OPENAI_API_KEY: "", OPENCODE_CONFIG: undefined, NODE_TEST_CONTEXT: undefined },
    onSpawn: (value) => { pid = value; appendEvent(settings.ledger, { type: "test-start", turnId: settings.turnId, id, pid, target, filter, inputDigest, scopeIds: settings.scopeIds, startedAtMs: started, timeoutMs: Math.min(settings.timeoutMs, budget.remainingMs) }); } });
  const clean = result.output.replace(/\x1b\[[0-9;]*m/g, "");
  const failure = clean.split("\n").filter((line) => /Error:|AssertionError|FAIL |×|expected |timed out|Cannot find|not found/i.test(line))
    .slice(0, 16).join("\n").replaceAll(settings.root, "<app>").replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds)\b/g, "<duration>").slice(0, 4000)
    || clean.slice(-2000);
  const category = result.code === 0 ? "passed" : result.code === 124 ? "timeout"
    : /Cannot find module|ENOENT|command not found|not installed|missing script/i.test(clean) ? "environment" : "failure";
  const fingerprint = createHash("sha256").update(JSON.stringify([target, filter, inputDigest, category, failure])).digest("hex");
  const record: TestRecord = { type: "test-end", turnId: settings.turnId, scopeIds: settings.scopeIds, id, pid, target, filter, inputDigest,
    code: result.code, timedOut: result.code === 124, durationMs: Date.now() - started, category, failure: result.code === 0 ? "" : failure, fingerprint, outputFile };
  appendEvent(settings.ledger, record);
  if (result.code !== 0) {
    const records = readEvents(settings.ledger).filter((e) => e.turnId === settings.turnId && e.type === "test-end" && e.code !== 0);
    const repeated = records.filter((e) => e.fingerprint === fingerprint).length;
    if (repeated >= settings.repeatLimit || records.length >= settings.failureLimit) {
      requestDiagnostic(settings, repeated >= settings.repeatLimit ? "Same test failure repeated on identical application inputs" : "Test failure allowance exhausted for this turn");
    }
  }
  if (sharedTestBudget(settings).exhausted) requestDiagnostic(settings, "Shared requirement self-test allowance exhausted; preserve partial work and continue scheduling");
  return record;
}
