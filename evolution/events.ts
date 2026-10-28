import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { estimate, loadPrices, type Prices } from "./billing.js";

export type Json = Record<string, any>;
function pendingDescription(gateway: Json) {
  return gateway.pendingRequests ? `: ${gateway.pendingRequests} pending, oldest ${Math.floor(gateway.oldestPendingRequestMs / 1000)}s` : "";
}
export function safeText(text: string, secrets: string[] = []): string {
  for (const value of secrets.filter(value => value.length > 3)) text = text.split(value).join("[REDACTED]");
  return text.replace(/\b(?:ak_|sk-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/("(?:cookie|authorization|api[_-]?key)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/((?:cookie|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;"}]+/gi, "$1[REDACTED]");
}

export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  constructor(private consume: (value: Json) => void, private diagnostic: (line: string) => void) {}
  push(chunk: Buffer | string) {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      this.line(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + 1);
    }
    if (this.pending.length > 2_000_000) { this.diagnostic("oversized unterminated line omitted"); this.pending = ""; }
  }
  private line(line: string) {
    if (!line.trim()) return;
    try { const value = JSON.parse(line); if (value && typeof value === "object" && !Array.isArray(value)) this.consume(value); else this.diagnostic(line); }
    catch { this.diagnostic(line); }
  }
  finish() { this.pending += this.decoder.end(); if (this.pending) this.line(this.pending); this.pending = ""; }
}

export function classify(tool: string, input: unknown): Json {
  if (tool === "torine_app") return { activity: "service", classification: "tool" };
  if (tool === "torine_check") return { activity: "verification", classification: "tool" };
  if (/task|agent/.test(tool)) return { activity: "delegation", classification: "tool" };
  if (/^(read|glob|grep|list|lsp)$/.test(tool)) return { activity: "inspection", classification: "tool" };
  if (/^(edit|write|apply_patch)$/.test(tool)) return { activity: "modification", classification: "tool" };
  if (tool === "bash") {
    const command = JSON.stringify(input);
    if (/\b(test|pytest|vitest|playwright|jest|tsc)\b|npm\s+run\s+(build|typecheck)/.test(command)) return { activity: "verification", classification: "heuristic" };
    if (/\b(cat|sed|rg|head|tail|ls|find)\b|git\s+(diff|status|log)/.test(command)) return { activity: "inspection", classification: "heuristic" };
  }
  return { activity: "unknown", classification: "unknown" };
}

