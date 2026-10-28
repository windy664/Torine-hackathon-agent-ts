import { spawn } from "node:child_process";
import { EventLog, JsonLines, type Json } from "./events.js";

export async function command(command: string, args: string[], options: {
  cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; log: EventLog; context?: Json;
  json?: boolean; onEvent?: (event: Json) => void; tick?: () => void;
  signal?: AbortSignal; inheritEnv?: boolean; heartbeatMs?: number;
}): Promise<{ code: number | null; output: string; timedOut: boolean; signal: NodeJS.Signals | null; aborted?: boolean }> {
  const context = options.context ?? {};
  if (options.signal?.aborted) return { code: null, output: "Execution aborted", timedOut: false, signal: null, aborted: true };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return { code: null, output: "No execution budget remains", timedOut: true, signal: null };
  options.log.emit("orchestration", "process_start", { ...context, command, args: args.map(value => value.length > 300 ? `[${value.length} chars]` : value) });
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", done = false, timedOut = false, aborted = false;
    const started = Date.now();
    const parser = new JsonLines(value => { options.log.ingest(value, context); options.onEvent?.(value); }, line => options.log.emit("diagnostic", "stdout", { ...context, text: line.slice(-4000) }));
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-150_000);
      options.log.raw("stdout", chunk.toString());
      if (options.json) parser.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-150_000);
      options.log.raw("stderr", chunk.toString());
      options.log.emit("diagnostic", "stderr", { ...context, text: chunk.toString().slice(-4000) });
    });
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch {} } };
    let hardKill: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null = null, error?: string) => {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(heartbeat); clearInterval(tick);
      options.signal?.removeEventListener("abort", abort);
      if (hardKill) clearTimeout(hardKill);
      // Also clean up grandchildren after an otherwise successful parent exit.
      kill("SIGKILL"); parser.finish(); options.tick?.(); options.log.flushRaw();
      options.log.emit(error || timedOut || aborted || code !== 0 ? "error" : "orchestration", "process_end", { ...context, code, signal, timedOut, aborted, durationMs: Date.now() - started, error });
      resolve({ code: timedOut || aborted ? null : code, output: error ? `${output}\n${error}` : output, timedOut, aborted, signal });
    };
    const timer = setTimeout(() => {
      timedOut = true; options.log.emit("error", "timeout", context); kill("SIGTERM");
      hardKill = setTimeout(() => { kill("SIGKILL"); finish(null); child.stdout.destroy(); child.stderr.destroy(); }, 3000);
    }, options.timeoutMs);
    const abort = () => {
      if (done || aborted) return;
      aborted = true; kill("SIGTERM");
      if (!hardKill) hardKill = setTimeout(() => { kill("SIGKILL"); finish(null); child.stdout.destroy(); child.stderr.destroy(); }, 1000);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const heartbeat = setInterval(() => options.log.heartbeat("running", { ...context, elapsedMs: Date.now() - started }), options.heartbeatMs ?? 30_000);
    const tick = setInterval(() => options.tick?.(), 500);
    // exit can precede the final stdout bytes; close means pipes have drained.
    child.on("exit", () => kill("SIGKILL"));
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", error => finish(1, null, String(error)));
  });
}
