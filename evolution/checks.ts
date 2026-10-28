import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { EventLog, type Json } from "./events.js";
import { command } from "./process.js";

export type CheckState = "passed" | "product_failed" | "infrastructure_failed" | "unchecked";
export type CheckResult = { id: string; state: CheckState; detail: string; kind?: string; required?: boolean };
export const checksSatisfied = (checks: CheckResult[]) => checks.length > 0 && checks.every(check => check.state === "passed" || check.required === false && check.state === "unchecked");
export type Plan = { cases: { id: string; sourceQuote: string; kind: "evolution" | "regression"; steps: Json[] }[] };
const actions = new Set(["goto", "reload", "click", "dblclick", "fill", "press", "select", "check", "uncheck", "visible", "hidden", "text", "value", "count", "checked", "enabled", "api"]);
const assertions = new Set(["visible", "hidden", "text", "value", "count", "checked", "enabled", "api"]);
export const checkContract = `Return ONLY JSON {"cases":[{"id":"short-id","kind":"evolution|regression","sourceQuote":"literal excerpt from supplied public requirements","steps":[...]}]}.
Generate 1–3 SMALL independent browser scenarios, at least one changed success/refusal path and one relevant existing regression if the requirements describe it. Each starts at goto and sets up its own state from the public preconditions; never assume another case ran. Check actual data/visible result, including reload persistence where applicable. Prefer explicit labels/roles and scoped locators. Do not invent backend routes. Do not reduce checks to page headings alone.
Supported steps:
{"action":"goto","path":"/relative/path"}, {"action":"reload"},
{"action":"click|dblclick|check|uncheck","target":locator},
{"action":"fill|press|select","target":locator,"value":"text or key"},
{"action":"visible|hidden","target":locator},
{"action":"text|value","target":locator,"expected":"exact result"},
{"action":"count","target":locator,"expected":1},
{"action":"checked|enabled","target":locator,"expected":true},
{"action":"api","method":"GET|POST|PUT|PATCH|DELETE","path":"/api/...","body":{},"status":200,"json":[{"field":"nested.field","expected":"exact value"}],"capture":{"variable":"nested.id"}}.
Locator is {"role":"button","name":"Exact accessible name"}, {"label":"Exact label"}, or {"text":"Exact visible text"}; optional exact:false and scope:another locator. No CSS, code, evaluate, selectors outside these forms, arbitrary sleeps or executable scripts. API path/body strings can interpolate captured {{variable}} values. API calls share the browser context cookies. Every API step MUST specify method, same-origin /api/ path, and ONE integer status (not statusCode, a list, range or string). Every case requires an assertion of meaningful publicly specified behavior, not a model self-report. Max 4 cases, 45 steps/case. Empty cases means unsupported/unchecked, never passed. When a public source reference catalog is supplied, prefer "sourceRef":"R1" (an existing catalog ID) instead of sourceQuote; the controller resolves the literal quote. Never invent a reference.`;

