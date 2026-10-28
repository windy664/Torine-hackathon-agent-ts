import fs from "node:fs";
import type { Json } from "./events.js";

export type Prices = { source: string; checkedAt: string; unit: string; models: Record<string, { input: number; cacheHit: number; output: number }> };
export function loadPrices(file = new URL("./pricing.json", import.meta.url)): Prices {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.unit !== "CNY / 1M tokens" || !value.source || !Number.isFinite(Date.parse(value.checkedAt))) throw new Error("Invalid price provenance/unit");
  for (const price of Object.values(value.models) as any[]) {
    if (![price.input, price.cacheHit, price.output].every(x => Number.isFinite(x) && x >= 0) || price.cacheHit > price.input) throw new Error("Invalid model price");
  }
  return value;
}
export function estimate(requests: Json[], prices: Prices, now = Date.now()) {
  let lower = 0, upper = 0, missing = 0, pending = 0, unpriced = 0, unknownCache = 0;
  const stale = now - Date.parse(prices.checkedAt) > 7 * 86400_000 || Date.parse(prices.checkedAt) > now + 60_000;
  for (const request of requests) {
    if (request.pending) { pending++; continue; }
    const usage = request.usage;
    if (!usage) { missing++; continue; }
    const price = prices.models[String(request.model ?? "").replace(/^[^/]+\//, "")];
    if (!price || stale) { unpriced++; continue; }
    // prompt_tokens already includes cache hits; completion_tokens already
    // includes reasoning. Never add these overlapping fields twice.
    const input = usage.input, output = usage.output;
    const cached = usage.cacheRead ?? (Number.isFinite(usage.cacheMiss) ? input - usage.cacheMiss : undefined);
    if (cached !== undefined && (!Number.isFinite(cached) || cached < 0 || cached > input)) { missing++; continue; }
    const base = output * price.output;
    if (cached === undefined) {
      unknownCache++; lower += (input * price.cacheHit + base) / 1e6; upper += (input * price.input + base) / 1e6;
    } else {
      const cost = ((input - cached) * price.input + cached * price.cacheHit + base) / 1e6;
      lower += cost; upper += cost;
    }
  }
  const complete = pending + missing + unpriced + unknownCache === 0;
  return { estimatedCny: complete ? lower : null, lowerBoundCny: lower, upperBoundCny: pending + missing + unpriced ? null : upper,
    billedCny: null, complete, pendingRequests: pending, missingUsageRequests: missing, unpricedRequests: unpriced, unknownCacheRequests: unknownCache,
    priceSource: prices.source, priceCheckedAt: prices.checkedAt, stalePrices: stale,
    caveat: "Estimate of observed gateway usage only, not platform settlement; incomplete/missing requests may still be charged." };
}
