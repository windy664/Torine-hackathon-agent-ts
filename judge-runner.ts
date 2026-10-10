import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Locator, type Page } from "@playwright/test";
import type { JudgeReport, ProbeCase, ProbeLocator, ProbeResult, ProbeStep } from "./judge-plan.js";

export type RunnerManifest = {
  outputDir: string;
  evaluationPort: number;
  cases: ProbeCase[];
  caseTimeoutMs: number;
  stepTimeoutMs: number;
  deadline: number;
};

function locate(page: Page, query: ProbeLocator): Locator {
  const base = query.scope ? locate(page, query.scope) : page;
  const options = { exact: query.exact ?? true };
  switch (query.by) {
    case "role": return base.getByRole(query.role as Parameters<Page["getByRole"]>[0], { name: query.text, ...options });
    case "label": return base.getByLabel(query.text, options);
    case "text": return base.getByText(query.text, options);
    case "placeholder": return base.getByPlaceholder(query.text, options);
  }
}

async function execute(page: Page, step: ProbeStep, baseURL: string, timeout: number): Promise<void> {
  const target = step.locator ? locate(page, step.locator) : undefined;
  switch (step.op) {
    case "goto": await page.goto(new URL(step.value!, baseURL).href, { waitUntil: "domcontentloaded" }); break;
    case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
    case "click": await target!.click(); break;
    case "dblclick": await target!.dblclick(); break;
    case "fill": await target!.fill(step.value!); break;
    case "press": await target!.press(step.value!); break;
    case "hover": await target!.hover(); break;
    case "setChecked": await target!.setChecked(step.checked!); break;
    case "selectOption": await target!.selectOption({ label: step.value! }); break;
    case "expectVisible": await expect(target!).toBeVisible({ timeout }); break;
    case "expectHidden": await expect(target!).toBeHidden({ timeout }); break;
    case "expectText": await expect(target!).toHaveText(step.value!, { timeout }); break;
    case "expectValue": await expect(target!).toHaveValue(step.value!, { timeout }); break;
    case "expectChecked": await expect(target!).toBeChecked({ checked: step.checked!, timeout }); break;
    case "expectEnabled":
      if (step.enabled) await expect(target!).toBeEnabled({ timeout });
      else await expect(target!).toBeDisabled({ timeout });
      break;
    case "expectAttribute": await expect(target!).toHaveAttribute(step.attribute!, step.value!, { timeout }); break;
    case "expectURL": await expect(page).toHaveURL(new URL(step.value!, baseURL).href, { timeout }); break;
    default: throw new Error(`unsupported probe operation: ${String(step.op)}`);
  }
}

