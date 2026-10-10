import { tool, type Plugin } from "@opencode-ai/plugin";
import { appendEvent, isShellTest, readEvents, rejectShellTest, requestDiagnostic, runTests, settingsFromEnv } from "./controller-tests.js";

const server: Plugin = async ({ directory }) => {
  const settings = settingsFromEnv(directory);
  appendEvent(settings.ledger, { type: "plugin-ready", turnId: settings.turnId });
  let queue = Promise.resolve();
  return {
    tool: {
      run_tests: tool({
        description: "Execute application tests with real exit codes, bounded time, single worker and controller failure tracking. Use this instead of shell test commands. Failures and timeouts are never cached. filter selects an application-relative file/pattern.",
        args: { target: tool.schema.enum(["frontend", "backend", "all"]), filter: tool.schema.string().optional() },
        async execute(args, context) {
          const previous = queue;
          let release!: () => void;
          queue = new Promise<void>(resolve => { release = resolve; });
          await previous;
          try {
            const results = [];
            for (const target of args.target === "all" ? ["frontend", "backend"] as const : [args.target]) {
              try {
                const record = await runTests(settings, target, args.filter, context.abort);
                results.push({ ...record, outputFile: undefined });
                if (record.code !== 0) break;
              } catch (error) {
                appendEvent(settings.ledger, { type: "test-tool-error", turnId: settings.turnId, error: String(error) });
                if (readEvents(settings.ledger).filter((e) => e.turnId === settings.turnId && e.type === "test-tool-error").length >= 3) requestDiagnostic(settings, "Test tool/environment errors repeated");
                throw error;
              }
            }
            return JSON.stringify({ results, note: "Development evidence only. Passing self-tests does not grant independent requirement acceptance." });
          } finally { release(); }
        },
      }),
    },
    "tool.execute.before": async (input, output) => {
      if (["bash", "shell"].includes(input.tool) && isShellTest(String(output.args.command || ""))) rejectShellTest(settings, output.args.command);
    },
  };
};

export default { id: "torine-controller", server };
