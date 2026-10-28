import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentRuntime } from "arcbench-agent-runtime-js";
import { EventLog, safeText, type Json } from "./events.js";
import { Engine } from "./engine.js";
import { startGateway } from "./gateway.js";
import { command } from "./process.js";
import { buildApp, prepareBrowser, runCases, publicText, checksSatisfied, type Plan, type CheckResult } from "./checks.js";
import { planPublicChecks, sourceSnapshot } from "./planner.js";

type Module = { nodeId: string; name: string; rootContext: string; moduleContext: string; subtree: Json };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}
function files(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (["node_modules", ".git", ".arc", "dist", "test-results", "playwright-report"].includes(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...files(root, relative)); else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
function manifest(workspace: string) { return Object.fromEntries(files(workspace).map(file => [file, sha(fs.readFileSync(path.join(workspace, file)))])); }
function projectMap(workspace: string) {
  const selected = files(workspace).filter(file => !/\.(db|sqlite|png|jpe?g|svg|lock)$/.test(file) && !file.includes("test"));
  return `Project file map (created once; inspect only relevant paths as needed):\n${selected.slice(0, 220).join("\n")}\n` + ["backend/package.json", "frontend/package.json", "Dockerfile"].map(file => fs.existsSync(path.join(workspace, file)) ? `\n${file}:\n${fs.readFileSync(path.join(workspace, file), "utf8").slice(0, 4000)}` : "").join("");
}
export function preservationFailures(workspace: string, original: Record<string, string>): string[] {
  const failures: string[] = [];
  for (const file of ["frontend/package.json", "backend/package.json", "Dockerfile"]) if (original[file] && !fs.existsSync(path.join(workspace, file))) failures.push(`Baseline entrypoint deleted: ${file}`);
  const removed = Object.keys(original).filter(file => !fs.existsSync(path.join(workspace, file)));
  if (removed.length > Math.max(3, Object.keys(original).length * 0.2)) failures.push(`Broad baseline deletion (${removed.length} files): ${removed.slice(0, 15).join(", ")}`);
  for (const [file, hash] of Object.entries(original)) if (/\.(db|sqlite)$/.test(file) && (!fs.existsSync(path.join(workspace, file)) || sha(fs.readFileSync(path.join(workspace, file))) !== hash)) failures.push(`Persisted baseline database was changed/deleted directly: ${file}. Put repeatable migrations in source, not edited DB binaries.`);
  return failures;
}
const guardrails = `This is incremental web application development on the platform-injected baseline. Preserve working original features, routes, permissions, seed records and persisted data. Do not copy a starter, reset Git, clear or replace the output project, or directly edit/delete existing database binaries. Repeatable compatible migrations belong in source. Only GIVEN pre-existing records are seed preconditions: do NOT pre-create a WHEN action's intended target or extra blockers.
Use ONLY supplied public requirements and this application source. Never discover/read platform or hidden tests, grader, evaluation internals, browser cookies, credentials, or ARCBENCH_TESTS_DIR. Do not browse competitors. Original requirements remain valid except where Modified Feature Description/Evolution scenarios explicitly change them.
Read relevant code before a focused edit; use the project map and prior handoff rather than surveying the whole repository again. Implement actual UI/API/storage behavior with the exact specified accessible names and messages; a disabled button or source string alone proves nothing. Do not remove/refactor unrelated features.
For development checks use torine_app (start/status/stop) and torine_check. The parent controller creates an isolated source/data copy, picks a free non-evaluation port, sanitizes credentials and cleans owned processes. First implement the PUBLIC feature and build the changed frontend in the OUTPUT project using a finite Bash command; then torine_app start with '/' or a real existing health route. torine_check runs the copy and sets BASE_URL; always read that env variable rather than hardcode a port. Write/edit test scripts in the OUTPUT project. Source/build/script edits trigger an automatic fresh snapshot and service restart before checking. Every restart restores baseline data; unchanged-source checks share private state, so stop/start to reset test-created records. Never edit/delete delivery databases or temporary-copy databases. Prefer 1-3 focused checks. Implementation and packet repair share at most 6 checks, 180 seconds of cumulative active startup/check time, and 2 total failures per requirement. App restart, source edits and session reset do not replenish this budget. Exhaustion interrupts this implementation turn; do not retry through Bash or spend the whole turn repairing your test harness. If a check fails, make at most one focused correction and report remaining failures. Return partial work rather than chasing a perfect self-test. Never launch servers/background jobs using Bash, nohup, setsid, disown or '&', and never bind the evaluation port. Ordinary Bash defaults to 60s and is capped at 120s; development checks are capped at 120s, startup 30s, service lease 180s. Do not install/modify node_modules from torine_check. Search relevant source directories, excluding node_modules, dist, databases and generated/minified files.
The controller runs frozen independent browser checks on disposable copies. You cannot change their expectations. Fix the product, not tests. Return a short summary: changed paths, observed checks, and unresolved issues. Do not claim full acceptance from a successful build.`;

export async function runEvolution(runtime: AgentRuntime, modules: Module[], workspace: string, root: string, webPort: number) {
  const key = process.env.OPENAI_API_KEY ?? "";
  const upstream = process.env.OPENAI_BASE_URL;
  if (!upstream || !key) throw new Error("Evolution requires OPENAI_BASE_URL and OPENAI_API_KEY; refusing an unconfigured paid fallback");
  const model = process.env.MODEL;
  if (!model) throw new Error("MODEL must identify the platform model");
  const started = Date.now(), total = positive("TORINE_EVOLUTION_TOTAL_MS", 7 * 60 * 60_000);
  const finalReserve = Math.min(positive("TORINE_FINAL_RESERVE_MS", 30 * 60_000), total / 4);
  const deadline = started + total, workDeadline = deadline - finalReserve;
  const maxTurn = positive("TORINE_EVOLUTION_NODE_TIMEOUT_MS", 15 * 60_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = new EventLog(path.join(workspace, ".arc/torine", stamp), [key]);
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "torine-engine-"));
  let owner: Json = { phase: "setup" };
  const deepseek = /^deepseek-/.test(model.replace(/^[^/]+\//, ""));
  const controls: { thinking?: "enabled" | "disabled"; effort?: "low" | "high" | "max" } = deepseek ? { thinking: "enabled", effort: "high" } : {};
  if (process.env.TORINE_THINKING) {
    if (!["enabled", "disabled"].includes(process.env.TORINE_THINKING)) throw new Error("Invalid TORINE_THINKING");
    controls.thinking = process.env.TORINE_THINKING as "enabled" | "disabled";
  }
  if (process.env.TORINE_REASONING_EFFORT) {
    if (!["low", "high", "max"].includes(process.env.TORINE_REASONING_EFFORT)) throw new Error("Invalid TORINE_REASONING_EFFORT");
    controls.effort = process.env.TORINE_REASONING_EFFORT as "low" | "high" | "max";
  }
  const original = manifest(workspace), map = projectMap(workspace);
  if (controls.thinking === "disabled") delete controls.effort;
  const maxEstimatedCny = process.env.TORINE_MAX_ESTIMATED_CNY ? positive("TORINE_MAX_ESTIMATED_CNY", 20) : null;
  const maxRequests = positive("TORINE_MAX_MODEL_REQUESTS", 600);
  const metadata = { version: "opencode-evolution-observed-v6", started: new Date(started).toISOString(), model, controls: Object.keys(controls).length ? controls : "inherit-platform-default-unverified", controlsVerified: "outbound protocol only; route acceptance and semantic effort require real gateway evidence", planningControls: "tool-free; DeepSeek thinking disabled; bounded failures degrade local verification, not implementation", node: process.version, totalBudgetMs: total, finalReserveMs: finalReserve, maxEstimatedCny,
    sessionPolicy: "serial single writer; same-module session continuation; task dispatch disabled",
    selfTestPolicy: { maxChecks: 6, maxFailures: 2, maxActiveMs: 180_000, scope: "requirement across implementation/packet repair; final delivery repair has a separate bounded budget", action: "interrupt implementation turn, retain partial evidence" },
    baselineFiles: original, agentEntrySha256: sha(fs.readFileSync(path.join(root, "index.ts"))), dependencyLockSha256: sha(fs.readFileSync(path.join(root, "package-lock.json"))) };
  fs.writeFileSync(path.join(log.root, "manifest.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  const proxy = await startGateway(upstream, log, () => owner, controls, { maxEstimatedCny, maxRequests });
  const engine = new Engine({ root, workspace, privateDir, baseURL: proxy.baseURL, model, log, reservedPort: webPort });
  const accepted: Plan["cases"] = [], planned: Plan["cases"] = [], outcomes: Json[] = [], handoffs: string[] = [];
  let blocked: string | null = null;
  let workStopReason: string | null = null;
  let browserFailure: CheckResult | null = null;
  const phase = (context: Json) => { owner = context; log.phaseStart(context); };
  const frozenPlans: Json[] = [];
  const packets = modules.flatMap(module => {
    const children = Array.isArray(module.subtree.children) ? module.subtree.children.filter((item: any) => item && typeof item === "object") : [];
    return (children.length > 1 ? children : [module.subtree]).map((subtree: Json, index: number) => ({ module, subtree, label: String(subtree.id || `${module.nodeId}-${index + 1}`) }));
  });
  const probe = async (checkDeadline = deadline): Promise<CheckResult> => {
    const result = await command(process.execPath, [path.join(root, "evolution/db-probe.cjs"), workspace], { cwd: workspace, timeoutMs: Math.min(8000, checkDeadline - Date.now()), log, context: { phase: "transaction-probe" } });
    try { const record = JSON.parse(result.output.trim().split("\n").at(-1)!); return { id: "transaction-helper", ...record }; }
    catch { return { id: "transaction-helper", state: "infrastructure_failed", detail: result.output.slice(-2000) }; }
  };
  const verify = async (plan: Plan, checkDeadline = deadline): Promise<CheckResult[]> => {
    const preservation = preservationFailures(workspace, original);
    if (preservation.length) return [{ id: "baseline-preservation", state: "product_failed", detail: preservation.join("\n") }];
    const build = await buildApp(workspace, log, checkDeadline);
    if (build.state !== "passed") return [build];
    const transaction = await probe(checkDeadline);
    const executable = plan.cases.length ? plan : { cases: [{ id: "delivery-startup", kind: "regression" as const, sourceQuote: "Controller HTTP startup only; not public behavior acceptance", steps: [{ action: "goto", path: "/" }] }] };
    const checks = browserFailure ? [{ ...browserFailure }] : await runCases(workspace, executable, log, checkDeadline, webPort);
    for (const check of checks) if (check.id === "delivery-startup" && check.state === "passed") check.detail = "HTTP/SPA startup only; no public behavior assertions executed";
    if (!plan.cases.length) checks.push({ id: "public-behavior", state: "unchecked", detail: "No validated public-derived behavior plan" });
    return [build, transaction, ...checks];
  };
  try {
    phase({ phase: "setup" });
    const version = await command(path.join(root, "node_modules/.bin/opencode"), ["--version"], { cwd: root, timeoutMs: 10_000, log });
    log.emit("orchestration", "start", { version: version.output.trim(), packets: packets.length, model, deadline: new Date(deadline).toISOString() });
    log.emit("orchestration", "model_controls", { implementation: controls, planning: deepseek ? { thinking: "disabled", tools: 0 } : { thinking: "provider-default-unverified", tools: 0 }, verified: "Configured fields, not proof of upstream semantic reasoning effort", maxEstimatedCny });
    if (version.code !== 0 || version.output.trim() !== "1.18.34") throw new Error("Unverified OpenCode version; expected 1.18.34");
    const browserRuntime = await prepareBrowser(log, workDeadline);
    log.emit("check", "browser_runtime", browserRuntime);
    if (browserRuntime.state !== "passed") {
      browserFailure = browserRuntime;
      log.emit("check", "verification_degraded", { level: "WARN", detail: browserRuntime.detail, action: "Continue implementation; browser acceptance remains unavailable, never passed" });
    }
    // Surface the same public infrastructure failure before asking for changes.
    const baselineBuild = await buildApp(workspace, log, workDeadline);
    const baselineProbe = baselineBuild.state === "passed" ? await probe() : baselineBuild;
    let infrastructureFinding = baselineProbe;
    log.emit("check", "baseline", baselineProbe);
    log.phaseEnd("completed");
    for (let index = 0; index < packets.length; index++) {
      const { module, subtree, label } = packets[index];
      if (log.summary().gateway.requests >= maxRequests) { workStopReason = "Configured model request limit reached"; break; }
      if (maxEstimatedCny !== null && log.summary().billing.lowerBoundCny >= maxEstimatedCny) { workStopReason = "Configured estimated cost limit reached (missing requests may cost more)"; break; }
      if (workDeadline - Date.now() < 60_000) { outcomes.push({ label, state: "unchecked", detail: "Work budget exhausted" }); continue; }
      const packetDeadline = Math.min(workDeadline, Date.now() + Math.max(90_000, (workDeadline - Date.now()) / (packets.length - index)));
      const beforePacket = manifest(workspace);
      phase({ module: module.nodeId, requirement: label, phase: "check-planning" });
      runtime.events.markImplementationStarted(label, "Incremental implementation and independent local checks");
      const source = `${module.rootContext}\n${module.moduleContext}\n${publicText(subtree)}`;
      const requirement = `Product context: ${module.rootContext}\nModule context: ${module.moduleContext}\nCurrent public requirement subtree:\n${JSON.stringify(subtree, null, 2)}`;
      const continuity = handoffs.slice(-4).join("\n\n").slice(-8000);
      const snapshot = sourceSnapshot(workspace, `${module.name}\n${publicText(subtree)}`);
      log.emit("check", "planning_context", { paths: snapshot.paths, chars: snapshot.text.length, tools: 0 });
      let plan: Plan = { cases: [] };
      let planningFailure: string | null = null;
      try {
        plan = await planPublicChecks({ baseURL: proxy.baseURL, key, model, requirement, source, snapshot: snapshot.text,
          deadline: Math.min(Date.now() + 120_000, packetDeadline - 30_000), log, context: owner });
        log.phaseEnd("completed");
      } catch (error) {
        planningFailure = String(error); log.phaseEnd("degraded");
        log.emit("check", "planning_degraded", { level: "WARN", detail: planningFailure, action: "Implement public requirements with bounded self-tests; independent behavior remains unchecked. Continue later packets." });
      }
      plan.cases.forEach(check => check.id = `${index}-${check.id}`);
      planned.push(...plan.cases);
      // Immutable in-memory copy is authoritative even if a model tampers with disk.
      const frozen = JSON.stringify(plan), frozenSha = sha(frozen);
      frozenPlans.push({ requirement: label, sha256: frozenSha, plan });
      fs.writeFileSync(path.join(log.root, "plans.json"), safeText(JSON.stringify(frozenPlans, null, 2), [key]) + "\n", { mode: 0o600 });
      const planFile = path.join(privateDir, `plan-${index}.json`); fs.writeFileSync(planFile, frozen, { mode: 0o400 });
      log.emit("check", "plan_frozen", { ...owner, sha256: frozenSha, cases: plan.cases.map(check => ({ id: check.id, kind: check.kind, sourceQuote: check.sourceQuote })) });
      phase({ module: module.nodeId, requirement: label, phase: "implementation" });
      const context = engine.session(module.nodeId) ? "Continue the same module session; use its existing project map and prior edits. Inspect only this slice and relevant diffs." : `${map}\nRecent controller/model handoff (model claims are not proof):\n${continuity || "No prior packets"}`;
      const prefix = `${guardrails}\nEvaluation port ${webPort} is reserved; never bind it.\n${context}\n${requirement}`;
      const verificationContext = planningFailure ? `Independent plan unavailable: ${planningFailure}. This is a verifier limitation, not a reason to skip implementation. Implement the supplied public requirement and use bounded torine_app/torine_check self-tests. Report their commands/results and unresolved behavior honestly; your tests do not grant independent acceptance.` : `Frozen independent local plan: ${frozen}`;
      const implement = await engine.turn(module.nodeId, `${prefix}\nLatest controller infrastructure finding (limited scope): ${JSON.stringify(infrastructureFinding)}\n${verificationContext}\nImplement this slice now. Use GIVEN records as setup only; never pre-create WHEN targets. If the helper concurrency failure affects the changed storage path, fix connection serialization without introducing nested deadlocks or interleaving unrelated queries into transactions.`, Math.min(maxTurn, Math.max(1, (packetDeadline - Date.now()) * 0.7)), owner);
      log.phaseEnd(implement.code === 0 ? "completed" : "failed");
      if (implement.code !== 0) {
        engine.resetSession(module.nodeId);
        log.emit("orchestration", "implementation_partial", { level: "WARN", code: implement.code, signal: implement.signal, timedOut: implement.timedOut, aborted: implement.aborted, stopReason: implement.stopReason, action: "Retain partial files, verify delivery safety, continue next packet with a fresh session" });
      }
      phase({ module: module.nodeId, requirement: label, phase: "verification" });
      let state = await verify({ cases: [...plan.cases, ...accepted.slice(-4)] }, packetDeadline);
      const recordPlanningGap = () => {
        if (planningFailure && !state.some(check => check.id === `${index}-public-behavior`)) state.push({ id: `${index}-public-behavior`, state: "unchecked", detail: `Independent plan unavailable for ${label}: ${planningFailure}; build/startup/other packets cannot establish this behavior` });
      };
      recordPlanningGap();
      log.phaseEnd(checksSatisfied(state) ? "completed" : "failed");
      let repairInterrupted: Json | null = null;
      for (let repair = 1; repair <= 1 && implement.code === 0 && !state.some(check => check.id === "baseline-preservation") && state.some(check => check.state === "product_failed") && packetDeadline - Date.now() > 30_000; repair++) {
        if (maxEstimatedCny !== null && log.summary().billing.lowerBoundCny >= maxEstimatedCny) { workStopReason = "Configured estimated cost limit reached during repair"; break; }
        phase({ module: module.nodeId, requirement: label, phase: "repair", attempt: repair });
        const repaired = await engine.turn(module.nodeId, `${guardrails}\nFix ONLY these observed failures while preserving the public requirement and previous successful paths. Do not edit checks or directly edit data.\n${JSON.stringify(state.filter(check => check.state !== "passed"), null, 2)}\nFrozen plan: ${frozen}`, Math.min(maxTurn, Math.max(1, (packetDeadline - Date.now()) * 0.7)), owner);
        log.phaseEnd(repaired.code === 0 ? "completed" : "failed");
        if (repaired.code !== 0) { engine.resetSession(module.nodeId); repairInterrupted = { code: repaired.code, signal: repaired.signal, timedOut: repaired.timedOut, aborted: repaired.aborted, stopReason: repaired.stopReason }; }
        phase({ module: module.nodeId, requirement: label, phase: "verification", attempt: repair });
        state = await verify({ cases: [...plan.cases, ...accepted.slice(-4)] }, packetDeadline);
        recordPlanningGap();
        log.phaseEnd(checksSatisfied(state) ? "completed" : "failed");
      }
      if (implement.code !== 0) state.push({ id: "implementation-execution", state: "unchecked", detail: `Implementation did not finish normally: code=${implement.code}, signal=${implement.signal}, timedOut=${implement.timedOut}, aborted=${implement.aborted}, stopReason=${implement.stopReason}` });
      if (repairInterrupted) state.push({ id: "repair-execution", state: "unchecked", detail: `Repair did not finish normally: ${JSON.stringify(repairInterrupted)}` });
      if (!fs.existsSync(planFile) || sha(fs.readFileSync(planFile)) !== frozenSha) state.push({ id: "frozen-plan-integrity", state: "infrastructure_failed", detail: "Frozen check file changed; original in-memory plan was still executed" });
      const locallyChecked = plan.cases.length > 0 && checksSatisfied(state);
      infrastructureFinding = state.find(check => check.id === "transaction-helper") ?? infrastructureFinding;
      for (const check of plan.cases) if (state.some(result => result.id === check.id && result.state === "passed")) accepted.push(check);
      const outcome = { label, implementationExit: implement.code, implementationSignal: implement.signal, implementationTimedOut: implement.timedOut, implementationAborted: implement.aborted, implementationStopReason: implement.stopReason, repairInterrupted, planningStatus: planningFailure ? "unavailable" : "validated", planningFailure, checks: state, planSha256: frozenSha, fullRequirementAcceptance: "unknown" };
      outcomes.push(outcome); log.emit("check", "packet_result", outcome);
      if (implement.code === 0 && locallyChecked) runtime.events.markImplementationDone(label, "Implementation returned; local subset checked, not full acceptance");
      // No test:passed/CONVERGED for a whole requirement from a few smoke checks.
      const changed = manifest(workspace), changedPaths = [...new Set([...Object.keys(changed), ...Object.keys(beforePacket)])].filter(file => beforePacket[file] !== changed[file]);
      handoffs.push(safeText(`Packet ${label}; changed paths this packet: ${changedPaths.slice(0, 30).join(", ")}. Controller results: ${state.map(check => `${check.id}=${check.state}`).join(", ")}. Model summary (unverified): ${implement.text.slice(-1800)}. Unresolved: ${state.filter(check => check.state !== "passed").map(check => `${check.id}: ${check.detail}`).join("; ").slice(-2500)}`, [key]));
      runtime.git.commit(`${label}: incremental checkpoint (local checks recorded)`);
      if (state.some(check => check.id === "baseline-preservation" && check.state !== "passed")) { blocked = `Baseline preservation violated in ${label}`; log.emit("error", "delivery_blocked", { requirement: label, detail: blocked }); break; }
      if (workStopReason) break;
      if (!locallyChecked) log.emit("check", "packet_partial", { level: "WARN", requirement: label, action: "Local verification incomplete/failed; preserve evidence and continue later requirements, not a pass" });
    }
    phase({ phase: "final-regression" });
    let final = await verify({ cases: planned });
    const recordFinalPlanningGaps = () => {
      for (const outcome of outcomes.filter(item => item.planningFailure)) final.push({ id: `unverified-${outcome.label}`, state: "unchecked", detail: `No independent public behavior plan for ${outcome.label}: ${outcome.planningFailure}` });
    };
    recordFinalPlanningGaps();
    log.phaseEnd(checksSatisfied(final) ? "completed" : "failed");
    // One bounded delivery repair, no global rewrite or repeated fresh surveys.
    const spendingAvailable = log.summary().gateway.requests < maxRequests && (maxEstimatedCny === null || log.summary().billing.lowerBoundCny < maxEstimatedCny);
    if (!blocked && !workStopReason && spendingAvailable && final.some(check => check.state === "product_failed") && deadline - Date.now() > 60_000) {
      phase({ phase: "final-repair" });
      const repaired = await engine.turn("final-repair", `${guardrails}\n${map}\n${handoffs.slice(-4).join("\n\n").slice(-8000)}\nRepair only the following concrete final regressions. Keep all completed public evolution behavior.\n${JSON.stringify(final.filter(check => check.state !== "passed"))}`, Math.min(10 * 60_000, (deadline - Date.now()) / 2), owner);
      log.phaseEnd(repaired.code === 0 ? "completed" : "failed");
      phase({ phase: "final-regression", attempt: 1 });
      final = await verify({ cases: planned });
      recordFinalPlanningGaps();
      log.phaseEnd(checksSatisfied(final) ? "completed" : "failed");
    }
    await proxy.close();
    const unstarted = packets.filter(packet => !outcomes.some(outcome => outcome.label === packet.label)).map(packet => packet.label);
    const incomplete = outcomes.filter(outcome => !outcome.checks || !checksSatisfied(outcome.checks)).map(outcome => outcome.label);
    if (final.some(check => check.id === "baseline-preservation" && check.state !== "passed")) blocked ??= "Baseline preservation violated at final delivery";
    const report = { blocked, workStopReason, deliveryStatus: blocked ? "blocked" : "ready_for_platform_evaluation", localStatus: blocked ? "blocked" : workStopReason || unstarted.length || incomplete.length || !checksSatisfied(final) ? "partial" : "subset_checked", incomplete, packets: outcomes, final, usage: log.summary(), fullRequirementAcceptance: "unknown; local subset checks only", finished: new Date().toISOString(), unstarted };
    fs.writeFileSync(path.join(log.root, "validation.json"), safeText(JSON.stringify(report, null, 2), [key]) + "\n", { mode: 0o600 });
    log.emit("orchestration", "complete", { localStatus: report.localStatus, deliveryStatus: report.deliveryStatus, blocked, workStopReason, incomplete, final, unstarted: report.unstarted, usage: log.summary() });
    runtime.git.commit("chore: final local validation checkpoint");
    // Exit success means delivery to the grader, NOT local behavior acceptance.
    // Optional verifier/product failures stay partial; preservation/controller failures stay fatal.
    if (blocked) process.exitCode = 1;
  } catch (error) {
    blocked = String(error); log.phaseEnd("failed");
    await proxy.close();
    const report = { blocked, localStatus: "blocked", packets: outcomes, usage: log.summary(), fullRequirementAcceptance: "unknown; controller failed", finished: new Date().toISOString() };
    fs.writeFileSync(path.join(log.root, "validation.json"), safeText(JSON.stringify(report, null, 2), [key]) + "\n", { mode: 0o600 });
    log.emit("error", "controller_failed", { detail: blocked }); throw error;
  } finally {
    await proxy.close(); log.flushRaw(); log.saveSummary();
    // This is our mkdtemp directory only, never the injected output project.
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}
