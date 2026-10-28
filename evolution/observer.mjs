import fs from "node:fs";

// No model content or credential storage here. All live sessions, including Task
// children, are observed; root CLI events are deduplicated by session/part IDs.
export const TorineObserver = async () => {
  const target = process.env.TORINE_EVENT_SPOOL;
  const secret = process.env.OPENAI_API_KEY;
  const write = (value) => {
    if (!target) return;
    let line = JSON.stringify(value);
    if (secret) line = line.split(secret).join("[REDACTED]");
    line = line.replace(/\b(?:ak_|sk-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
    fs.appendFileSync(target, JSON.stringify({ occurredAt: new Date().toISOString(), ...JSON.parse(line) }) + "\n", { mode: 0o600 });
  };
  write({ type: "observer.ready" });
  return {
    "chat.headers": async (input, output) => { output.headers["x-torine-session-id"] = input.sessionID; },
    event: async ({ event }) => {
      if (["session.created", "session.updated", "session.error"].includes(event.type)) {
        const info = event.properties?.info;
        write({ type: event.type, properties: { info: info ? { id: info.id, parentID: info.parentID } : undefined, error: event.properties?.error } });
      } else if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part && ["tool", "step-finish"].includes(part.type)) {
          const state = part.state;
          const input = state?.input ? Object.fromEntries(Object.entries(state.input).map(([key, value]) => [key,
            /content|oldString|newString|patchText/.test(key) ? `[omitted ${String(value).length} chars]` : typeof value === "string" ? value.slice(0, 4000) : value])) : undefined;
          write({ type: event.type, part: { id: part.id, sessionID: part.sessionID, type: part.type, tool: part.tool, callID: part.callID, tokens: part.tokens, cost: part.cost,
            state: state ? { status: state.status, input, error: state.error === undefined ? undefined : String(state.error).slice(0, 2000), time: state.time } : undefined } });
        }
      }
    },
  };
};
