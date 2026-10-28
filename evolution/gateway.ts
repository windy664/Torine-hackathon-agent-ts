import http from "node:http";
import { randomUUID } from "node:crypto";
import { EventLog, type Json } from "./events.js";

export function normalizeUsage(raw: any): Json | null {
  if (!raw || typeof raw.prompt_tokens !== "number" || typeof raw.completion_tokens !== "number") return null;
  const result: Json = { input: raw.prompt_tokens, output: raw.completion_tokens };
  const fields = { total: raw.total_tokens, cacheRead: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens,
    cacheMiss: raw.prompt_cache_miss_tokens, reasoning: raw.completion_tokens_details?.reasoning_tokens };
  for (const [field, value] of Object.entries(fields)) if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[field] = value;
  if (Object.values(result).some(value => !Number.isFinite(value) || value < 0)) return null;
  return result;
}

export async function startGateway(upstream: string, log: EventLog, context: () => Json = () => ({}), controls: { thinking?: "enabled" | "disabled"; effort?: "low" | "high" | "max" } = {}, limits: { maxEstimatedCny?: number | null; maxRequests?: number } = {}) {
  const target = new URL(upstream.replace(/\/$/, "") + "/");
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Invalid gateway URL protocol");
  const aborts = new Set<AbortController>();
  const active = new Set<Promise<void>>();
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const requestId = randomUUID(), owner = context();
    const sessionId = typeof request.headers["x-torine-session-id"] === "string" ? request.headers["x-torine-session-id"] : null;
    let usage: Json | null = null;
    let status: number | null = null;
    let modelName: string | null = null;
    let observed = false;
    const started = Date.now();
    const abort = new AbortController(); aborts.add(abort);
    const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000);
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    response.on("close", disconnected);
    try {
      if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8_000_000) throw new Error("Gateway request too large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof body.model !== "string" || !Array.isArray(body.messages)) throw new Error("Invalid completion request");
      modelName = body.model;
      const summary = log.summary();
      if (limits.maxEstimatedCny != null && (!log.canPrice(body.model) || summary.billing.lowerBoundCny >= limits.maxEstimatedCny) || limits.maxRequests != null && summary.gateway.requests >= limits.maxRequests) {
        log.emit("error", "model_budget_exhausted", { ...owner, limits, billing: summary.billing, requests: summary.gateway.requests });
        response.writeHead(402, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Torine observed model budget exhausted; no upstream request sent", type: "budget_exhausted" } })); return;
      }
      if (controls.thinking) body.thinking = { type: controls.thinking };
      if (controls.effort) body.reasoning_effort = controls.effort;
      // Planning is one bounded, tool-free conversion of supplied public
      // scenarios, not another deep repository investigation.
      if (owner.phase === "check-planning" && /^deepseek(?:-|\/)/.test(body.model)) {
        body.thinking = { type: "disabled" }; delete body.reasoning_effort;
      }
      if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      observed = true;
      log.ingest({ type: "gateway.request", ...owner, requestId, sessionId, model: body.model, startedAt: new Date(started).toISOString() });
      log.emit("model", "request", { ...owner, requestId, sessionId, model: body.model,
        thinking: body.thinking ?? "gateway-default-unknown", effort: body.reasoning_effort ?? "gateway-default-unknown",
        messages: body.messages?.length, tools: body.tools?.length,
        previousAssistantReasoningFields: body.messages?.filter((message: any) => message.role === "assistant").map((message: any) => ({ hasReasoningContent: Object.hasOwn(message, "reasoning_content"), toolCalls: message.tool_calls?.length ?? 0 })) });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (request.headers.authorization) headers.authorization = request.headers.authorization;
      const reply = await fetch(new URL("chat/completions", target), { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal });
      status = reply.status;
      response.writeHead(status, { "content-type": reply.headers.get("content-type") ?? "application/json" });
      const decoder = new TextDecoder(); let pending = "";
      const parse = (line: string) => {
        if (!line.startsWith("data:")) return;
        try { const value = JSON.parse(line.slice(5).trim()); if (value.usage) usage = normalizeUsage(value.usage); } catch {}
      };
      if (body.stream && reply.ok && reply.body) {
        for await (const chunk of reply.body as any) {
          if (!response.write(chunk)) await new Promise<void>((resolve, reject) => {
            const close = () => { cleanup(); reject(new Error("Client disconnected")); };
            const drain = () => { cleanup(); resolve(); };
            const cleanup = () => { response.off("drain", drain); response.off("close", close); };
            response.once("drain", drain); response.once("close", close);
          });
          pending += decoder.decode(chunk, { stream: true });
          let index: number; while ((index = pending.indexOf("\n")) >= 0) { parse(pending.slice(0, index)); pending = pending.slice(index + 1); }
          if (pending.length > 2_000_000) throw new Error("Oversized gateway SSE event");
        }
        pending += decoder.decode(); if (pending) parse(pending);
      } else {
        const text = await reply.text(); try { usage = normalizeUsage(JSON.parse(text).usage); } catch {}
        response.write(text);
      }
      response.end();
    } catch (error) {
      log.emit("error", "gateway", { ...owner, requestId, sessionId, message: String(error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local metering transport failed; inspect Torine diagnostics" } }));
    } finally {
      clearTimeout(timeout); aborts.delete(abort); response.off("close", disconnected);
      if (observed) log.ingest({ type: "gateway.usage", ...owner, requestId, sessionId, model: modelName, status, durationMs: Date.now() - started, usage });
    }
  };
  const server = http.createServer((request, response) => {
    const pending = handle(request, response); active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  let closing: Promise<void> | undefined;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => closing ??= (async () => {
    for (const abort of aborts) abort.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...active]);
  })() };
}
