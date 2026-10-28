// Shared by implementation/repair turns for one public requirement. Session
// reset, source edits and app restart must not replenish development checks.
export class SelfTestBudget {
  private checks = 0;
  private failures = 0;
  private spentMs = 0;
  private activeSince: number | null = null;
  readonly maxChecks: number;
  readonly maxFailures: number;
  readonly maxMs: number;
  constructor(options: { maxChecks?: number; maxFailures?: number; maxMs?: number } = {}) {
    this.maxChecks = options.maxChecks ?? 6;
    this.maxFailures = options.maxFailures ?? 2;
    this.maxMs = options.maxMs ?? 180_000;
    for (const [name, value] of Object.entries({ maxChecks: this.maxChecks, maxFailures: this.maxFailures, maxMs: this.maxMs })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    }
  }
  snapshot() {
    const elapsedMs = this.spentMs + (this.activeSince === null ? 0 : Date.now() - this.activeSince);
    const reason = this.failures >= this.maxFailures ? "failure-limit" : this.checks >= this.maxChecks ? "check-limit" : elapsedMs >= this.maxMs ? "time-limit" : null;
    return { checksStarted: this.checks, failures: this.failures, elapsedMs, remainingMs: Math.max(0, this.maxMs - elapsedMs),
      checksRemaining: Math.max(0, this.maxChecks - this.checks), maxFailures: this.maxFailures, maxMs: this.maxMs, exhausted: reason !== null, reason };
  }
  begin(action: "start" | "check") {
    if (this.activeSince !== null) throw new Error("Concurrent use of one requirement's development budget is not supported");
    const state = this.snapshot();
    if (state.exhausted) throw new Error(`Development check budget exhausted (${state.reason}). Stop retrying, report unresolved results and return. Independent verification has a separate budget.`);
    if (action === "check") this.checks++;
    this.activeSince = Date.now();
    return state.remainingMs;
  }
  finish(failed: boolean) {
    if (this.activeSince === null) throw new Error("Development budget was not started");
    this.spentMs += Date.now() - this.activeSince;
    this.activeSince = null;
    if (failed) this.failures++;
    return this.snapshot();
  }
}
