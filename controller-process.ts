import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type CommandResult = { code: number | null; output: string; stopped?: boolean };
export type CommandOptions = {
  cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string; heartbeatLabel?: string;
  controlFile?: string; ledgerFile?: string; turnId?: string; signal?: AbortSignal;
  log?: (text: string) => void; echo?: boolean; onSpawn?: (pid: number) => void;
};

export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

function cleanupTests(options: CommandOptions): void {
  if (!options.ledgerFile || !fs.existsSync(options.ledgerFile)) return;
  const active = new Set<number>();
  for (const line of fs.readFileSync(options.ledgerFile, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.turnId !== options.turnId || !Number.isInteger(event.pid) || event.pid < 2) continue;
      if (event.type === "test-start") active.add(event.pid);
      if (event.type === "test-end") active.delete(event.pid);
    } catch { /* trailing partial write */ }
  }
  for (const pid of active) killGroup(pid);
}

export function runProcess(command: string, argv: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ code: 125, output: "Execution aborted", stopped: true }); return; }
    const child = spawn(command, argv, { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const started = Date.now();
    const sink = (text: string): void => {
      if (!options.logFile) return;
      fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
      fs.appendFileSync(options.logFile, text);
    };
    sink(`=== ${new Date().toISOString()} ${path.basename(command)} (cwd ${options.cwd}) ===\n`);
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      cleanupTests(options);
      if (child.pid) killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => { if (child.pid) killGroup(child.pid); }, 1000);
    };
    const finish = (code: number | null, error = ""): void => {
      if (settled) return;
      settled = true;
      if (options.controlFile && fs.existsSync(options.controlFile)) stopped = true;
      clearTimeout(timer); clearInterval(poll); clearInterval(heartbeat); clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
      cleanupTests(options);
      // Also reclaim successful commands' orphaned descendants before the next
      // build/repair. We only own this child's process group.
      if (child.pid) killGroup(child.pid);
      child.stdout.destroy(); child.stderr.destroy();
      sink(`\n=== exit ${code}, stopped=${stopped}, duration=${Date.now() - started}ms ===\n`);
      resolve({ code: timedOut ? 124 : stopped ? 125 : code, output: output + error, stopped });
    };
    const capture = (chunk: Buffer, stderr: boolean): void => {
      const text = chunk.toString(); output = (output + text).slice(-200_000); sink(text);
      if (options.echo !== false) (stderr ? process.stderr : process.stdout).write(text);
    };
    child.stdout.on("data", (c: Buffer) => capture(c, false));
    child.stderr.on("data", (c: Buffer) => capture(c, true));
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 10 * 60_000);
    const poll = setInterval(() => { if (options.controlFile && fs.existsSync(options.controlFile)) stop(); }, 100);
    const heartbeat = setInterval(() => {
      if (options.heartbeatLabel) options.log?.(`[heartbeat] ${options.heartbeatLabel} running ${Math.round((Date.now() - started) / 1000)}s`);
    }, 60_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("spawn", () => { if (child.pid) options.onSpawn?.(child.pid); });
    child.on("error", (error) => finish(1, `\nspawn error: ${String(error)}`));
    // On exit, descendants may still hold pipes. Give output a short drain
    // window, then reclaim the group; close otherwise finishes immediately.
    child.on("exit", (code) => { setTimeout(() => finish(code), 100).unref(); });
    child.on("close", (code) => finish(code));
  });
}
