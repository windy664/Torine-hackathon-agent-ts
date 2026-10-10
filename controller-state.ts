import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const IGNORED = new Set([".git", ".arc", "node_modules", "dist", "coverage", "test-results", "playwright-report"]);

export function applicationFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Mutable application symlink unsupported: ${path.relative(root, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  };
  walk(root);
  return files;
}

export function applicationDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of applicationFiles(root)) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
}

export class Checkpoint {
  readonly directory: string;
  readonly digest: string;
  private readonly files: string[];
  private readonly artifacts: string[] = [];
  constructor(private readonly root: string, privateRoot: string) {
    this.directory = path.join(privateRoot, `checkpoint-${randomUUID()}`);
    this.files = applicationFiles(root);
    this.digest = applicationDigest(root);
    for (const file of this.files) {
      const out = path.join(this.directory, file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(path.join(root, file), out);
      fs.chmodSync(out, fs.statSync(path.join(root, file)).mode);
    }
    for (const relative of ["frontend/dist", "backend/dist"]) {
      if (!fs.existsSync(path.join(root, relative))) continue;
      fs.cpSync(path.join(root, relative), path.join(this.directory, relative), { recursive: true });
      this.artifacts.push(relative);
    }
  }
  restore(): void {
    // Remove rejected new files too. Dependencies, evidence and Git history stay
    // outside the rollback; source, tests, configuration and local DBs are restored.
    const dependencyChanged = ["frontend", "backend"].filter((target) => ["package.json", "package-lock.json", ".npmrc"].some((name) => {
      const text = (root: string): string => { try { return fs.readFileSync(path.join(root, target, name), "utf8"); } catch { return ""; } };
      return text(this.root) !== text(this.directory);
    }));
    const removeFiles = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) removeFiles(full);
        else fs.rmSync(full, { force: true }); // rejected new symlinks are unlinked, never traversed
      }
    };
    removeFiles(this.root);
    for (const file of this.files) {
      const out = path.join(this.root, file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(path.join(this.directory, file), out);
      fs.chmodSync(out, fs.statSync(path.join(this.directory, file)).mode);
    }
    for (const relative of ["frontend/dist", "backend/dist"]) {
      fs.rmSync(path.join(this.root, relative), { recursive: true, force: true });
      if (this.artifacts.includes(relative)) fs.cpSync(path.join(this.directory, relative), path.join(this.root, relative), { recursive: true });
    }
    // Dependency directories are disposable artifacts. If a repair changed the
    // dependency contract, force installation against the restored lockfile.
    for (const target of dependencyChanged) fs.rmSync(path.join(this.root, target, "node_modules"), { recursive: true, force: true });
    if (applicationDigest(this.root) !== this.digest) throw new Error("Checkpoint restore did not reproduce application inputs");
  }
  dispose(): void { fs.rmSync(this.directory, { recursive: true, force: true }); }
}

export type ControllerPhase = "implementation" | "boundary" | "delivery";
export class ControllerBudget {
  private turns = 0;
  private plans = 0;
  constructor(readonly totalMs = 60 * 60_000, readonly maxTurns = 20, readonly maxPlans = 6,
    private readonly now = Date.now, readonly startedAt = now()) {
    if (![totalMs, maxTurns, maxPlans].every(Number.isFinite) || !Number.isInteger(maxTurns) || !Number.isInteger(maxPlans) || totalMs < 1000 || maxTurns < 2 || maxPlans < 0) throw new Error("Invalid controller budget");
  }
  remaining(phase: ControllerPhase): number {
    // Implementation owns most of the wall clock: the delta work is the actual
    // product; audits and final delivery verify but should not starve it
    // (run 1cabd30e4df7: 0.6 fraction left one module turn before exhaustion).
    const fraction = { implementation: 0.8, boundary: 0.9, delivery: 1 }[phase];
    return Math.max(0, this.startedAt + this.totalMs * fraction - this.now());
  }
  takeTurn(phase: ControllerPhase): boolean {
    const ceiling = phase === "delivery" ? this.maxTurns : this.maxTurns - 2;
    if (this.remaining(phase) < 1000 || this.turns >= ceiling) return false;
    this.turns++; return true;
  }
  takePlan(phase: ControllerPhase): boolean {
    // Reserve up to 2 planner calls for the delivery (Judge) phase, mirroring
    // takeTurn's reservation: otherwise boundary-phase self-verification can
    // consume the whole planner pool and the final Judge cannot generate
    // probes or drive repairs (run 16dcb2bf4d57: plannerCalls 6/6, 0 repairs).
    // Tiny budgets (maxPlans <= 1) keep the original shared-pool behaviour.
    const reserved = Math.min(2, Math.max(0, this.maxPlans - 1));
    const ceiling = phase === "delivery" ? this.maxPlans : this.maxPlans - reserved;
    if (this.remaining(phase) < 1000 || this.plans >= ceiling) return false;
    this.plans++; return true;
  }
  snapshot(): Record<string, number> { return { totalMs: this.totalMs, engineTurns: this.turns, plannerCalls: this.plans, remainingMs: this.remaining("delivery") }; }
}

export function repairImproves(before: { caseId: string; status: string }[], after: { caseId: string; status: string }[], infrastructureError?: string): boolean {
  if (infrastructureError) return false;
  const next = new Map(after.map((r) => [r.caseId, r.status]));
  return before.filter((r) => r.status === "passed").every((r) => next.get(r.caseId) === "passed")
    && before.some((r) => r.status === "failed" && next.get(r.caseId) === "passed");
}