export class EventLog {
  readonly runId: string;
  private context: Json = {};
  private phases = new Map<string, Json>();
  private prices: Prices;
  private usage = new Map<string, Json>();
  private lineage = new Map<string, string | null>();
  private tools = new Map<string, number>();
  private seen = new Set<string>();
  private requests = new Map<string, Json>();
  private rawPending = new Map<string, string>();
  private rawBytes = new Map<string, number>();
  private terminalTools = new Set<string>();
  private activityCounts: Json = {};
  private activityErrors: Json = {};
  private lastActivity: Json | null = null;
  private activeDetails = new Map<string, Json>();
  private lastActionAt: number | null = null;
  constructor(readonly root: string, readonly secrets: string[] = [], options: { runId?: string; prices?: Prices } = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.runId = options.runId ?? randomUUID(); this.prices = options.prices ?? loadPrices();
  }
  setContext(context: Json) { this.context = { ...context }; }
  canPrice(model: string) { return estimate([{ model, usage: { input: 0, output: 0, cacheRead: 0 } }], this.prices).unpricedRequests === 0; }
  endTurn(sessionId?: string) {
    if (!sessionId) return;
    const family = new Set([sessionId]);
    for (let changed = true; changed;) { changed = false; for (const [child, parent] of this.lineage) if (parent && family.has(parent) && !family.has(child)) { family.add(child); changed = true; } }
    for (const [id, started] of this.tools) if ([...family].some(session => id.startsWith(`${session}:`))) {
      this.tools.delete(id); this.activeDetails.delete(id); this.emit("tool", "interrupted", { level: "WARN", sessionId, toolId: id, durationMs: Date.now() - started, detail: "Owning engine turn exited without a terminal tool event; not marked completed" });
    }
    if (this.lastActivity && family.has(this.lastActivity.sessionId) && ["running", "pending"].includes(this.lastActivity.status)) this.lastActivity = { ...this.lastActivity, status: "interrupted" };
  }
  phaseStart(context: Json) {
    this.setContext(context);
    const id = `${this.runId}/${context.requirement ?? "run"}/${context.phase}/${context.attempt ?? 0}`;
    this.phases.set(id, { ...context, id, status: "running", startedAt: new Date().toISOString() });
    this.emit("orchestration", "phase_start", context);
  }
  phaseEnd(status: string) {
    const id = `${this.runId}/${this.context.requirement ?? "run"}/${this.context.phase}/${this.context.attempt ?? 0}`;
    const phase = this.phases.get(id);
    if (phase) Object.assign(phase, { status, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(phase.startedAt) });
    this.emit(status === "failed" ? "error" : "orchestration", "phase_end", { status, durationMs: phase?.durationMs });
  }
  heartbeat(event = "running", context: Json = {}) {
    const summary = this.summary(), waiting = summary.activity;
    const oldest = Math.max(waiting.oldestActiveToolMs, summary.gateway.oldestPendingRequestMs);
    const active = waiting.activeTools[0];
    this.emit("heartbeat", event, { ...context, level: oldest >= 90_000 ? "WARN" : "INFO",
      detail: `${waiting.waitingOn}${active ? `: ${active.tool} ${active.target} (${Math.floor(active.elapsedMs / 1000)}s)` : pendingDescription(summary.gateway)}; no completed tool action for ${waiting.lastCompletedActionAgeMs ?? "unknown"}ms (not a functional-progress verdict)`, usage: summary });
  }
  emit(category: string, event: string, data: Json = {}) {
    const scope = { ...this.context, ...data };
    const parentPhase = scope.phase !== this.context.phase ? this.context.phase : undefined;
    const level = data.level ?? (category === "error" || data.state === "product_failed" ? "ERROR" : /invalid|unchecked|infrastructure_failed|missing|truncated/.test(`${event} ${data.state}`) ? "WARN" :
      ["model", "tool", "session", "diagnostic"].includes(category) || event === "step" || event === "step_finish" ? "DEBUG" : "INFO");
    const record = { time: new Date().toISOString(), runId: this.runId, level, category, event, parentPhase,
      scopePath: [this.runId, scope.requirement, parentPhase, scope.phase, scope.sessionId, scope.requestId ?? scope.callId].filter(Boolean), ...scope };
    const line = safeText(JSON.stringify(record), this.secrets);
    fs.appendFileSync(path.join(this.root, "events.jsonl"), line + "\n", { mode: 0o600 });
    if (level !== "DEBUG") {
      const { cumulative, text, input, ...progress } = record as Json;
      if (cumulative) { progress.billing = cumulative.billing; progress.requests = cumulative.gateway.requests; }
      if (progress.usage?.gateway) progress.usage = { gateway: progress.usage.gateway, billing: progress.usage.billing, activity: progress.usage.activity };
      const brief = safeText(JSON.stringify(progress), this.secrets);
      fs.appendFileSync(path.join(this.root, "progress.jsonl"), brief + "\n", { mode: 0o600 });
      const billing = progress.billing ?? progress.usage?.billing;
      const money = billing ? ` | estimate ${billing.estimatedCny != null ? `CNY ${billing.estimatedCny.toFixed(4)}` : `>= CNY ${billing.lowerBoundCny.toFixed(4)} (incomplete)`}; settled ${billing.billedCny ?? "unknown"}` : "";
      const detail = data.detail ?? data.status ?? data.state ?? "";
      const human = `${record.time} ${level} ${[scope.requirement ?? "run", parentPhase, scope.phase ?? category].filter(Boolean).join(" > ")} > ${event}${scope.attempt ? ` #${scope.attempt}` : ""}${detail ? ` | ${String(detail).replace(/\s+/g, " ").slice(0, 220)}` : ""}${money}`;
      const rendered = safeText(human, this.secrets);
      fs.appendFileSync(path.join(this.root, "progress.log"), rendered + "\n", { mode: 0o600 }); console.log(brief); console.error(rendered);
    }
  }
  raw(channel: string, data: string) {
    // Hold a suffix so a credential split across pipe chunks is still redacted.
    const value = (this.rawPending.get(channel) ?? "") + data;
    const hold = Math.max(512, ...this.secrets.map(secret => secret.length + 256));
    if (value.length <= hold * 2) { this.rawPending.set(channel, value); return; }
    const redacted = safeText(value, this.secrets), cut = Math.max(0, redacted.length - hold);
    this.appendRaw(channel, redacted.slice(0, cut)); this.rawPending.set(channel, redacted.slice(cut));
  }
  private appendRaw(channel: string, value: string) {
    const bytes = this.rawBytes.get(channel) ?? 0, remaining = 20_000_000 - bytes;
    if (remaining <= 0) return;
    const buffer = Buffer.from(value).subarray(0, remaining);
    fs.appendFileSync(path.join(this.root, `${channel}.log`), buffer, { mode: 0o600 });
    this.rawBytes.set(channel, bytes + buffer.length);
    if (buffer.length === remaining) this.emit("diagnostic", "raw_log_truncated", { channel, limitBytes: 20_000_000 });
  }
  flushRaw() { for (const [channel, value] of this.rawPending) this.appendRaw(channel, safeText(value, this.secrets)); this.rawPending.clear(); }
  ingest(value: Json, context: Json = {}) {
    const type = value.type;
    if (type === "gateway.request") {
      this.requests.set(value.requestId, { ...value, pending: true });
      this.emit("model", "request_started", { ...context, ...value, level: "INFO", detail: "Waiting for model response; this is not functional progress" }); this.saveSummary(); return;
    }
    if (type === "gateway.usage") {
      this.requests.set(value.requestId, value);
      this.emit("usage", type, { ...context, ...value, level: value.usage ? "INFO" : "WARN", requestBilling: estimate([value], this.prices), cumulative: this.summary() }); this.saveSummary(); return;
    }
    const part = value.part ?? value.properties?.part;
    const info = value.properties?.info;
    if (type === "session.created" || type === "session.updated") {
      if (!info?.id) return;
      this.lineage.set(info.id, info.parentID ?? null);
      this.emit("session", type, { ...context, sessionId: info.id, parentSessionId: info.parentID ?? null });
      return;
    }
    const sessionId = value.sessionID ?? part?.sessionID ?? info?.sessionID;
    const data = { ...context, sessionId, parentSessionId: this.lineage.get(sessionId) ?? null, occurredAt: value.occurredAt };
    if ((type === "step_finish" || type === "message.part.updated") && part?.type === "step-finish") {
      const key = `${sessionId}:${part.id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const tokens = part.tokens;
      const fields: Json = {};
      for (const [name, v] of Object.entries({ input: tokens?.input, output: tokens?.output, reasoning: tokens?.reasoning, cacheRead: tokens?.cache?.read, cacheWrite: tokens?.cache?.write })) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) fields[name] = v;
      }
      const record = { ...data, partId: part.id, fields, engineCost: typeof part.cost === "number" ? part.cost : null };
      this.usage.set(key, record);
      this.emit("usage", "step_finish", { ...record, cumulative: this.summary() });
      this.saveSummary();
    } else if ((type === "tool_use" || type === "message.part.updated") && part?.type === "tool") {
      const key = `${sessionId}:${part.id}:${part.state?.status}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const toolId = `${sessionId}:${part.id}`;
      if (this.terminalTools.has(toolId)) return;
      if (part.state?.status === "running" && !this.tools.has(toolId)) this.tools.set(toolId, Date.now());
      const began = this.tools.get(toolId) ?? part.state?.time?.start;
      const activity = classify(part.tool, part.state?.input);
      if (["completed", "error"].includes(part.state?.status)) {
        this.terminalTools.add(toolId); this.tools.delete(toolId); this.activeDetails.delete(toolId); this.lastActionAt = Date.now();
        const counts = part.state.status === "error" ? this.activityErrors : this.activityCounts;
        counts[activity.activity] = (counts[activity.activity] ?? 0) + 1;
      }
      const target = String(part.state?.input?.filePath ?? part.state?.input?.path ?? part.state?.input?.command ?? part.state?.input?.action ?? "").slice(0, 240);
      this.lastActivity = { ...data, tool: part.tool, status: part.state?.status, target, at: new Date().toISOString() };
      if (part.state?.status === "running") this.activeDetails.set(toolId, { ...this.lastActivity, toolId });
      const boundedInput = Object.fromEntries(Object.entries(part.state?.input ?? {}).map(([name, value]) => [name, /content|oldString|newString|patchText/.test(name) ? `[omitted ${String(value).length} chars]` : typeof value === "string" ? value.slice(0, 1000) : value]));
      this.emit("tool", part.state?.status ?? "unknown", { ...data, level: part.state?.status === "error" ? "WARN" : "DEBUG", tool: part.tool, callId: part.callID, partId: part.id, ...activity, input: safeText(JSON.stringify(boundedInput), this.secrets), durationMs: part.state?.time?.end && part.state?.time?.start ? part.state.time.end - part.state.time.start : began ? Date.now() - began : null, error: part.state?.error });
      if (["running", "completed", "error"].includes(part.state?.status)) this.emit("activity", "tool_progress", { ...data,
        level: part.state.status === "error" ? "WARN" : "INFO", tool: part.tool, callId: part.callID,
        status: part.state.status, target, ...activity,
        detail: `${part.tool} ${part.state.status}: ${target || "(no target)"}` });
    } else if (type === "error" || type === "session.error" || info?.error) this.emit("error", String(type), { ...data, error: value.error ?? value.properties?.error ?? info?.error });
    else if (["text", "reasoning"].includes(type)) this.emit("model", type, { ...data, text: part?.text ?? "" });
  }
  summary() {
    const totals: Json = {};
    const samples: Json = {};
    for (const record of this.usage.values()) for (const [field, amount] of Object.entries(record.fields)) {
      totals[field] = (totals[field] ?? 0) + Number(amount); samples[field] = (samples[field] ?? 0) + 1;
    }
    const gatewayTotals: Json = {};
    let missing = 0, pending = 0;
    for (const request of this.requests.values()) {
      if (request.pending) { pending++; continue; }
      if (!request.usage) { missing++; continue; }
      for (const [field, amount] of Object.entries(request.usage)) if (typeof amount === "number") gatewayTotals[field] = (gatewayTotals[field] ?? 0) + amount;
    }
    const requests = [...this.requests.values()];
    const now = Date.now(), active: Json[] = [...this.activeDetails.values()].map(item => ({ ...item, elapsedMs: now - (this.tools.get(item.toolId) ?? now) }));
    const pendingAges = requests.filter(request => request.pending && request.startedAt).map(request => now - Date.parse(request.startedAt)).filter(Number.isFinite);
    const groupBy = (field: string) => Object.fromEntries([...new Set(requests.map(request => request[field] ?? "unassigned"))].map(value => { const group = requests.filter(request => (request[field] ?? "unassigned") === value); return [value, { requests: group.length, billing: estimate(group, this.prices) }]; }));
    const byRequirement = groupBy("requirement");
    return {
      runId: this.runId, current: this.context, phases: [...this.phases.values()],
      scope: "engine_reported_committed_steps", steps: this.usage.size,
      reportedTokens: totals, fieldSamples: samples,
      // OpenCode normalizes absent gateway fields to zero. Its events alone cannot
      // prove complete billing coverage, especially retries/auxiliary requests.
      billingComplete: false, costCny: null,
      billing: estimate(requests, this.prices), byRequirement, byPhase: groupBy("phase"), bySession: groupBy("sessionId"),
      caveat: "Missing upstream usage may be normalized to zero; retries/auxiliary calls may be absent. Use platform billing for authoritative totals.",
      sessions: [...this.lineage].map(([sessionId, parentSessionId]) => ({ sessionId, parentSessionId })),
      activity: { completedByCategory: this.activityCounts, errorsByCategory: this.activityErrors, activeToolCount: this.tools.size, lastObservedTool: this.lastActivity,
        activeTools: active, oldestActiveToolMs: Math.max(0, ...active.map(item => item.elapsedMs)),
        lastCompletedActionAgeMs: this.lastActionAt === null ? null : now - this.lastActionAt,
        waitingOn: this.tools.size ? "tool_execution" : pending ? "model_request" : "controller_or_engine", progressVerdict: "unknown; usage/activity is not behavior acceptance" },
      gateway: { requests: this.requests.size, completedRequests: this.requests.size - pending, pendingRequests: pending, oldestPendingRequestMs: Math.max(0, ...pendingAges), missingUsageRequests: missing, reportedTokens: gatewayTotals, allObservedRequestsReportedUsage: this.requests.size > 0 && missing === 0 && pending === 0 },
    };
  }
  saveSummary() { fs.writeFileSync(path.join(this.root, "summary.json"), safeText(JSON.stringify(this.summary(), null, 2), this.secrets) + "\n", { mode: 0o600 }); }
}