export function publicText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(publicText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(publicText).join("\n");
  return "";
}
function locatorValid(target: any, depth = 0): boolean {
  return depth <= 3 && target && typeof target === "object" &&
    [target.role, target.label, target.text].filter(value => typeof value === "string" && value.length > 0 && value.length < 300).length === 1 &&
    (!target.role || typeof target.name === "string") && (target.exact === undefined || typeof target.exact === "boolean") &&
    (!target.scope || locatorValid(target.scope, depth + 1));
}
function localPath(value: unknown): boolean { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length < 2000; }
export function parsePlan(text: string, source: string): Plan {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (cleaned.length > 80_000) throw new Error("Check plan too large");
  const plan = JSON.parse(cleaned);
  if (!Array.isArray(plan.cases) || plan.cases.length > 4) throw new Error("Expected <=4 check cases");
  const ids = new Set();
  const normalized = source.replace(/\s+/g, " ");
  for (const check of plan.cases) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(check.id) || ids.has(check.id)) throw new Error("Invalid/duplicate check ID"); ids.add(check.id);
    if (!["evolution", "regression"].includes(check.kind) || typeof check.sourceQuote !== "string" || check.sourceQuote.trim().length < 12 || !normalized.includes(check.sourceQuote.replace(/\s+/g, " "))) throw new Error(`Unanchored public requirement: ${check.id}`);
    if (!Array.isArray(check.steps) || !check.steps.length || check.steps.length > 45 || check.steps[0]?.action !== "goto" || !check.steps.some((step: Json) => assertions.has(step.action))) throw new Error("Case needs navigation and an assertion");
    for (const [stepIndex, step] of check.steps.entries()) {
      if (!actions.has(step.action)) throw new Error(`Unsupported check action ${step.action}`);
      if (step.action === "goto" || step.action === "api") { if (!localPath(step.path)) throw new Error("Only relative same-origin paths allowed"); }
      else if (step.action !== "reload" && !locatorValid(step.target)) throw new Error("Invalid accessible locator");
      if (["fill", "press", "select"].includes(step.action) && (typeof step.value !== "string" || step.value.length > 4000)) throw new Error("Action value must be bounded text");
      if (["text", "value"].includes(step.action) && typeof step.expected !== "string") throw new Error("Text assertion needs expected string");
      if (["checked", "enabled"].includes(step.action) && typeof step.expected !== "boolean") throw new Error("Boolean assertion needs expected boolean");
      if (step.action === "count" && (!Number.isInteger(step.expected) || step.expected < 0)) throw new Error("Count assertion needs non-negative integer");
      if (step.action === "api" && (!/^\/api(?:\/|\?)/.test(step.path) || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(step.method) || !Number.isInteger(step.status) || step.status < 100 || step.status > 599)) throw new Error(`Invalid API assertion in ${check.id} steps[${stepIndex}]: expected method GET|POST|PUT|PATCH|DELETE, path /api/..., integer status 100..599; got ${JSON.stringify({ method: step.method, path: step.path, status: step.status })}`);
      if (step.action === "api" && (step.json !== undefined && (!Array.isArray(step.json) || step.json.some((item: any) => typeof item.field !== "string" || !Object.hasOwn(item, "expected"))) || step.capture !== undefined && (!step.capture || Array.isArray(step.capture) || typeof step.capture !== "object" || Object.values(step.capture).some(value => typeof value !== "string")))) throw new Error("Malformed API fields/captures");
    }
  }
  return plan;
}
export async function freePort(exclude = 0): Promise<number> {
  const server = net.createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve()));
  return port === exclude ? freePort(exclude) : port;
}
export function killGroup(pid?: number) { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch {} }
export function copyProject(source: string, target: string) {
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: file => {
    const relative = path.relative(source, file), parts = relative.split(path.sep);
    if (parts.some(part => ["node_modules", ".git", ".arc", "test-results", "playwright-report"].includes(part))) return false;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unsupported app symlink: ${relative}`);
    return true;
  } });
  for (const dir of ["backend", "frontend"]) {
    const dependencies = path.join(source, dir, "node_modules");
    if (fs.existsSync(dependencies)) fs.symlinkSync(dependencies, path.join(target, dir, "node_modules"), "dir");
  }
}
export const childEnvironment = (extra: NodeJS.ProcessEnv = {}) => {
  const result = { ...process.env, ...extra };
  for (const key of Object.keys(result)) if (/KEY|TOKEN|COOKIE|AUTHORIZATION|SECRET/i.test(key)) delete result[key];
  return result;
};
export function browserInstallCli(name = "playwright"): string {
  const require = createRequire(import.meta.url);
  // Playwright 1.57 exports package.json but NOT the ./cli subpath. Resolve
  // the installed package's declared executable instead of an unexported path.
  const metadata = require.resolve(`${name}/package.json`);
  const pkg = JSON.parse(fs.readFileSync(metadata, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.playwright;
  if (typeof bin !== "string") throw new Error(`No browser installer declared by ${name}`);
  const cli = path.resolve(path.dirname(metadata), bin);
  if (!fs.existsSync(cli) || !fs.statSync(cli).isFile()) throw new Error(`Browser installer is missing for ${name}`);
  return cli;
}
export async function prepareBrowser(log: EventLog, deadline: number): Promise<CheckResult> {
  const require = createRequire(import.meta.url);
  try {
    const name = process.env.TORINE_PLAYWRIGHT_MODULE || "playwright";
    const playwright = require(name);
    const launch = async () => { const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); await browser.close(); };
    try { await launch(); }
    catch (error) {
      if (!/Executable doesn't exist/.test(String(error))) throw error;
      const cli = browserInstallCli(name);
      const install = await command(process.execPath, [cli, "install", "chromium", "--only-shell"], { cwd: log.root, log, env: childEnvironment(), timeoutMs: Math.min(5 * 60_000, deadline - Date.now()), context: { phase: "browser-install" } });
      if (install.code !== 0) throw new Error(`Browser download failed: ${install.output.slice(-1800)}`);
      await launch();
    }
    return { id: "browser-runtime", state: "passed", detail: "Pinned Chromium launches; not behavior acceptance" };
  } catch (error) { return { id: "browser-runtime", state: "infrastructure_failed", detail: String(error).slice(-2500) }; }
}
export async function buildApp(workspace: string, log: EventLog, deadline: number): Promise<CheckResult> {
  for (const directory of ["backend", "frontend"]) {
    const cwd = path.join(workspace, directory);
    if (!fs.existsSync(path.join(cwd, "package.json"))) return { id: "delivery-build", state: "product_failed", detail: `Missing ${directory}/package.json` };
    const install = await command("npm", ["install", "--no-audit", "--no-fund"], { cwd, env: childEnvironment(), log, timeoutMs: Math.min(10 * 60_000, deadline - Date.now()), context: { phase: "dependency", directory } });
    if (install.code !== 0) return { id: "delivery-build", state: "infrastructure_failed", detail: `${directory} install failed: ${install.output.slice(-2500)}` };
  }
  const build = await command("npm", ["run", "build"], { cwd: path.join(workspace, "frontend"), env: childEnvironment(), log, timeoutMs: Math.min(5 * 60_000, deadline - Date.now()), context: { phase: "build" } });
  return { id: "delivery-build", state: build.code === 0 ? "passed" : build.timedOut ? "infrastructure_failed" : "product_failed", detail: build.code === 0 ? "Frontend compiled; this is NOT behavior acceptance" : build.output.slice(-3500) };
}

export async function runCases(workspace: string, plan: Plan, log: EventLog, deadline: number, reservedPort = 0): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let browser: any, expect: any;
  try {
    const require = createRequire(import.meta.url);
    const playwright = require(process.env.TORINE_PLAYWRIGHT_MODULE || "playwright");
    expect = require(process.env.TORINE_PLAYWRIGHT_ASSERT || "playwright/test").expect;
    browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (error) {
    return plan.cases.map(check => ({ id: check.id, kind: check.kind, state: "infrastructure_failed", detail: `Browser unavailable (not a product verdict): ${String(error).slice(0, 1500)}` }));
  }
  try {
    for (const check of plan.cases) {
      if (deadline - Date.now() < 5000) { results.push({ id: check.id, kind: check.kind, state: "unchecked", detail: "Verification budget exhausted" }); continue; }
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-check-")), app = path.join(temp, "app");
      let child: ReturnType<typeof spawn> | undefined, context: any, timer: NodeJS.Timeout | undefined, expired = false, stage = "setup", output = "";
      const started = Date.now(), limit = Math.min(90_000, deadline - Date.now());
      try {
        copyProject(workspace, app);
        const port = await freePort(reservedPort), baseURL = `http://127.0.0.1:${port}`;
        // Every case gets its own copied database. No app model key or cookies.
        const database = path.join(app, "backend/database.db");
        child = spawn("npm", ["run", "start"], { cwd: path.join(app, "backend"), env: childEnvironment({ PORT: String(port), ARC_WEB_PORT: String(port), ARC_DB_FILE: database, DATABASE_FILE: database }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
        child.on("error", error => { output += String(error); });
        for (const stream of [child.stdout, child.stderr]) stream?.on("data", data => { output = (output + data.toString()).slice(-8000); });
        const readyDeadline = Math.min(Date.now() + 20_000, deadline);
        let ready = false;
        while (Date.now() < readyDeadline && child.exitCode === null) {
          try { const reply = await fetch(baseURL, { signal: AbortSignal.timeout(1000) }); if (reply.ok && (await reply.text()).includes("<")) { ready = true; break; } } catch {}
          await pause(200);
        }
        if (!ready) { stage = "startup"; throw new Error(`App did not become HTTP-ready: ${output}`); }
        context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10_000);
        page.on("pageerror", (error: Error) => log.emit("error", "browser_page", { checkId: check.id, message: String(error) }));
        // Neither browser navigation nor API checks may leave the local copy.
        await context.route("**/*", async (route: any) => {
          const url = new URL(route.request().url());
          if (["data:", "blob:"].includes(url.protocol) || url.origin === baseURL) await route.continue(); else await route.abort();
        });
        timer = setTimeout(() => { expired = true; killGroup(child?.pid); void context.close().catch(() => {}); }, Math.max(1, limit - (Date.now() - started)));
        const locate = (target: Json): any => {
          const root = target.scope ? locate(target.scope) : page;
          if (target.role) return root.getByRole(target.role, { name: target.name, exact: target.exact !== false });
          if (target.label) return root.getByLabel(target.label, { exact: target.exact !== false });
          return root.getByText(target.text, { exact: target.exact !== false });
        };
        const variables: Json = {};
        const replace = (value: any): any => {
          if (typeof value === "string") return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => { if (!Object.hasOwn(variables, key)) throw new Error(`Unknown API variable ${key}`); return String(variables[key]); });
          if (Array.isArray(value)) return value.map(replace);
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
          return value;
        };
        const field = (value: any, key: string) => key.split(".").reduce((current, part) => current?.[part], value);
        stage = "behavior";
        for (let i = 0; i < check.steps.length; i++) {
          const step = check.steps[i], target = step.target ? locate(step.target) : null;
          log.emit("check", "step", { checkId: check.id, index: i, action: step.action });
          switch (step.action) {
            case "goto": { const url = new URL(step.path, baseURL); if (url.origin !== baseURL) throw new Error("Non-local navigation rejected"); await page.goto(url.href); break; }
            case "reload": await page.reload(); break;
            case "click": case "dblclick": case "check": case "uncheck": await target[step.action](); break;
            case "fill": case "press": await target[step.action](step.value); break;
            case "select": await target.selectOption({ label: step.value }); break;
            case "visible": await expect(target).toBeVisible(); break;
            case "hidden": await expect(target).toBeHidden(); break;
            case "text": await expect(target).toHaveText(step.expected); break;
            case "value": await expect(target).toHaveValue(step.expected); break;
            case "count": await expect(target).toHaveCount(step.expected); break;
            case "checked": await expect(target).toBeChecked({ checked: step.expected }); break;
            case "enabled": if (step.expected) await expect(target).toBeEnabled(); else await expect(target).toBeDisabled(); break;
            case "api": {
              const url = new URL(replace(step.path), baseURL); if (url.origin !== baseURL) throw new Error("Non-local API request rejected");
              const reply = await context.request.fetch(url.href, { method: step.method, data: step.body === undefined ? undefined : replace(step.body), timeout: 5000, maxRedirects: 0 });
              expect(reply.status()).toBe(step.status);
              if (step.json?.length || step.capture) { const json = await reply.json(); for (const assertion of step.json ?? []) expect(field(json, assertion.field)).toEqual(replace(assertion.expected)); for (const [key, keyPath] of Object.entries(step.capture ?? {})) { const value = field(json, String(keyPath)); if (!["string", "number"].includes(typeof value)) throw new Error(`Invalid captured field ${keyPath}`); variables[key] = value; } }
              break;
            }
          }
        }
        results.push({ id: check.id, kind: check.kind, state: "passed", detail: `Executed ${check.steps.length} public-derived steps; not full requirement coverage` });
      } catch (error) {
        const message = String(error);
        const uncertain = stage === "setup" || stage === "startup" || expired || /strict mode violation|Unknown API variable|Non-local/.test(message);
        results.push({ id: check.id, kind: check.kind, state: uncertain ? "infrastructure_failed" : "product_failed", detail: `${stage}: ${message.slice(-3500)}${stage === "startup" ? "" : `\nApp stderr tail: ${output.slice(-1200)}`}` });
      } finally {
        if (timer) clearTimeout(timer);
        if (context) await context.close().catch(() => {}); killGroup(child?.pid);
        // Keep only bounded failure evidence, not temporary DBs or screenshots.
        fs.rmSync(temp, { recursive: true, force: true });
      }
      log.emit("check", "result", { ...results.at(-1), durationMs: Date.now() - started });
    }
  } finally { await browser.close(); }
  return results;
}
