// JSON-schema tool arguments are supported by pinned OpenCode 1.18.34.
// No extra plugin SDK/dependency and no shell-level daemon management needed.
export const TorineDevTools = async () => {
  const call = async (args, context) => {
    const base = process.env.TORINE_CONTROL_URL, token = process.env.TORINE_CONTROL_TOKEN;
    if (!base || !token) throw new Error("Parent development controller unavailable");
    const response = await fetch(`${base}/invoke`, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${token}`,
    }, body: JSON.stringify(args), signal: AbortSignal.any([context.abort, AbortSignal.timeout(160_000)]) });
    const result = await response.json();
    if (!response.ok || result.passed === false) throw new Error(JSON.stringify(result));
    return JSON.stringify(result);
  };
  return {
    tool: {
      torine_app: {
        description: "Manage an isolated development app: start/status/stop. Fixed backend npm run start, random non-evaluation port, 30s readiness deadline, 180s service lease. Each restart copies the original baseline data afresh; never delete a database to reset tests. Build before start. Output source/build/test-script changes are detected and automatically restart the copy before a check. Keep edits in the OUTPUT project, not the temporary copy. Returns baseURL. Never use Bash/nohup/& to start servers. Supply readyPath '/' or an actual existing health route. This is development evidence, not acceptance.",
        args: { action: { type: "string", enum: ["start", "status", "stop"] }, readyPath: { type: "string", description: "Same-origin readiness path; use / for status/stop" } },
        execute: call,
      },
      torine_check: {
        description: "Run a finite test/API/browser command on an isolated app copy, with pipefail, sanitized environment, captured exit/signal, and timeout capped at 120s. Per requirement, implementation and repair share at most 6 checks, 180s cumulative active startup/check time, and 2 failures. Stop retrying when exhausted and report unresolved results; app/session restart and source edits do not reset the budget. directory: project/backend/frontend; timeoutSeconds: 1..120. BASE_URL is set when torine_app is running; always read this env var, since refreshing changed source/scripts restarts the service at a new port with fresh baseline data. Keep test scripts in the OUTPUT project. Checks on unchanged source share private state; stop/start to reset all test-created records. Never pre-create WHEN targets. Model credentials are not inherited. Does not grant independent acceptance. Dependencies are reused, so do not install/modify node_modules.",
        args: { command: { type: "string" }, directory: { type: "string", enum: ["project", "backend", "frontend"] }, timeoutSeconds: { type: "number", minimum: 1, maximum: 120 } },
        execute: async (args, context) => call({ ...args, action: "check" }, context),
      },
    },
    "tool.execute.before": async (input, output) => {
      if (!["bash", "shell"].includes(input.tool)) return;
      const command = String(output.args?.command || "");
      if (/\b(pkill|killall|kill)\b/.test(command)) throw new Error("Do not kill processes by global name/pattern/PID. Use torine_app stop; the controller owns cleanup.");
      if (/\b(nohup|disown|setsid)\b|(^|[^&>])&(?=[\s;\n]|$)|\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve)\b|\bnode\s+(?:[^\s;]*\/)?(?:index|server|app)\.(?:[cm]?js|ts)\b/.test(command)) {
        throw new Error("Use torine_app start/status/stop for services. Do not launch daemons or background jobs from Bash. Use torine_check with BASE_URL for finite diagnostics.");
      }
      // Best-effort routing, not a shell sandbox. Arbitrary scripts can hide
      // tests; the outer implementation deadline still bounds those commands.
      if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)|\b(?:npx\s+)?(?:playwright|vitest|jest|pytest)\b|\bnode\s+--test\b|\bnode\s+[^\s;]*\.(?:test|spec)\.[cm]?js\b/.test(command)) {
        throw new Error("Use torine_check for finite tests so the parent can account for the shared requirement budget. Do not bypass exhausted checks with Bash.");
      }
      // Prevent the old default two-minute silent Bash wait, while retaining
      // longer explicit (but capped) build/install checks.
      const requested = Number(output.args.timeout);
      output.args.timeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 120_000) : 60_000;
    },
  };
};