function copyApplication(source: string, destination: string): void {
  const ignored = new Set(["node_modules", "dist", ".git", ".arc", "tests", "test", "test-results", "playwright-report", "coverage"]);
  fs.cpSync(source, destination, {
    recursive: true,
    // Preserve ordinary files (including SQLite databases), but do not traverse
    // grader/test artifacts. Symlinks to mutable data cannot ensure isolation.
    filter: (entry) => {
      if (entry === source) return true;
      if (ignored.has(path.basename(entry)) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry)) return false;
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Cannot isolate application symlink: ${path.relative(source, entry)}`);
      return true;
    },
  });
  // Only immutable dependency/build directories are shared. Databases, source
  // and other writable application files are private to this scenario.
  for (const relative of ["node_modules", "frontend/node_modules", "backend/node_modules", "frontend/dist", "backend/dist"]) {
    const original = path.join(source, relative);
    if (fs.existsSync(original)) {
      const link = path.join(destination, relative);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(original, link, "dir");
    }
  }
}

function reserveProbePort(evaluationPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else if (address.port === evaluationPort) reserveProbePort(evaluationPort).then(resolve, reject);
        else resolve(address.port);
      });
    });
  });
}

function stopGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function ready(baseURL: string, child: ChildProcess, deadline: number, getError: () => string): Promise<void> {
  while (Date.now() < deadline) {
    if (getError() || child.exitCode !== null || child.signalCode !== null) throw new Error(`Backend failed to start: ${getError() || child.exitCode || child.signalCode}`);
    try {
      // A living process alone is not readiness. The root must serve a page;
      // an arbitrary 500 or /api/health-only response is not enough.
      const response = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(1000), redirect: "manual" });
      const html = await response.text();
      if (response.ok && /<(?:!doctype\s+html|html|body|div|main)\b/i.test(html)) return;
    } catch { /* retry within deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Backend did not serve the application root before startup deadline");
}

export async function runProbes(manifest: RunnerManifest, reportPath: string): Promise<JudgeReport> {
  const report: JudgeReport = { results: [] };
  const save = (): void => {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
    fs.renameSync(`${reportPath}.tmp`, reportPath);
  };
  const artifacts = path.join(path.dirname(reportPath), `${path.basename(reportPath, ".json")}-artifacts`);
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "torine-judge-"));
  let browser: Browser | undefined;
  let active: ChildProcess | undefined;
  const cleanup = (): void => { if (active) stopGroup(active); };
  const interrupted = (): void => {
    cleanup();
    void (browser?.close() || Promise.resolve()).catch(() => {}).finally(() => {
      fs.rmSync(temporary, { recursive: true, force: true });
      save();
      process.exit(124);
    });
  };
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  try {
    browser = await chromium.launch({ headless: true });
    for (const [caseIndex, probe] of manifest.cases.entries()) {
      const result: ProbeResult = { caseId: probe.id, requirementId: probe.requirementId, scenarioId: probe.scenarioId, status: "blocked" };
      let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
      let page: Page | undefined;
      let backendOutput = "";
      let spawnError = "";
      const caseDir = path.join(temporary, `case-${caseIndex + 1}`);
      const deadline = Math.min(manifest.deadline, Date.now() + manifest.caseTimeoutMs);
      try {
        if (deadline - Date.now() < 1000) throw new Error("Judge execution time budget exhausted");
        copyApplication(manifest.outputDir, caseDir);
        const port = await reserveProbePort(manifest.evaluationPort);
        const baseURL = `http://127.0.0.1:${port}`;
        active = spawn("npm", ["run", "start"], {
          cwd: path.join(caseDir, "backend"), env: { ...process.env, PORT: String(port) },
          detached: true, stdio: ["ignore", "pipe", "pipe"],
        });
        active.on("error", (error) => { spawnError = String(error); });
        const capture = (chunk: Buffer): void => { backendOutput = (backendOutput + chunk.toString()).slice(-12_000); };
        active.stdout!.on("data", capture);
        active.stderr!.on("data", capture);
        await ready(baseURL, active, Math.min(deadline, Date.now() + 20_000), () => spawnError);
        context = await browser.newContext({ baseURL });
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          return url.origin === baseURL ? route.continue() : route.abort("blockedbyclient");
        });
        page = await context.newPage();
        for (const [stepIndex, step] of probe.steps.entries()) {
          result.stepIndex = stepIndex;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Scenario time budget exhausted");
          const timeout = Math.min(manifest.stepTimeoutMs, remaining);
          page.setDefaultTimeout(timeout);
          page.setDefaultNavigationTimeout(timeout);
          await execute(page, step, baseURL, timeout);
        }
        result.status = "passed";
        delete result.stepIndex;
      } catch (error) {
        // A spawned application crashing or failing to serve its root is a
        // product startup failure and deserves repair; missing browser/copy
        // support is infrastructure and must not masquerade as a UI failure.
        // Locator misses stay "blocked" on purpose: the probe's locator is an
        // assumption derived from the requirement, and repairing the product
        // from a possibly-wrong assumption is worse than reporting no verdict.
        const budgetExhausted = Date.now() >= deadline || /time budget exhausted/i.test(String(error));
        result.status = !budgetExhausted && (page || (active?.pid && !spawnError)) ? "failed" : "blocked";
        const failedOp = probe.steps[result.stepIndex ?? 0]?.op || "goto";
        result.failureKind = budgetExhausted || (!page && !active?.pid) ? "infrastructure"
          : page && (/strict mode violation|element\(s\) not found|resolved to 0 elements/i.test(String(error)) || !failedOp.startsWith("expect")) ? "locator" : "assertion";
        if (result.failureKind === "locator") result.status = "blocked";
        result.error = `${String(error).slice(0, 4500)}${page ? "" : `\n${backendOutput.slice(-2000)}`}`;
        if (page) {
          result.observation = await page.locator("body").innerText({ timeout: 500 }).then((s) => s.slice(0, 3000), () => "");
          const screenshot = path.join(artifacts, `case-${caseIndex + 1}.png`);
          if (await page.screenshot({ path: screenshot, timeout: 1000 }).then(() => true, () => false)) result.screenshot = screenshot;
        }
      } finally {
        await context?.close().catch(() => {});
        cleanup();
        active = undefined;
        fs.rmSync(caseDir, { recursive: true, force: true });
      }
      report.results.push(result);
      console.log(`[judge:case] ${probe.id} ${result.status}${result.stepIndex === undefined ? "" : ` at step ${result.stepIndex}`}`);
      save();
    }
  } catch (error) {
    report.infrastructureError = String(error);
  } finally {
    cleanup();
    await browser?.close().catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    save();
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestPath, reportPath] = process.argv.slice(2);
  if (!manifestPath || !reportPath) throw new Error("Usage: tsx judge-runner.ts manifest.json report.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RunnerManifest;
  const report = await runProbes(manifest, reportPath);
  process.exitCode = report.infrastructureError || report.results.some((r) => r.status !== "passed") ? 1 : 0;
}
