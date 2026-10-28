import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { EventLog, safeText, type Json } from "./events.js";
import { childEnvironment, copyProject, freePort } from "./checks.js";
import { command } from "./process.js";
import { SelfTestBudget } from "./selftest-budget.js";

// Parent-owned, bounded development checks. This is lifecycle/data isolation,
// not an OS sandbox or an independent acceptance judge.
export class DevTools {
  readonly token = randomBytes(32).toString("hex");
  private area = fs.mkdtempSync(path.join(os.tmpdir(), "torine-dev-"));
  private server?: http.Server;
  private service?: ChildProcess;
  private serviceOutput = "";
  private lease?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private closed = false;
  private closing?: Promise<void>;
  private app = "";
  private port = 0;
  private ready = false;
  private sourceHash = "";
  private readyPath = "/";
  private failedCleanup = false;
  private budget: SelfTestBudget;
  readonly receipts: Json[] = [];
  constructor(readonly options: { workspace: string; log: EventLog; reservedPort?: number;
    context?: Json; startupMs?: number; leaseMs?: number; maxCheckMs?: number; maxChecks?: number;
    maxSelfTestMs?: number; maxFailures?: number; budget?: SelfTestBudget; onBudgetExhausted?: () => void }) {
    this.budget = options.budget ?? new SelfTestBudget({ maxChecks: options.maxChecks, maxFailures: options.maxFailures, maxMs: options.maxSelfTestMs });
    options.log.secrets.push(this.token);
  }
  private emit(event: string, data: Json = {}) { this.options.log.emit("selftest", event, { ...this.options.context, ...data }); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  private status() {
    const running = Boolean(this.service?.pid && this.service.exitCode === null && this.service.signalCode === null);
    return { running, ready: running && this.ready, baseURL: running ? `http://127.0.0.1:${this.port}` : null,
      leaseMs: this.options.leaseMs ?? 180_000, checksRemaining: this.budget.snapshot().checksRemaining,
      budget: this.budget.snapshot(), dataLifecycle: "Fresh baseline copy on start/restart; preserved only until stop or source refresh", evidence: "Development check only, not requirement acceptance" };
  }
  private fingerprint() {
    const hash = createHash("sha256");
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (["node_modules", ".git", ".arc", "test-results", "playwright-report"].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unsupported app symlink: ${path.relative(this.options.workspace, file)}`);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) { hash.update(path.relative(this.options.workspace, file)); hash.update("\0"); hash.update(fs.readFileSync(file)); hash.update("\0"); }
      }
    };
    walk(this.options.workspace); return hash.digest("hex");
  }
  private snapshot() {
    if (this.service) throw new Error("Stop the managed app before refreshing its source snapshot");
    // Only replace a child of this instance's mkdtemp, never injected output.
    const target = path.join(this.area, "app");
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    copyProject(this.options.workspace, target); this.app = target; this.sourceHash = this.fingerprint();
  }
  async invoke(body: Json, signal?: AbortSignal): Promise<Json> {
    if (this.closed) throw new Error("Development tools are closed");
    if (body.action === "status") return this.status();
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await this.serial(async () => {
        controller.signal.throwIfAborted();
        if (this.closed) throw new Error("Development tools are closed");
        if (body.action === "stop") { await this.stop(); return this.status(); }
        if (body.action !== "start" && body.action !== "check") throw new Error("Unknown development tool action");
        let remainingMs: number;
        try { remainingMs = this.budget.begin(body.action); }
        catch (error) { this.emit("check_budget_exhausted", { level: "WARN", ...this.budget.snapshot() }); this.options.onBudgetExhausted?.(); throw error; }
        const boundedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)]);
        let failed = true;
        try {
          const result = body.action === "start" ? await this.start(String(body.readyPath || "/"), boundedSignal) : await this.check(body, boundedSignal);
          failed = result.passed === false;
          return result;
        } finally {
          const budget = this.budget.finish(failed);
          this.emit("selftest_budget", { level: budget.exhausted ? "WARN" : "INFO", ...budget,
            detail: "Cumulative active startup/check time and failures; app restart, source edits and repair sessions do not reset this requirement budget" });
          if (budget.exhausted) this.options.onBudgetExhausted?.();
        }
      });
    } finally { signal?.removeEventListener("abort", abort); this.controllers.delete(controller); }
  }
  private async start(readyPath: string, signal: AbortSignal): Promise<Json> {
    if (!readyPath.startsWith("/") || readyPath.startsWith("//") || /[\\\r\n]/.test(readyPath) || readyPath.length > 300) throw new Error("readyPath must be a bounded same-origin path");
    if (this.status().ready && this.sourceHash === this.fingerprint()) return this.status();
    await this.stop(); this.snapshot();
    this.readyPath = readyPath;
    this.port = await freePort(this.options.reservedPort);
    const env = childEnvironment({ PORT: String(this.port), ARC_WEB_PORT: String(this.port), ARC_EXTRA_PORTS: "0",
      DATABASE_FILE: path.join(this.app, "backend/database.db"), ARC_DB_FILE: path.join(this.app, "backend/database.db"),
      TORINE_DEV_WORKSPACE: this.app });
    this.serviceOutput = "";
    const child = spawn("npm", ["run", "start"], { cwd: path.join(this.app, "backend"), env,
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.service = child; let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { this.serviceOutput = (this.serviceOutput + chunk.toString()).slice(-8000); });
    const timeoutMs = this.options.startupMs ?? 30_000, started = Date.now();
    this.emit("app_starting", { pid: child.pid, port: this.port, timeoutMs, isolatedData: true });
    try {
      while (Date.now() - started < timeoutMs) {
        signal.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited before readiness: ${spawnError ?? child.exitCode ?? child.signalCode}; ${this.serviceOutput}`);
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}${readyPath}`, {
            redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
          const ok = response.ok; await response.body?.cancel();
          if (ok && child.exitCode === null && child.signalCode === null) {
            this.ready = true;
            this.lease = setTimeout(() => {
              this.emit("app_lease_expired", { level: "WARN" });
              // A hanging check must not defer lease expiry behind the queue.
              for (const controller of this.controllers) controller.abort();
              void this.serial(() => this.stop()).catch(error => { this.failedCleanup = true; this.emit("cleanup_failed", { level: "ERROR", detail: String(error) }); });
            }, this.options.leaseMs ?? 180_000);
            this.emit("app_ready", { ...this.status(), pid: child.pid, durationMs: Date.now() - started });
            return this.status();
          }
        } catch (error) { if (signal.aborted) throw error; }
        await pause(50, undefined, { signal });
      }
      throw new Error(`App readiness timed out after ${timeoutMs}ms; ${this.serviceOutput}`);
    } catch (error) { this.emit("app_start_failed", { level: "WARN", detail: String(error) }); await this.stop(); throw error; }
  }
  private async stop(): Promise<void> {
    if (this.lease) clearTimeout(this.lease); this.lease = undefined; this.ready = false;
    const child = this.service; if (!child) return;
    const pid = child.pid;
    const signal = (name: NodeJS.Signals) => {
      if (!pid) return;
      try { process.kill(-pid, name); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
    };
    try {
      signal("SIGTERM");
      const deadline = Date.now() + 500;
      while (child.exitCode === null && child.signalCode === null && !child.killed && Date.now() < deadline) await pause(25);
      signal("SIGKILL");
      const reapDeadline = Date.now() + 1000;
      while (pid && child.exitCode === null && child.signalCode === null && Date.now() < reapDeadline) await pause(25);
      if (pid && child.exitCode === null && child.signalCode === null) throw new Error(`Owned app ${pid} failed to exit after KILL`);
      this.emit("app_stopped", { pid, code: child.exitCode, signal: child.signalCode, cleanup: "owned process group signalled; parent exit confirmed" });
    } catch (error) { this.failedCleanup = true; throw error; }
    finally { child.stdout?.destroy(); child.stderr?.destroy(); this.service = undefined; }
  }
  private async check(body: Json, signal: AbortSignal): Promise<Json> {
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 8000) throw new Error("Check command must contain 1..8000 characters");
    if (/\b(pkill|killall|kill|nohup|disown|setsid)\b|(^|[^&>])&(?=[\s;\n]|$)|\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve)\b/.test(body.command)) throw new Error("Do not launch daemons or kill processes from checks; use torine_app start/stop");
    if (!["project", "backend", "frontend"].includes(body.directory)) throw new Error("directory must be project, backend or frontend");
    const requested = Number(body.timeoutSeconds ?? 60);
    if (!Number.isFinite(requested) || requested <= 0) throw new Error("timeoutSeconds must be positive");
    if (this.service && !this.status().ready) await this.stop();
    if (this.service && this.sourceHash !== this.fingerprint()) {
      this.emit("snapshot_refreshed", { level: "INFO", reason: "Output source/build/test scripts changed; restarting from a fresh baseline copy" });
      await this.start(this.readyPath, signal);
    }
    if (!this.service) this.snapshot();
    signal.throwIfAborted();
    const timeoutMs = Math.min(requested * 1000, this.options.maxCheckMs ?? 120_000, this.budget.snapshot().remainingMs);
    const cwd = body.directory === "project" ? this.app : path.join(this.app, body.directory);
    const env = childEnvironment({ BASE_URL: this.status().baseURL ?? "", TORINE_DEV_WORKSPACE: this.app });
    this.emit("check_start", { command: body.command.slice(0, 240), directory: body.directory, timeoutMs, appReady: this.status().ready });
    const result = await command("/bin/bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", body.command], {
      cwd, env, inheritEnv: false, signal, timeoutMs, log: this.options.log,
      context: { ...this.options.context, parentPhase: this.options.context?.phase, phase: "selftest-command" },
    });
    const receipt = { code: result.code, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted,
      passed: result.code === 0 && !result.timedOut && !result.aborted,
      output: safeText(result.output.slice(-6000), this.options.log.secrets), evidence: "Development check only; does not grant independent acceptance" };
    this.receipts.push(receipt);
    this.emit("check_end", { ...receipt, output: undefined, level: receipt.passed ? "INFO" : "WARN" });
    return receipt;
  }
  async listen(): Promise<{ baseURL: string; token: string }> {
    if (this.server || this.closed) throw new Error("Development control endpoint already started or closed");
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/invoke" || request.headers.authorization !== `Bearer ${this.token}`) { response.writeHead(403); response.end(); return; }
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 16_000) throw new Error("Development request too large"); chunks.push(chunk); }
        const value = await this.invoke(JSON.parse(Buffer.concat(chunks).toString()), controller.signal);
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
      } catch (error) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: safeText(String(error), this.options.log.secrets) })); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    this.server = server;
    return { baseURL: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, token: this.token };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const controller of this.controllers) controller.abort();
      if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); }
      try { await this.queue; await this.stop(); }
      catch (error) { this.failedCleanup = true; this.emit("cleanup_failed", { level: "ERROR", detail: String(error) }); }
      const record = { receipts: this.receipts, budget: this.budget.snapshot(), cleanupStatus: this.failedCleanup ? "failed" : "completed", scope: "owned temporary processes and copied application only" };
      fs.writeFileSync(path.join(this.options.log.root, `selftest-${Date.now()}-${randomBytes(3).toString("hex")}.json`), safeText(JSON.stringify(record, null, 2), this.options.log.secrets) + "\n", { mode: 0o600 });
      if (this.failedCleanup) throw new Error("Development tool cleanup failed; retaining temporary evidence");
      fs.rmSync(this.area, { recursive: true, force: true });
      this.emit("tools_closed", { cleanupStatus: "completed", checks: this.receipts.length });
    })();
    return this.closing;
  }
}
