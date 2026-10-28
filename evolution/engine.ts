import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventLog, JsonLines, type Json } from "./events.js";
import { command } from "./process.js";
import { DevTools } from "./devtools.js";
import { SelfTestBudget } from "./selftest-budget.js";

export class Engine {
  private config: string;
  private sessions = new Map<string, string>();
  private selfTestBudgets = new Map<string, SelfTestBudget>();
  private running = false;
  constructor(readonly options: { root: string; workspace: string; privateDir: string; baseURL: string; model: string; log: EventLog; env?: NodeJS.ProcessEnv; reservedPort?: number }) {
    const modelId = options.model.replace(/^[^/]+\//, "");
    this.config = path.join(options.privateDir, "opencode.json");
    fs.writeFileSync(this.config, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { torine: { npm: "@ai-sdk/openai-compatible", name: "ARC gateway", options: { baseURL: options.baseURL, apiKey: "{env:OPENAI_API_KEY}" },
        models: { [modelId]: { name: modelId, reasoning: true, interleaved: { field: "reasoning_content" }, limit: { context: 128000, output: 16000 } } } } },
      plugin: ["observer.mjs", "devtools-plugin.mjs"].map(name => pathToFileURL(path.join(options.root, "evolution", name)).href),
      permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", task: "deny" },
      agent: {
        torine: { mode: "primary", description: "Incremental implementation", permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", task: "deny" } },
        verifier: { mode: "primary", description: "Read-only public-requirement check planning", permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" } },
      },
    }, null, 2), { mode: 0o600 });
  }
  session(key: string) { return this.sessions.get(key); }
  resetSession(key: string) { this.sessions.delete(key); }
  async turn(key: string, prompt: string, timeoutMs: number, context: Json = {}, readonly = false) {
    if (this.running) throw new Error("Concurrent implementation turns are disabled: one writer owns the shared output project");
    this.running = true;
    try { return await this.runTurn(key, prompt, timeoutMs, context, readonly); }
    finally { this.running = false; }
  }
  private async runTurn(key: string, prompt: string, timeoutMs: number, context: Json, readonly: boolean) {
    const spool = path.join(this.options.privateDir, `observer-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    let offset = 0, text = "", sessionId = this.sessions.get(key), observerReady = false, failed = false;
    const parser = new JsonLines(value => { if (value.type === "observer.ready") observerReady = true; else this.options.log.ingest(value, context); }, line => this.options.log.emit("diagnostic", "observer", { ...context, text: line.slice(-2000) }));
    const poll = () => {
      if (!fs.existsSync(spool)) return;
      const size = fs.statSync(spool).size;
      if (size <= offset) return;
      const fd = fs.openSync(spool, "r");
      try { const buffer = Buffer.alloc(size - offset); const count = fs.readSync(fd, buffer, 0, buffer.length, offset); offset += count; parser.push(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
    };
    this.options.log.emit("session", "resume", { ...context, key, sessionId: sessionId ?? null, mode: readonly ? "read-only" : "implementation" });
    const args = ["run", "--dir", this.options.workspace, "--model", `torine/${this.options.model.replace(/^[^/]+\//, "")}`, "--format", "json", "--auto", "--title", `Torine ${key.slice(0, 80)}`, "--agent", readonly ? "verifier" : "torine"];
    if (sessionId) args.push("--session", sessionId);
    args.push(prompt);
    const budgetKey = String(context.requirement ?? key);
    const turnAbort = new AbortController();
    let stopReason: string | null = null;
    if (!this.selfTestBudgets.has(budgetKey)) this.selfTestBudgets.set(budgetKey, new SelfTestBudget());
    const tools = new DevTools({ workspace: this.options.workspace, log: this.options.log, context,
      budget: this.selfTestBudgets.get(budgetKey), reservedPort: this.options.reservedPort,
      onBudgetExhausted: () => {
        if (turnAbort.signal.aborted) return;
        stopReason = `Self-test budget exhausted: ${this.selfTestBudgets.get(budgetKey)!.snapshot().reason}`;
        this.options.log.emit("orchestration", "selftest_limit_interrupt", { ...context, level: "WARN", detail: stopReason,
          action: "Interrupt this implementation process group; retain partial edits and independent verification evidence" });
        turnAbort.abort();
      } });
    try {
    const control = await tools.listen();
    const result = await command(path.join(this.options.root, "node_modules/.bin/opencode"), args, {
      cwd: this.options.workspace, timeoutMs, log: this.options.log, context, json: true, tick: poll, signal: turnAbort.signal,
      env: { ...this.options.env, OPENCODE_CONFIG: this.config, OPENCODE_CONFIG_DIR: path.join(this.options.privateDir, "config"),
        XDG_DATA_HOME: path.join(this.options.privateDir, "data"), XDG_CACHE_HOME: path.join(this.options.privateDir, "cache"),
        XDG_CONFIG_HOME: path.join(this.options.privateDir, "xdg-config"), TORINE_EVENT_SPOOL: spool,
        TORINE_CONTROL_URL: control.baseURL, TORINE_CONTROL_TOKEN: control.token,
        OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" },
      onEvent: value => {
        const id = value.sessionID ?? value.part?.sessionID;
        if (typeof id === "string") { sessionId = id; this.sessions.set(key, id); }
        if (value.type === "text") text += value.part?.text ?? "";
        if (value.type === "error") failed = true;
      },
    });
    poll(); parser.finish();
    this.options.log.endTurn(sessionId);
    this.options.log.emit("session", "turn_end", { ...context, key, sessionId, observerReady, engineError: failed, stopReason });
    return { ...result, code: failed && result.code === 0 ? 1 : result.code, text, sessionId, observerReady, stopReason };
    } finally { await tools.close(); }
  }
}
