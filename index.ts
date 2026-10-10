import { prioritizeEvolution } from "./controller-scheduler.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { runProcess, type CommandOptions, type CommandResult } from "./controller-process.js";
import { Checkpoint, ControllerBudget, applicationDigest, type ControllerPhase } from "./controller-state.js";
import { readEvents, sharedTestBudget, settingsFromEnv } from "./controller-tests.js";

import YAML from "yaml";
import { AgentRuntime } from "arcbench-agent-runtime-js";
import { runJudgePhase, JudgeSession, type JudgeReceipt } from "./judge.js";
import { fatalGatewayError, isEvolutionRequirement } from "./judge-plan.js";

type AgentArgs = {
  requirementPath: string;
  outputDir: string;
  taskType: string;
  webPort: number;
  judgeOnly: boolean;
};

type RunMode = "initial" | "evolution";

type RequirementModule = {
  index: number;
  total: number;
  nodeId: string;
  name: string;
  rootContext: string;
  moduleContext: string;
  subtree: Record<string, unknown>;
};

// Grading-system facts learned across graded runs - these are not generic
// style advice; every rule here cost real score at least once.
const UI_CONTRACT = [
  "Benchmark UI contract (the automated acceptance tests depend on these EXACTLY):",
  '- Use plain text inputs for ALL form fields: `type="text"` (or `password`/`email`). NEVER `type="date"` or `type="number"` - tests fill values like "Sun, May 31" which native date inputs reject.',
  "- Every form field needs a visible associated <label> (tests use getByLabel with the field's name).",
  "- Every form control must be visible and enabled at all times - never hide native inputs/selects behind custom widgets or display:none containers.",
  '- NEVER rely on native HTML5 validation (`required`, `pattern`, tooltips). Validate in JavaScript and render error messages as inline DOM text containing words like "required" / "invalid" / "missing" - tests assert on visible page text.',
  '- Buttons are real <button> elements with plain text labels (e.g. "Sign up", "Sign in", "Create account").',
  "VERBATIM TEXT: copy every visible label / link / button / heading string verbatim from the requirement document into the UI. If the requirement says a button is \"Create account\", the button text is exactly \"Create account\". Tests locate elements by these exact strings, some with ANCHORED regexes like /^name$/i - a field the requirement calls \"Name\" must be labeled exactly \"Name\"; \"Full Name\" or \"Your Name\" never matches.",
  "UNIQUENESS (strict mode): any value the page echoes - usernames, emails, org names, dates - must appear in EXACTLY ONE visible element. Playwright locators like getByText run in strict mode: two matching elements fails the test. Never repeat the same value in a summary line AND a card/detail view on one page.",
  "SEED DATA: when the requirement states concrete published records (e.g. \"user alice-dev with email alice.dev@example.test exists\"), the database seed MUST include exactly those records, with values stored and matched as the verbatim strings shown. Search matching is case-insensitive and trims surrounding whitespace.",
  "OPTION LABELS ARE FIXTURE DATA TOO: every concrete example value in the requirement must appear verbatim as <option>/radio labels - if the sample data has nationality \"Chinese\", the select must include an option labeled exactly \"Chinese\". Missing fixture option labels make select-based tests time out.",
  "SESSIONS: after registration or login, redirect to the home page and show the exact username plus a sign-out control in the account menu; the session must survive page reload (cookie or token persisted in the browser).",
  "ERROR STATES: failed validation stays on the same page, shows the messages required by the current scenario, keeps non-sensitive input, and creates no records. When several fields are invalid, show each required field error together. Avoid duplicating the same message in both a field and a summary.",
  "ONE MATCH PER VALUE FORM: when the same entity has a short and a long written form, a page must render forms so that only ONE element matches - tests use combined regexes and two matching elements is a strict mode violation. Pick one display form per page and use it in exactly one element.",
  "UNLISTED CONTROL VALUES: when the requirement says a value must be \"one of the values offered by the control\" WITHOUT listing them, offer a broad standard set covering all values that scenarios or seed data use. A gender control is exactly two radio inputs labeled \"Male\" and \"Female\". Text fields must accept ISO date strings like \"2035-12-31\".",
  "TEXT ONLY: every string you need exists as plain text in the requirement YAML/files. Reference images (reference/*.png) are layout guides only - NEVER attempt OCR or image text extraction.",
  "WRITE CODE FIRST: start creating project files in your very first actions. A turn that only reads and analyzes without writing files is a failed turn, no matter how good the analysis is.",
].join("\n");

const DELIVERABLE = [
  "Deliverable layout under the output directory:",
  "  frontend/   (Vite + React + TypeScript; npm install && npm run build)",
  "  backend/    (Express + SQLite; npm run start, reads PORT)",
  "Keep both directories at the output root, not nested one level deeper.",
].join("\n");

const NUDGE_PROMPT = [
  "You ended your last turn before creating or editing any files. Stop analyzing.",
  "In your very next actions, CREATE/EDIT the project files with your file-writing tools:",
  "frontend page sources, backend routes/services/database, and the seed data required by the requirement JSON you were given.",
  "Do not describe the plan - write the files now.",
].join("\n");

const REPAIR_PROMPT = (failure: string) =>
  [
    "The app you built just failed a build/startup rehearsal. Fix it now.",
    "Rehearsal failure output (tail):",
    "```",
    failure.slice(-2000),
    "```",
    "Fix the underlying issue in the code (do not delete features or tests to silence errors).",
    "Keep the architecture: frontend/ builds with `npm run build`, backend/ starts with `npm run start` reading PORT.",
    "Finish with a one-line summary of what you fixed.",
  ].join("\n");

const EVOLUTION_GATE_REPAIR_PROMPT = (failure: string) =>
  [
    "The incremental change damaged the existing application. Repair only the reported failure and preserve all previous behavior.",
    "Do not recreate the project, clear data, or read platform/hidden tests.",
    "Failure:",
    "```",
    failure.slice(-3000),
    "```",
    "Restore missing baseline files when listed, then make the frontend build pass. Keep all completed evolution changes that still work.",
  ].join("\n");

const FINAL_CHECK_PROMPT = (webPort: number, mode: RunMode, requirementsDir: string) =>
  [
    mode === "evolution"
      ? "Check the existing application after the requested incremental changes. Preserve its previous behavior, routes, data, and UI while fixing only concrete regressions or build/startup failures."
      : "Do a final end-to-end audit of the web application in the current directory. Fix what is broken.",
    ...(mode === "evolution"
      ? [`Read only the supplied requirement document at ${path.join(requirementsDir, "requirements.yaml")} for the behaviors affected by this evolution. Never read platform or hidden tests.`]
      : []),
    "1. Run `npm run build` in frontend/ and fix any build errors.",
    `2. Start the backend ONLY on port 3100 (PORT=3100 npm run start) to probe endpoints, NEVER on ${webPort} - the runner watches ${webPort} and kills the run if a server binds it. Stop the server when done.`,
    mode === "evolution"
      ? "3. Exercise the changed behavior and one affected existing flow, including a success and a refusal/error case drawn from the supplied scenarios. Verify the specified reason, data state, and reload persistence; do not merely check that a button is disabled."
      : "3. Exercise representative requirement scenarios end to end, including success and refusal/error paths for each affected area. Check specified seed preconditions and visible outcomes; a build or disabled control alone is not proof.",
    mode === "evolution"
      ? "4. Check only forms touched by this evolution against their current requirement text; preserve intentional behavior in other forms."
      : "4. Audit every form against the UI contract below and fix violations (these silently score 0):",
    "",
    ...(mode === "initial" ? [UI_CONTRACT] : []),
    "",
    "5. Check accessible names and visible messages against the current requirements. When a scenario requires several field errors at once, verify they appear together without duplicate copies.",
    mode === "evolution"
      ? "6. Fix only demonstrated regressions or delivery failures. Stop every server you started when finished."
      : "6. Fix anything else broken. Stop every server you started when finished.",
  ].join("\n");

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  console.error(line);
}

function parseArgs(argv: string[]): AgentArgs {
  const args: AgentArgs = {
    requirementPath: process.env.ARCBENCH_TASK_DIR || "requirements",
    outputDir: process.env.ARCBENCH_OUTPUT_DIR || ".",
    taskType: process.env.ARCBENCH_TASK_TYPE || "web",
    webPort: Number(process.env.ARCBENCH_WEB_PORT || "3000"),
    judgeOnly: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--judge-only") {
      args.judgeOnly = true;
    } else if (value === "--output-dir") {
      args.outputDir = argv[++index] || args.outputDir;
    } else if (value === "--type") {
      args.taskType = argv[++index] || args.taskType;
    } else if (value === "--web-port") {
      args.webPort = Number(argv[++index] || args.webPort);
    } else {
      positional.push(value);
    }
  }
  if (positional[0]) args.requirementPath = positional[0];
  return args;
}

function copyTemplateContentsToOutput(templateDir: string, outputDir: string): void {
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    throw new Error(`Starter template directory not found: ${templateDir}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(templateDir, { withFileTypes: true })) {
    if (entry.name === "template.yaml") continue;
    const source = path.join(templateDir, entry.name);
    const destination = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(source, destination, { recursive: true, force: true });
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

function hasDeliverable(outputDir: string): boolean {
  return (
    fs.existsSync(path.join(outputDir, "frontend", "package.json")) &&
    fs.existsSync(path.join(outputDir, "backend", "package.json"))
  );
}

function detectRunMode(requirementsDir: string): RunMode {
  const requirementsPath = path.join(requirementsDir, "requirements.yaml");
  if (!fs.existsSync(requirementsPath)) throw new Error(`requirements.yaml not found: ${requirementsPath}`);
  const root = YAML.parse(fs.readFileSync(requirementsPath, "utf-8"));
  return isEvolutionRequirement(root, requirementsDir) ? "evolution" : "initial";
}

function loadRootModules(requirementsDir: string): RequirementModule[] {
  const requirementsPath = path.join(requirementsDir, "requirements.yaml");
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements.yaml not found: ${requirementsPath}`);
  }
  const payload = YAML.parse(fs.readFileSync(requirementsPath, "utf-8"));
  if (!payload || String(payload.id || "").trim() !== "ROOT") {
    throw new Error("requirements.yaml must contain a ROOT mapping");
  }
  const children = Array.isArray(payload.children) ? payload.children.filter((item: unknown) => item && typeof item === "object") : [];
  if (children.length === 0) throw new Error("ROOT must contain at least one child module");
  return children.map((subtree: Record<string, unknown>, index: number) => {
    const nodeId = String(subtree.id || subtree.req_id || "").trim();
    if (!nodeId) throw new Error(`ROOT child ${index + 1} has no id`);
    return {
      index: index + 1,
      total: children.length,
      nodeId,
      name: String(subtree.name || nodeId).trim(),
      rootContext: String(payload.description || "").trim(),
      moduleContext: String(subtree.description || "").trim(),
      subtree,
    };
  });
}

function modelSpec(): { providerId: string; modelId: string } {
  const raw = (process.env.MODEL || "").trim();
  if (!raw) return { providerId: "custom", modelId: "gpt-4o-mini" };
  const slash = raw.indexOf("/");
  if (slash > 0) return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
  return { providerId: "custom", modelId: raw };
}

type ControllerContext = {
  budget: ControllerBudget; phase: ControllerPhase; privateDir: string; diagnostics: Set<string>;
  session: JudgeSession; lastFailure: string; testScope?: string[];
  invalidate: () => void;
  latestReceipt?: JudgeReceipt;
};
let controller: ControllerContext | undefined;

function writeOpencodeConfig(agentRoot: string): string {
  const baseUrl = (process.env.OPENAI_BASE_URL || "").trim();
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const { providerId, modelId } = modelSpec();
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ARC-Bench model gateway",
        options: {
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
        models: { [modelId]: { name: modelId } },
      },
    },
    skills: [path.join(agentRoot, "skills")],
    agent: { title: { disable: true } },
    ...(controller ? { plugin: [pathToFileURL(path.join(agentRoot, "controller-plugin.ts")).href] } : {}),
  };
  const configPath = path.join(os.tmpdir(), `torine-opencode-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function resolveOpencodeBin(agentRoot: string): string {
  const direct = path.join(agentRoot, "node_modules", ".bin", "opencode");
  if (fs.existsSync(direct)) return direct;
  const pkgDir = path.join(agentRoot, "node_modules", "opencode-ai");
  const postinstall = path.join(pkgDir, "postinstall.mjs");
  if (fs.existsSync(postinstall)) {
    log("[setup] opencode binary missing; running postinstall fallback");
    const result = spawn(process.execPath, [postinstall], { cwd: pkgDir, stdio: "inherit" });
    void result;
  }
  return direct;
}

async function runCommand(command: string, argv: string[], options: CommandOptions): Promise<CommandResult> {
  const engine = path.basename(command).startsWith("opencode");
  const context = controller;
  let turnId: string | undefined;
  let ledgerFile: string | undefined;
  let controlFile: string | undefined;
  if (context) {
    const remaining = context.budget.remaining(context.phase);
    if (remaining < 1000 || (engine && !context.budget.takeTurn(context.phase))) {
      log(`[budget] skipping ${engine ? "engine turn" : command}: ${context.phase} allowance exhausted`);
      return { code: 125, output: "Controller stage/engine-turn budget exhausted", stopped: true };
    }
    options = { ...options, timeoutMs: Math.min(options.timeoutMs ?? remaining, remaining) };
    if (engine) {
      turnId = randomUUID();
      ledgerFile = path.join(context.privateDir, "tests.jsonl");
      controlFile = path.join(context.privateDir, `stop-${turnId}.json`);
      options = { ...options, controlFile, ledgerFile, turnId, env: { ...options.env,
        TORINE_TEST_LEDGER: ledgerFile, TORINE_TURN_CONTROL: controlFile, TORINE_TURN_ID: turnId,
        TORINE_TEST_SCOPE: JSON.stringify(context.testScope ?? ["delivery"]),
        TORINE_TEST_TIMEOUT_MS: String(Math.floor(Math.min(120_000, options.timeoutMs || 120_000))),
      } };
    }
  }
  const result = await runProcess(command, argv, { ...options, log });
  if (engine && context) context.invalidate();
  if (engine && fatalGatewayError(result.output)) throw new Error("Model gateway rejected the configured key or exhausted its balance; stopping further turns with application inputs preserved.");
  if (engine && context && ledgerFile) {
    const events = readEvents(ledgerFile).filter((e) => e.turnId === turnId);
    if (!events.some((e) => e.type === "plugin-ready")) {
      context.lastFailure = "OpenCode controller plugin did not acknowledge loading; controlled testing unavailable";
      return { code: 126, output: `${result.output}\n${context.lastFailure}` };
    }
    const results = events.filter((e) => e.type === "test-end");
    if (options.heartbeatLabel?.startsWith("diagnostic") && !results.length && result.code === 0) {
      return { code: 126, output: `${result.output}\nDiagnostic produced no controlled test evidence; unresolved.` };
    }
    const latest = new Map(results.map((e) => [`${e.target}:${e.filter}`, e]));
    const unresolved = [...latest.values()].filter((e) => e.code !== 0);
    context.lastFailure = JSON.stringify({ stop: controlFile && fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile, "utf8")).reason : undefined,
      tests: unresolved.map(({ target, filter, category, failure, code, inputDigest }) => ({ target, filter, category, failure, code, inputDigest })) }, null, 2);
    if (sharedTestBudget(settingsFromEnv(options.cwd, { ...process.env, ...options.env })).exhausted) context.lastFailure += "\nShared requirement self-test allowance exhausted";
    if (result.code === 0 && unresolved.length) result.code = 126;
  }
  return result;
}

function modulePrompt(module: RequirementModule, completedIds: string[], mode: RunMode, focus?: { label: string; json: string }): string {
  const completed = completedIds.length ? completedIds.join(", ") : "none";
  const body = focus ? focus.json : JSON.stringify(module.subtree, null, 2);
  const scope = focus
    ? `Implement ONLY this requirement subtree (one child of the module, including all descendants): ${focus.label}`
    : "Implement ONLY the requirement subtree below, including all descendants (FOLDER and ATOMIC nodes with their scenarios).";
  let contractNode: Record<string, unknown> = module.subtree;
  if (focus) {
    try {
      contractNode = JSON.parse(focus.json) as Record<string, unknown>;
    } catch {
      /* keep module subtree */
    }
  }
  const contractSheet = renderTaskContract(extractTaskContract(contractNode));
  if (mode === "evolution") {
    return [
      `Incrementally implement ROOT module ${module.index}/${module.total}: ${module.nodeId} - ${module.name}`,
      "",
      "The output directory already contains this team's previous application. Inspect its relevant files, routes, data model, and existing behavior before editing.",
      "The current requirement subtree contains original behavior, modified behavior, and new behavior. Modified Feature Description and Evolution scenarios are authoritative where they change an original rule. Keep all original behavior that they do not change.",
      `Product-wide requirements: ${module.rootContext}`,
      `Module requirements: ${module.moduleContext}`,
      "Preserve the existing frontend, backend, routes, seed records, persisted data, permissions, and visible controls. Change only the files and logic needed for this subtree. Do not recreate the project or replace a whole file when a focused edit will work.",
      "For database changes, use compatible, repeatable initialization or migration. New seed records must not erase existing records.",
      "Work in a bounded vertical slice: identify the changed rule and its Evolution scenarios, edit only the affected UI/API/storage path, then verify that path before ending this turn. Do not spend the turn rewriting unrelated original features.",
      "For every affected scenario, check its stated starting data and the final observable result. Include one success path and one refusal/error path when the subtree specifies both. A disabled control alone is not enough: verify the stated reason, unchanged data, and persistence after reload where required. Do not invent extra blockers in seed data.",
      "A source-string match is not proof of behavior. Verify the changed flow through the app's own build and requirement-derived checks; do not claim a node is done merely because names or messages appear in source.",
      "Use only the supplied requirement documents and the application source. Do not locate, read, or use platform tests, hidden tests, grader files, or ARCBENCH_TESTS_DIR.",
      scope,
      `Previously completed modules/nodes: ${completed}`,
      "",
      "Requirement JSON:",
      body,
      "",
      contractSheet,
      "",
      "EVOLUTION SEED RULE: the PRE-PROVISIONED INITIAL STATE section above lists objects the scenarios expect to already exist on the inherited application (e.g. workbook/worksheet/record identifiers). Provision each of them in the application's seed/store initialization so a fresh start already contains them, without erasing the inherited baseline records. These are not created through the UI during the scenario.",
      "",
      "BROWSER SELF-CHECK (do this for the 1-2 most critical scenario paths of this subtree before finishing): build the frontend, start the backend on a scratch port (e.g. PORT=4171 npm start; never bind 3301 or the evaluation port), then write a short Playwright script and run it: `NODE_PATH=\"$TORINE_AGENT_ROOT/node_modules\" node check.cjs` with `const { chromium } = require('@playwright/test');`. Drive the scenario (goto, click by role/name, fill) and assert the scenario's stated visible outcomes (text, states, persistence after reload). Fix whatever the check exposes, then delete check.cjs, close the browser and stop the server. A passing build alone is not verification.",
      "",
      "RESOURCE CONTRACT (the run is killed if memory or token usage explodes): keep each turn self-contained - focused edits, no re-reading large files, no full-suite test marathons. Prefer `run_tests` with a `filter` for the changed area; run `target: all` at most once per turn, near the end. Start at most one dev server at a time and stop it when done. Do not run vite/vitest watch processes.",
      "",
      "SELF-CHECK AND RECEIPT (mandatory, per scenario of this subtree): verify each scenario's GIVEN initial state through the app's public entry, perform the WHEN operation, and assert EVERY stated THEN outcome including persistence after reload. For pre-provisioned objects, verify identity (identifier AND display name), enter through the prescribed entry, and re-verify after refresh; seeding must be idempotent - re-running initialization must not duplicate records and must keep inherited records intact. End the turn with a receipt listing, for every requirement ID in this subtree: what you actually checked (test names or browser steps), the result, and any unresolved gap. A scenario you did not verify must be listed as unresolved - never mark it done from code inspection alone.",
      "",
      DELIVERABLE,
      "",
      "Follow exact roles, accessible names, messages, and simultaneous error behavior specified by this subtree. An older generic UI rule never overrides a changed requirement.",
      "Implement and verify the new behavior with the application's own build and focused, requirement-derived checks. Keep the application runnable and avoid binding the evaluation port.",
      "Read ARCHITECTURE.md first if present; maintain a concise index of entry files and cross-module state/persistence constraints (max 200 lines/16 KiB). Do not put Judge evidence or raw logs there.",
      "Use run_tests for all traditional test execution; shell test commands are rejected by the controller. Report affected requirement IDs, changed files, actual checks, preserved behavior and unresolved failures. Stop after explaining unresolved failures.",
    ].join("\n");
  }
  return [
    `Implement ROOT module ${module.index}/${module.total}: ${module.nodeId} - ${module.name}`,
    "",
    "You are building a web application (Vite + React + TypeScript frontend, Express + SQLite backend) in the current working directory.",
    "Read ARCHITECTURE.md if present and update a concise source/constraint index (max 200 lines/16 KiB). Execute traditional tests only with run_tests; report actual checks and unresolved failures.",
    "An initialized starter application is already present. Preserve existing work from previously completed modules.",
    scope,
    "Do not read or open the full requirements.yaml file.",
    "",
    `Previously completed modules/nodes: ${completed}`,
    "",
    "Requirement JSON:",
    body,
    "",
    contractSheet,
    "",
    DELIVERABLE,
    "",
    "VERBATIM EXTRACT FIRST: before writing any code, list every quoted string in the requirement JSON above (labels, buttons, links, error messages, dialog titles). These are contractual UI text - copy them EXACTLY into the rendered UI. Never paraphrase, re-case, shorten, or reword them (\"Create an organization\" is NOT \"Create organization\").",
    "",
    UI_CONTRACT,
    "",
    "NAVIGATION CONTRACT: every navigation target the requirement names (link/button/tab/menuitem named ... entries listed in the TASK CONTRACT SHEET above) MUST exist as a visible element with the right role on the page where the scenario reaches it. Navigation entries the scenario opens from a menu must be in that menu. Pages reachable only when signed out (account-access flows) must still show the site header with its sign-in entry.",
    "",
    "RENDER CONTRACT (critical - most test failures come from violating this): destination content must be in the DOM by the time a click() resolves. Do NOT import { Link, NavLink } from 'react-router-dom' for navigation - SPA transitions render late and test helpers assert immediately after clicking. Use plain <a href> anchors (full page loads) or the provided components/AppLink.tsx. The router may stay for route matching only.",
    "",
    "FLOW RECIPES (verify each before finishing):",
    "- Password recovery: after submitting the email on the recovery entry, the fixed verification code (e.g. \"123456\") must appear as VISIBLE TEXT on the page the user lands on, together with the Verification code and New password fields. Submitting with an empty field must not dead-end the flow.",
    "- Label disambiguation: getByLabel('Email') must resolve to exactly one field at every step - never have both an 'Email' field and a 'Username or email' field visible on the same page state.",
    "- Members/people lists must render every seeded member's username as exact visible text, with row action buttons named `Member menu <username>` (pattern `<menu label> <row identity>`) whose menuitems match the requirement verbs, visible only to users allowed to manage.",
    "- Account menu must contain the entries the scenario clicks (typically Settings and Your organizations) before those clicks happen.",
    "- Active sessions page (Manage Active Browser Sessions): each session row shows its id/device and a status label; after revoking, the session's row MUST display a status text matching /revoked|inactive/i (visible inline text), and it stays visible after reload.",
    "- Organization audit log (View Organization Audit Log): audit entries appear on the org's audit page and become visible promptly after the triggering write (tests poll the page with expect.poll for a limited time - render entries as text rows, newest first, with actor/action/target fields).",
    "",
    "ROLE WIDGET CONTRACT: dropdowns that tests pick options from must expose role=combobox with clickable role=option items (a custom listbox - native select popups are not clickable in tests). Widgets the tests call selectOption() on must be native <select> elements. Search inputs are role=searchbox named so that a /search/i name matcher finds exactly one. Table rows with editable values use role=row with a per-row control and a Save button. Row action menus are buttons named `Member menu <value>` (pattern: `<menu label> <row identity>`) exposing menuitem entries, whose confirm dialogs use the verb button named exactly as the scenario states. Menu-command flows (Add file -> Create new file) use role=menuitem entries. When the requirement distinguishes a button and a link with similar names (e.g. a \"Code\" button vs a \"Code\" link), render BOTH with their exact distinct names.",
    "",
    "TEXT UNIQUENESS (tests match names by exact OR case-insensitive substring/regex - strict mode fails on multiple matches): for ANY name-like token used on a page, exactly ONE visible element may match it as a substring. Never let one accessible name contain another name used on the same page (a link named \"Code search\" breaks a getByRole('link', {name: /code/i}) lookup for \"Code\"). Repeating labels (role names etc.) must not appear as plain text across rows - use controls whose closed state does not render the label as text. Empty states show exactly ONE empty-state text (e.g. \"No results\"), never two variations at once. Labels the requirement phrases as patterns must contain the matcher words (e.g. a field matched as /file name/i needs a label containing \"file name\").",
    "",
    "ROOT EXPOSURE: every entity the requirement mentions (organizations, repositories, branches, commits, users) must be reachable as an exact-name clickable link starting from the application root/home page - test helpers retry from the root and click targets by exact name. Home/listing pages must therefore show these entities as exact-name links (seeded repos and orgs included). Commit history entries the scenarios click must be links named by their commit message.",
    "",
    "VALIDATION WHITELISTS: when the requirement states allowed characters or ranges (e.g. branch names: ASCII letters/digits/-/_/./ only, no trailing / or ., no .. or //), enforce that exact whitelist - do NOT substitute a git-style blacklist. Reject-and-explain with the requirement's exact error text.",
    "",
    "PLATFORM RUN CONTRACT: backend reads PORT (default 3000) and serves the built frontend from '/' (SPA fallback: unknown non-API paths return the index HTML entry, never crash; /favicon.ico and unknown APIs return proper 404/error responses). Provide a health check at /api/health. Static file paths resolve relative to the server file location, never the startup cwd. Never hardcode hosts or ports in build artifacts. Requirement-stated page URLs must open directly AND survive refresh, restoring the view.",
    "",
    "SEED TAXONOMY: seed data comes from FOUR sources - (1) top-level shared data, (2) ancestor requirement pre-provisions, (3) scenario GIVEN initial conditions, (4) WHET/THEN operation results. Provision (1)+(2) fully in the empty-store seed; (3) are per-scenario and may be mutually exclusive - never merge them into one default record or switch results by requirement id; (4) build via allowed business operations. Do not add login gates to scenarios that don't require them. When extending seeds, keep existing entities and relationships intact.",
    "",
    "HEADER & MENU RULES: the global page header is a top-level <header> (banner) alongside the single <main>; global navigation and global search live inside it. Headers inside articles or dialogs are local titles only. Menus and dialogs open operations in requirement order - do not hide entries or add extra confirmations beyond what the requirement states. Resolve abstract references in scenarios via the requirement text and ancestor contracts; abstract references or repeated templates are NOT UI copy.",
    "",
    "COMBOBOX RECIPE (when tests both click options and call selectOption): use a native <select> as the real control, styled compactly, that on activation exposes its <option> elements as clickable (e.g. size attribute or a custom listbox synced to the select's value). Never break either interaction path.",
    "",
    "SEED IDENTIFIERS: entities may have both an identifier (URL/name) and a display name (link text) - seed both exactly as the requirement states; links display the display name, headings/URLs use the identifier. Every backticked seed/example value in the requirement must exist in the database seed and appear verbatim where scenarios expect it.",
    "",
    "BROWSER SELF-CHECK (for the 1-2 most critical scenario paths of this subtree before finishing): build, start the app on a scratch port (e.g. PORT=4171; never bind 3301 or the evaluation port), write a short Playwright script (`const { chromium } = require('@playwright/test');`) and run `NODE_PATH=\"$TORINE_AGENT_ROOT/node_modules\" node check.cjs` to drive the scenario and assert its stated visible outcomes (text, states, persistence after reload). Fix what it exposes, delete check.cjs, stop the server.",
    "",
    "Use only the supplied requirements and application source. Do not locate, read, or use platform tests, hidden tests, grader files, or ARCBENCH_TESTS_DIR.",
    "",
    "Traceability (feeds the platform's progress UI): after implementing a requirement node, register what you built via the bundled skill script:",
    "  python3 skills/arcbench-traceability/scripts/arc_traceability.py upsert-interface --project-dir . --payload-json '{\"interface_id\":\"REQ-X.API.Something\",\"req_ids\":[\"REQ-X\"],\"type\":\"API\",\"content\":\"POST /api/...\",\"file_path\":\"backend/src/...\",\"implemented\":true}'",
    "  python3 skills/arcbench-traceability/scripts/arc_traceability.py upsert-test --project-dir . --payload-json '{\"test_id\":\"REQ-X.E2E\",\"req_id\":\"REQ-X\",\"type\":\"E2E\",\"file_path\":\"...\",\"interface_ids\":[\"...\"]}'",
    "Keep this brief: one interface record per key API/UI surface, one test record per scenario group. Do NOT write .arc/ JSON by hand - use the script.",
    "",
    "Time budget: start writing code promptly, then reserve the last part of this turn for a small requirement-derived behavior check. Exercise one successful scenario and one refusal/error scenario from this subtree when both exist; verify exact visible reason, unchanged data on refusal, and persistence after reload where required. Use the app's own routes or a short local browser/API probe on a non-evaluation port, and stop any server you start. Do not read platform or hidden tests. Run `npm run build` once to catch syntax errors.",
    "",
    "Seeding: where a scenario references existing accounts, organizations, repositories or similar records, provision those rows in the SQLite seed/init code so the scenario is runnable.",
    "Work practically: create/modify files, keep the app runnable, do not start long-running servers, do not run anything bound to the evaluation port 3000.",
    "Finish with a short summary of the files you changed.",
  ].join("\n");
}

const VERBATIM_FIX_PROMPT = (missing: string[], navOffenders: string[]) =>
  [
    "A mechanical lint found contract violations in the generated app. Fix them now:",
    ...(missing.length
      ? [
          "",
          "1) Missing requirement text strings (must appear EXACTLY in the rendered UI):",
          ...missing.map((s) => `   - ${JSON.stringify(s)}`),
        ]
      : []),
    ...(navOffenders.length
      ? [
          "",
          "2) Files using react-router-dom Link/NavLink for navigation (test helpers assert immediately after click; SPA transitions race them). Replace every Link/NavLink with a plain <a href> anchor (or components/AppLink.tsx) - keep react-router only for route matching:",
          ...navOffenders.map((f) => `   - ${f}`),
        ]
      : []),
    "",
    "Keep everything else working. Finish with one line listing the files you touched.",
  ].join("\n");

const SEED_FIX_PROMPT = (missing: string[]) =>
  [
    "A mechanical lint found pre-provisioned objects that the scenarios assume already exist, but they are absent from the application seed/source.",
    "Provision each of these in the empty-store / seed initialization so a fresh start already contains them. They are initial data (records/workbooks/worksheets/entities the scenarios work on).",
    "Do NOT render them as UI text and do NOT create them through the UI flow. Preserve every existing seed record and the inherited baseline data.",
    ...missing.map((s) => `   - ${JSON.stringify(s)}`),
    "",
    "Finish with one line listing the files you touched.",
  ].join("\n");

function auditPrompt(module: RequirementModule, atomicIds: string[]): string {
  return [
    `Audit pass for ${module.nodeId} - ${module.name}. Do NOT write new feature code.`,
    `Inspect the current project and answer with a single line: DONE=[comma-separated ids of these ATOMIC requirement nodes that are FULLY implemented end-to-end]:`,
    atomicIds.join(", "),
    "Judge each node by its scenarios: routes/UI/API/seed present and wired. When finished, reply with exactly one line starting 'DONE=' and nothing else.",
  ].join("\n");
}

function logWorkspaceTree(outputDir: string): void {
  const lines: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || lines.length > 60) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "__pycache__", ".arc"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        walk(full, depth + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
      if (lines.length > 60) {
        lines.push("... (truncated)");
        return;
      }
    }
  };
  walk(outputDir, 0);
  log("[postflight] workspace tree:\n" + lines.join("\n"));
}

function workspaceSignature(outputDir: string): string {
  let count = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".arc", "dist", "__pycache__"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        count += 1;
        try {
          const stat = fs.statSync(full);
          bytes += stat.size;
          newest = Math.max(newest, stat.mtimeMs);
        } catch {
          /* raced with the agent writing files */
        }
      }
    }
  };
  walk(outputDir);
  return `${count}:${bytes}:${newest}`;
}

function baselineFiles(outputDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage", ".git", ".arc"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(outputDir, full));
    }
  };
  walk(path.join(outputDir, "frontend"));
  walk(path.join(outputDir, "backend"));
  return files;
}

async function checkEvolutionModule(outputDir: string, originalFiles: string[], logFile: string): Promise<string | null> {
  if (!hasDeliverable(outputDir)) return "The frontend or backend package.json is missing";
  const missingFiles = originalFiles.filter((file) => !fs.existsSync(path.join(outputDir, file)));
  if (missingFiles.length) return `Baseline files were removed: ${missingFiles.slice(0, 20).join(", ")}`;
  const frontendDir = path.join(outputDir, "frontend");
  const install = await npmInstall(frontendDir, 10 * 60 * 1000, logFile);
  if (install.code !== 0) return `frontend npm install failed (exit ${install.code}): ${install.output.slice(-1800)}`;
  const build = await runCommand("npm", ["run", "build"], {
    cwd: frontendDir,
    timeoutMs: 10 * 60 * 1000,
    logFile,
  });
  if (build.code !== 0) return `frontend build failed (exit ${build.code}): ${build.output.slice(-1800)}`;
  const backendDir = path.join(outputDir, "backend");
  const backendInstall = await npmInstall(backendDir, 10 * 60 * 1000, logFile);
  if (backendInstall.code !== 0) return `backend npm install failed (exit ${backendInstall.code}): ${backendInstall.output.slice(-1800)}`;
  return rehearseBackend(backendDir, 3100);
}

const installedInputs = new Map<string, string>();
function dependencyInput(dir: string): string {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) hash.update(file).update(fs.readFileSync(full));
  }
  return hash.digest("hex");
}

async function npmInstall(dir: string, timeoutMs: number, logFile: string): Promise<{ code: number | null; output: string }> {
  if (fs.existsSync(path.join(dir, "node_modules")) && installedInputs.get(dir) === dependencyInput(dir)) return { code: 0, output: "Dependency inputs unchanged since successful installation" };
  const first = await runCommand("npm", ["install"], { cwd: dir, timeoutMs, logFile });
  if (first.code === 0) { installedInputs.set(dir, dependencyInput(dir)); return first; }
  if ([124, 125].includes(first.code || 0)) return first;
  // Old npm (9.x arborist bug on peer-deps graphs) can fail on a good lockfile;
  // --legacy-peer-deps works there and is a no-op difference on modern npm.
  log(`[npm] install failed in ${dir}; retrying with --legacy-peer-deps`);
  const retry = await runCommand("npm", ["install", "--legacy-peer-deps"], { cwd: dir, timeoutMs, logFile });
  if (retry.code === 0) installedInputs.set(dir, dependencyInput(dir));
  return retry;
}

async function rehearseBackend(backendDir: string, _port: number): Promise<string | null> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const timeout = Math.min(10_000, controller?.budget.remaining(controller.phase) ?? 10_000);
  if (timeout < 1000) return "Startup verification budget exhausted";
  const child = spawn("npm", ["run", "start"], { cwd: backendDir, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let spawnError = "";
  child.stdout.on("data", (c: Buffer) => { output = (output + c.toString()).slice(-3000); });
  child.stderr.on("data", (c: Buffer) => { output = (output + c.toString()).slice(-3000); });
  child.on("error", (error) => { spawnError = String(error); });
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) return `backend exited before readiness: ${spawnError} ${output}`;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now()))) });
        await response.body?.cancel();
        if (response.ok) return null;
      } catch { /* wait for actual HTTP readiness */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return `backend did not serve its root before readiness deadline: ${output}`;
  } finally {
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    child.stdout.destroy(); child.stderr.destroy();
  }
}

// The selftest channel grades a zipped app that must contain a Dockerfile at
// the zip root (offline docker build, PORT-driven start). Guarantee one exists
// and is correct even if the model deleted or rewrote the template copy.
function ensureDockerfile(outputDir: string): void {
  const expected = [
    "# ARC-Bench selftest app package.",
    "# Build must work WITHOUT external network: this zip ships prebuilt",
    "# frontend/dist and vendored backend/node_modules. npm only runs as a",
    "# fallback when those artifacts are absent.",
    "FROM node:20-slim",
    "",
    "WORKDIR /app",
    "",
    "COPY . .",
    "",
    "RUN cd frontend && { test -f dist/index.html || (npm install --no-audit --no-fund && npm run build); }",
    "RUN cd backend && { test -d node_modules || npm install --omit=dev --no-audit --no-fund; }",
    "",
    "ENV PORT=3000",
    "EXPOSE 3000",
    "",
    'CMD ["sh", "-c", "cd backend && node src/index.js"]',
    "",
  ].join("\n");
  const target = path.join(outputDir, "Dockerfile");
  let current = "";
  try {
    current = fs.readFileSync(target, "utf-8");
  } catch {
    /* missing */
  }
  if (current !== expected) {
    fs.writeFileSync(target, expected);
    log("[postflight] wrote Dockerfile at output root");
  }
}

function postflightLift(outputDir: string): void {
  logWorkspaceTree(outputDir);
  const rootFrontend = path.join(outputDir, "frontend");
  const rootBackend = path.join(outputDir, "backend");
  if (fs.existsSync(rootFrontend) && fs.existsSync(rootBackend)) {
    log("[postflight] frontend/ and backend/ present at output root");
    return;
  }
  const children = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ![".git", ".arc", "requirements", "node_modules"].includes(entry.name));
  for (const child of children) {
    const nested = path.join(outputDir, child.name);
    if (fs.existsSync(path.join(nested, "frontend")) && fs.existsSync(path.join(nested, "backend"))) {
      log(`[postflight] app nested at ${child.name}/; lifting to output root`);
      for (const item of fs.readdirSync(nested)) {
        const destination = path.join(outputDir, item);
        if (fs.existsSync(destination)) continue;
        fs.renameSync(path.join(nested, item), destination);
      }
      return;
    }
  }
  log("[postflight] WARNING: frontend/+backend/ not found; the runner will reject this template");
}

function collectAtomicIds(node: Record<string, unknown>, sink: string[]): void {
  const id = String(node.id || "").trim();
  const type = String(node.type || "").trim().toUpperCase();
  if (type === "ATOMIC" && id) sink.push(id);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child && typeof child === "object") collectAtomicIds(child as Record<string, unknown>, sink);
  }
}

function collectAtomicNodes(node: Record<string, unknown>, sink: Record<string, unknown>[]): void {
  const type = String(node.type || "").trim().toUpperCase();
  if (type === "ATOMIC" && String(node.id || "").trim()) sink.push(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child && typeof child === "object") collectAtomicNodes(child as Record<string, unknown>, sink);
  }
}

function parseDoneIds(output: string, knownIds: string[]): string[] {
  const matches = [...output.matchAll(/DONE=([A-Za-z0-9_,\-\s]*)/g)];
  if (!matches.length) return [];
  const raw = matches[matches.length - 1][1] ?? "";
  const listed = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return listed.filter((id) => knownIds.includes(id));
}

// Mechanical audit: self-assessment inflates ("audit 21/21" on a 1/41 run).
// Verify each ATOMIC node by grepping the source for its own contract items
// (named UI targets + error strings derived from its requirement text).
function readSourceCorpus(outputDir: string): string {
  const chunks: string[] = [];
  for (const root of ["frontend/src", "backend/src"]) {
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", "dist", "__pycache__"].includes(entry.name)) continue;
          walk(full);
        } else if (/\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
          try {
            chunks.push(fs.readFileSync(full, "utf-8"));
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(path.join(outputDir, root));
  }
  return chunks.join("\n");
}

function auditAtomicsMechanically(
  outputDir: string,
  atomicNodes: Record<string, unknown>[],
): { doneIds: string[]; report: string[]; missingSeeds: string[] } {
  const corpus = readSourceCorpus(outputDir);
  const doneIds: string[] = [];
  const report: string[] = [];
  const missingSeedsAggregate: string[] = [];
  for (const node of atomicNodes) {
    const id = String(node.id || "").trim();
    const contract = extractTaskContract(node);
    const namedValues = contract.namedTargets.map((t) => t.slice(t.indexOf(":") + 2).trim());
    const missingNamed = namedValues.filter((v) => v && !corpus.includes(v));
    const missingErrors = contract.errorStrings.filter((e) => !corpus.includes(e));
    const missingSeeds = contract.seedIdentifiers.filter((s) => !corpus.includes(s));
    const ok = missingNamed.length === 0 && missingErrors.length === 0 && missingSeeds.length === 0;
    if (ok) doneIds.push(id);
    report.push(
      `${id}: ${ok ? "DONE" : "MISSING"} (named ${namedValues.length - missingNamed.length}/${namedValues.length}, errors ${contract.errorStrings.length - missingErrors.length}/${contract.errorStrings.length}, seeds ${contract.seedIdentifiers.length - missingSeeds.length}/${contract.seedIdentifiers.length})` +
        (missingNamed.length ? ` no-named: ${missingNamed.slice(0, 3).join("|")}` : "") +
        (missingErrors.length ? ` no-err: ${missingErrors.slice(0, 2).join("|")}` : "") +
        (missingSeeds.length ? ` no-seed: ${missingSeeds.slice(0, 3).join("|")}` : ""),
    );
    for (const seed of missingSeeds) if (!missingSeedsAggregate.includes(seed)) missingSeedsAggregate.push(seed);
  }
  return { doneIds, report, missingSeeds: missingSeedsAggregate };
}

// Verbatim lint: the acceptance tests match visible text with anchored regexes,
// so every quoted string in a requirement is a contractual UI string. Collect
// them from the requirement JSON and check the generated source for each.
function collectTextBlobs(node: Record<string, unknown>, sink: string[]): void {
  for (const value of Object.values(node)) {
    if (typeof value === "string") sink.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") sink.push(item);
        else if (item && typeof item === "object") collectTextBlobs(item as Record<string, unknown>, sink);
      }
    } else if (value && typeof value === "object") {
      collectTextBlobs(value as Record<string, unknown>, sink);
    }
  }
}

function extractVerbatimStrings(nodes: Record<string, unknown>[]): Set<string> {
  const blobs: string[] = [];
  for (const node of nodes) collectTextBlobs(node, blobs);
  const out = new Set<string>();
  for (const blob of blobs) {
    for (const match of blob.matchAll(/[""\u201c]([^""\u201c\u201d"]{2,80})[""\u201d]/g)) {
      const s = match[1].trim();
      // UI strings only: must contain a letter, no code/regex/path noise.
      if (!/[A-Za-z]/.test(s)) continue;
      if (/[\\^$()[\]{}|*+?.\/]/.test(s)) continue;
      if (/^\d+$/.test(s)) continue;
      // Skip all-lowercase single words: those are defined concepts in prose
      // ("account", "session"), not UI text. UI strings are Title Case or
      // multi-word.
      if (/^[a-z][a-z0-9-]*$/.test(s)) continue;
      out.add(s);
    }
    // Backticked identifiers are seed/entity names the scenarios rely on
    // (e.g. `EVO-M01-RENAME-OK`, `alice-dev`). They must exist in the code
    // (seed data), so lint them too. Identifier-shaped tokens only - this
    // skips formulas, paths, regexes and prose fragments.
    for (const match of blob.matchAll(/`([^`\n]{2,80})`/g)) {
      const s = match[1].trim();
      if (/^[A-Za-z][A-Za-z0-9._@-]{1,79}$/.test(s)) out.add(s);
    }
  }
  return out;
}

// Task contract sheet: derived at runtime from the requirement subtree this
// turn implements. Hardcoding per-task strings overfits (stage-1 strings are
// noise for stage-2/sheet) - extraction adapts to any task automatically.
type TaskContract = {
  namedTargets: string[];
  errorStrings: string[];
  seeds: string[];
  seedStatements: string[];
  seedIdentifiers: string[];
  isSpreadsheet: boolean;
};

// Seed declarations are the pre-provisioned initial state a scenario's GIVEN
// establishes (e.g. the `EVO-M01-RENAME-LIMIT` worksheet the evolution
// scenarios expect to already exist). Extracting them from requirement evidence
// from the requirement evidence and hands them to the model as mandatory
// seed data; without them the model never provisions the expected objects and
// every dependent probe fails at its first step. Identifiers are entity-shaped
// names only - coordinates (A1, C2) and plain counters are excluded so the lint
// does not chase values that have no reason to appear in source.
const SEED_CONTEXT = /\b(pre-provisions?|pre-provisioned|seed(?:ed|s)?|initial (?:state|data|condition)|existing|already|authored|contains?|provides?|exists?)\b/i;
function isSeedIdentifier(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9._@-]{1,79}$/.test(value)) return false;
  if (/^[A-Z]{1,3}\d{1,7}$/.test(value)) return false; // cell coordinates
  if (/^[A-Za-z]+\d+$/.test(value)) return false; // default sheet names (Sheet1)
  return true;
}
function extractSeedDeclarations(node: Record<string, unknown>): { statements: string[]; identifiers: string[] } {
  const blobs: string[] = [];
  collectTextBlobs(node, blobs);
  const text = blobs.join("\n");
  const statements: string[] = [];
  const identifiers = new Set<string>();
  for (const raw of text.split(/(?<=[.;:])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const inSeedContext = SEED_CONTEXT.test(sentence);
    for (const match of sentence.matchAll(/`([^`\n]{1,80})`/g)) {
      const value = match[1].trim();
      if (!isSeedIdentifier(value)) continue;
      // A pre-provision sentence, or an all-caps entity code (EVO-*), pins a
      // required seed object even when the surrounding wording is terse.
      if (inSeedContext || /^[A-Z][A-Z0-9]{1,}-/.test(value)) {
        identifiers.add(value);
        if (statements.length < 60 && sentence.includes("`") && !statements.includes(sentence)) statements.push(sentence);
      }
    }
  }
  return { statements, identifiers: [...identifiers] };
}

function extractTaskContract(node: Record<string, unknown>): TaskContract {
  const blobs: string[] = [];
  collectTextBlobs(node, blobs);
  const text = blobs.join("\n");

  const namedTargets: string[] = [];
  const namedSet = new Set<string>();
  for (const match of text.matchAll(
    /(link|button|tab|menuitem|dialog|textbox|checkbox|combobox|option|heading|navigation)[^.\u201c"]{0,32}(?:named|labeled)?\s*[\u201c"]([^\u201c"]{2,60})[\u201d"]/gi,
  )) {
    const entry = `${match[1].toLowerCase()}: ${match[2].trim()}`;
    if (!namedSet.has(entry)) {
      namedSet.add(entry);
      namedTargets.push(entry);
    }
  }

  const errorStrings: string[] = [];
  const errorSet = new Set<string>();
  const namedValues = new Set(namedTargets.map((entry) => entry.slice(entry.indexOf(":") + 2)));
  for (const match of text.matchAll(/[\u201c"]([^\u201c"]{2,80})[\u201d"]/g)) {
    const s = match[1].trim();
    if (!/[A-Za-z]/.test(s)) continue;
    if (namedValues.has(s)) continue;
    const before = text.slice(Math.max(0, match.index! - 140), match.index!).toLowerCase();
    const after = text.slice(match.index! + s.length, match.index! + s.length + 80).toLowerCase();
    const errorContext = /error|message|displays|shows|invalid|denied|not allowed|already exists|required|incorrect|failed/.test(before + after);
    const looksLikeMessage = /\s/.test(s) || /already|invalid|required|incorrect|denied|not found|not allowed/.test(s.toLowerCase());
    if (errorContext && looksLikeMessage && !errorSet.has(s)) {
      errorSet.add(s);
      errorStrings.push(s);
    }
  }

  const seeds = [...new Set([...text.matchAll(/`([^`\s][^`]{0,60})`/g)].map((m) => m[1]))];
  const isSpreadsheet = /worksheet|spreadsheet|cell(?:s)?\b|formula|gridcell|pivot table/i.test(text);
  const { statements: seedStatements, identifiers: seedIdentifiers } = extractSeedDeclarations(node);
  return { namedTargets, errorStrings, seeds, seedStatements, seedIdentifiers, isSpreadsheet };
}

const SPREADSHEET_RECIPE = [
  "SPREADSHEET RECIPE (aria/behavior contracts the acceptance tests assert):",
  "- Grid: container role=grid; each row role=row; each cell role=gridcell with aria-label EXACTLY the coordinate (\"A1\", \"B2\") and text content = the DISPLAYED value (computed result for formula cells, never the formula text). Selected cells get aria-selected=\"true\"; range-selectable grids set aria-multiselectable=\"true\" on the grid and keep aria-selected accurate for every cell in the rectangle.",
  "- Formula bar: a textbox labeled \"Formula bar\" shows the RAW formula of the selected cell (grid shows the computed result); pressing Enter in it commits. Inline cell editors are textboxes named \"Edit <coordinate>\".",
  "- Worksheet tabs: role=tab, with aria-selected=\"true\" on exactly the active sheet's tab.",
  "- CSV export renders COMPUTED values (a cell holding =A1*2 exports as 4, not the formula).",
  "- Buttons are matched by whole-word case-insensitive regexes (/^(save)$/i) - name them exactly (e.g. \"Save\").",
  "- Formula engine: formulas start with =; support + - * /, parentheses, A1 references, SUM/AVERAGE/COUNT/MIN/MAX over ranges; relative refs shift on copy, absolute ($A$1) do not; error values #DIV/0! #REF! #NAME? #ERROR! render in the grid while the formula bar keeps the original formula; edits recalculate all direct/indirect dependents.",
  "- Selection/copy/paste: rectangular selection persists per worksheet across reloads and sheet switches; paste fills the exact rectangle; validation failures reject the WHOLE operation and keep original values.",
  "- Undo/Redo buttons named exactly \"Undo\"/\"Redo\" cover the session's recent edits in reverse order.",
  "- Rename flows use a dialog with a name field and a button whose accessible name matches /^(save)$/i; invalid/empty names show inline text /workbook name cannot be empty/, /worksheet name cannot be empty/ or /worksheet name already exists/; success renames the tab/link in place.",
  "- Freeze panes: a menu command (e.g. View menu \"Freeze panes\" variants) freezes rows/columns; frozen lines render with a visible divider and remain pinned during scrolling; unfreeze restores.",
  "- Conditional formatting: dialog \"Conditional formatting\" with a rule type selector, range field, format options and Save/Delete; matching cells render the chosen format live; deleting a rule removes the format; rules persist across reloads.",
  "- Cell notes: anchor cell shows a marker; opening it shows the note text (and author); add/edit/delete flows persist notes across reloads; deleting the annotated cell content does not remove the note unless the requirement says so.",
].join("\n");

function renderTaskContract(contract: TaskContract): string {
  const lines: string[] = ["TASK CONTRACT SHEET (derived from this requirement subtree - treat as checklist):"];
  if (contract.namedTargets.length) {
    lines.push("Named UI targets that MUST exist as visible elements with the right roles:");
    for (const t of contract.namedTargets.slice(0, 40)) lines.push(`  - ${t}`);
    if (contract.namedTargets.length > 40) lines.push(`  ... and ${contract.namedTargets.length - 40} more`);
  }
  if (contract.errorStrings.length) {
    lines.push("Error/validation messages that must appear verbatim in the UI where the requirement says they are displayed:");
    for (const s of contract.errorStrings.slice(0, 25)) lines.push(`  - ${JSON.stringify(s)}`);
    if (contract.errorStrings.length > 25) lines.push(`  ... and ${contract.errorStrings.length - 25} more`);
  }
  if (contract.seedIdentifiers.length) {
    lines.push("PRE-PROVISIONED INITIAL STATE (scenario GIVEN facts - these objects/records MUST exist in the store seed before any scenario runs; do NOT create them through the UI):");
    for (const s of contract.seedStatements.slice(0, 20)) lines.push(`  - ${s}`);
    lines.push("Required seeded identifiers (each MUST appear verbatim in seed/source):");
    for (const s of contract.seedIdentifiers.slice(0, 40)) lines.push(`  - ${JSON.stringify(s)}`);
    if (contract.seedIdentifiers.length > 40) lines.push(`  ... and ${contract.seedIdentifiers.length - 40} more`);
  }
  if (contract.seeds.length) {
    lines.push("Seed/example values referenced by scenarios (provision in DB seed and use verbatim):");
    for (const s of contract.seeds.slice(0, 30)) lines.push(`  - ${JSON.stringify(s)}`);
    if (contract.seeds.length > 30) lines.push(`  ... and ${contract.seeds.length - 30} more`);
  }
  if (contract.isSpreadsheet) {
    lines.push("");
    lines.push(SPREADSHEET_RECIPE);
  }
  return lines.join("\n");
}

function lintNavStyle(outputDir: string): string[] {
  // SPA router links race the tests' immediate post-click assertions - catch
  // react-router Link/NavLink usage mechanically.
  const offenders: string[] = [];
  const root = path.join(outputDir, "frontend", "src");
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist"].includes(entry.name)) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        try {
          const text = fs.readFileSync(full, "utf-8");
          if (/import\s*\{[^}]*\b(Link|NavLink)\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(text)) {
            offenders.push(path.relative(outputDir, full));
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  return offenders;
}

function lintVerbatim(outputDir: string, expected: Set<string>): string[] {
  const missing: string[] = [];
  const haystack: string[] = [];
  const roots = ["frontend/src", "backend/src"];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "__pycache__"].includes(entry.name)) continue;
        walk(full);
      } else if (/\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
        try {
          haystack.push(fs.readFileSync(full, "utf-8"));
        } catch {
          /* unreadable file - skip */
        }
      }
    }
  };
  for (const root of roots) walk(path.join(outputDir, root));
  const corpus = haystack.join("\n");
  for (const s of expected) {
    if (!corpus.includes(s)) missing.push(s);
  }
  return missing;
}

function startPortWatchdog(webPort: number, outputDir: string): NodeJS.Timeout {
  const root = outputDir.replace(/\/+$/, "");
  const tick = async (): Promise<void> => {
    try {
      const listing = await new Promise<string>((resolve) => {
        const child = spawn("lsof", [`-t`, `-i`, `:${webPort}`], { stdio: ["ignore", "pipe", "ignore"] });
        let data = "";
        child.stdout.on("data", (chunk: Buffer) => (data += chunk.toString()));
        child.on("close", () => resolve(data));
        child.on("error", () => resolve(""));
      });
      const pids = listing.split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        let cwd = "";
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          continue;
        }
        if (!cwd.startsWith(root)) continue; // shared runner: never kill foreign processes
        log(`[watchdog] killing pid ${pid} (cwd ${cwd}) bound to port ${webPort}`);
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* watchdog must never break the run */
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref?.();
  return timer;
}

async function runAgent(runtime: AgentRuntime, requirementsDir: string, outputDir: string, agentRoot: string, webPort: number): Promise<void> {
  // Child opencode turns inherit this: it is how the model's own Playwright
  // self-checks resolve the controller toolkit's browser dependency
  // (NODE_PATH=$TORINE_AGENT_ROOT/node_modules node check.cjs).
  process.env.TORINE_AGENT_ROOT = agentRoot;
  const mode = detectRunMode(requirementsDir);
  if (mode === "evolution" && !hasDeliverable(outputDir)) {
    throw new Error("Evolution requires the platform-injected baseline with frontend/package.json and backend/package.json; refusing to copy a starter over it");
  }
  runtime.traceability.initDb();
  runtime.git.ensureRepo();

  let modules = loadRootModules(requirementsDir);
  if (mode === "evolution" && process.env.TORINE_EVOLUTION_PRIORITY !== "0") {
    try { modules = prioritizeEvolution(modules); }
    catch (error) { log(`[plan] ${String(error)}; using complete original requirement order`); }
  }
  const sheetLike = modules.some((m) => extractTaskContract(m.subtree).isSpreadsheet);

  if (hasDeliverable(outputDir)) {
    log("[init] existing frontend/+backend/ detected; keeping prior work (evolution mode)");
  } else {
    log("[init] copying starter template into output directory (template)");
    copyTemplateContentsToOutput(path.join(agentRoot, "template"), outputDir);
    if (sheetLike) {
      const scaffold = path.join(agentRoot, "sheet-scaffold");
      if (fs.existsSync(scaffold)) {
        copyTemplateContentsToOutput(scaffold, outputDir);
        log("[init] spreadsheet scaffold copied (grid/formula-bar/tab ARIA components)");
      }
    }
  }

  log(`[plan] ${modules.length} ROOT module(s): ${modules.map((m) => m.nodeId).join(", ")}`);

  // The platform does not enforce a 1h wall (run 35547c1f06f4 ran 100+ min);
  // the real guard killed 612a2fc749a6 at 38min after a 19.4M-token burn from
  // oversized turns. Keep a long-but-bounded clock plus the resource contract.
  const envBudgetMs = Number(process.env.TORINE_RUN_BUDGET_MS || 0);
  const totalBudgetMs = mode === "evolution"
    ? Math.max(Number.isFinite(envBudgetMs) && envBudgetMs > 0 ? envBudgetMs : 0, 100 * 60_000)
    : (Number.isFinite(envBudgetMs) && envBudgetMs > 0 ? envBudgetMs : 60 * 60_000);
  controller = {
    budget: new ControllerBudget(totalBudgetMs,
      Number(process.env.TORINE_MAX_ENGINE_TURNS || 20), Number(process.env.TORINE_JUDGE_MAX_PLAN_CALLS || 14)),
    phase: "implementation", privateDir: fs.mkdtempSync(path.join(os.tmpdir(), "torine-controller-")),
    diagnostics: new Set(), session: new JudgeSession(), lastFailure: "",
    invalidate: () => { for (const id of controller?.session.seenIds || []) runtime.traceability.upsertNodeState(id, "IMPLEMENTED", "implement"); },
  };
  const configPath = writeOpencodeConfig(agentRoot);
  const opencodeBin = resolveOpencodeBin(agentRoot);
  const { providerId, modelId } = modelSpec();
  const nodeTimeoutMs = Math.max(Number(process.env.TORINE_NODE_TIMEOUT_MS || 0), 15 * 60 * 1000);
  // A turn is one opencode session; every LLM call inside it re-sends the
  // growing transcript, so long turns burn tokens quadratically (19.4M tokens
  // in 38min on run 612a2fc749a6). 15 minutes bounds transcript growth while
  // leaving room for real feature work - including the browser self-check
  // loop (write check.cjs, run, fix, re-run). Platform-injected env may lower
  // this; the floor wins because a truncated turn fails its module.
  const evolutionNodeTimeoutMs = Math.max(
    Number(process.env.TORINE_EVOLUTION_NODE_TIMEOUT_MS || 0), 15 * 60 * 1000);
  const evolutionWorkBudgetMs = Math.max(
    Number(process.env.TORINE_EVOLUTION_WORK_BUDGET_MS || 0), controller.budget.remaining("implementation"));
  if (mode === "evolution" && (!Number.isFinite(evolutionNodeTimeoutMs) || evolutionNodeTimeoutMs <= 0)) {
    throw new Error("TORINE_EVOLUTION_NODE_TIMEOUT_MS must be a positive number");
  }
  if (mode === "evolution" && (!Number.isFinite(evolutionWorkBudgetMs) || evolutionWorkBudgetMs <= 0)) {
    throw new Error("TORINE_EVOLUTION_WORK_BUDGET_MS must be a positive number");
  }
  const workDeadline = Date.now() + Math.min(evolutionWorkBudgetMs, controller.budget.remaining("implementation"));
  const completedIds: string[] = [];
  const seedRepairsAttempted = new Set<string>();
  const failedIds: string[] = [];
  const logsDir = path.join(outputDir, ".arc", "logs");
  const runStartedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const watchdog = startPortWatchdog(webPort, outputDir);
  const originalFiles = mode === "evolution" ? baselineFiles(outputDir) : [];

  for (const module of modules) {
    if (Date.now() >= workDeadline) {
      log("[budget] evolution implementation time exhausted; proceeding to final checks");
      break;
    }
    controller.phase = "implementation";
    const finishesModule = !modules.slice(module.index).some(item => item.nodeId === module.nodeId);
    const moduleCheckpoint = new Checkpoint(outputDir, controller.privateDir);
    const previousModulePassed = controller.latestReceipt?.report.results.filter((r) => r.status === "passed") || [];
    // Per-module session: turns within a module share one hot session, but each
    // module starts fresh - a single growing session across all turns re-sends
    // the whole conversation every turn (O(n^2) token cost, $18 runs).
    let useHotSession = false;
    log(`[module ${module.index}/${module.total}] ${module.nodeId} - ${module.name}`);
    runtime.events.markImplementationStarted(module.nodeId, `opencode implementing ${module.name}`);

    const atomicNodes: Record<string, unknown>[] = [];
    collectAtomicNodes(module.subtree, atomicNodes);
    const atomicIds = atomicNodes.map((node) => String(node.id || "").trim()).filter(Boolean);
    const childNodes = (Array.isArray(module.subtree.children) ? module.subtree.children : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    const splitMode = childNodes.length > 1;
    const turns: { label: string; prompt: string; logName: string; atomicScope: string[] }[] = [];
    if (splitMode) {
      log(`[module ${module.index}/${module.total}] splitting into ${childNodes.length} child turns`);
      for (const node of childNodes) {
        const nodeId = String(node.id || "").trim() || `child-${turns.length + 1}`;
        const scope: string[] = [];
        collectAtomicIds(node, scope);
        turns.push({
          label: nodeId,
          prompt: modulePrompt(module, completedIds, mode, { label: nodeId, json: JSON.stringify(node, null, 2) }),
          logName: `module-${module.index}-${module.nodeId}-part-${nodeId}`,
          atomicScope: scope.length ? scope : [nodeId],
        });
      }
    } else {
      turns.push({
        label: module.nodeId,
        prompt: modulePrompt(module, completedIds, mode),
        logName: `module-${module.index}-${module.nodeId}`,
        atomicScope: atomicIds.length ? atomicIds : [module.nodeId],
      });
    }

    let moduleOk = true;
    for (const turn of turns) {
      controller.testScope = turn.atomicScope;
      const remainingWorkMs = workDeadline - Date.now();
      if (remainingWorkMs < 60_000) {
        log(`[budget] stopping before ${turn.label}; reserving time for final checks`);
        moduleOk = false;
        break;
      }
      log(`[turn] ${turn.label} (${module.nodeId})${useHotSession ? " [continue]" : ""}`);
      // Per-atomic phase events: design is folded into the
      // implementation prompt, so emit done immediately - this is what makes
      // the canvas light up orange at turn start instead of staying gray.
      for (const atomicId of turn.atomicScope) {
        runtime.events.markDesignStarted(atomicId, `designing ${atomicId}`);
        runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
      }
      const started = Date.now();
      const before = workspaceSignature(outputDir);
      const argv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto"];
      if (useHotSession) argv.push("--continue");
      argv.push(turn.prompt);
      let result = await runCommand(opencodeBin, argv, {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: Math.min(mode === "evolution" ? evolutionNodeTimeoutMs : nodeTimeoutMs, remainingWorkMs),
        logFile: path.join(logsDir, `${runStartedAt}-${turn.logName}.log`),
        heartbeatLabel: `turn ${turn.label}`,
      });
      // A hot session can carry an increasingly large transcript across child
      // turns. Evolution turns are self-contained and start fresh against the
      // shared project files; this limits context growth and token spending.
      useHotSession = mode === "initial";
      // NUDGE: a turn that only reads/analyzes wrote no files.
      // Kick once with an explicit "write files now" prompt.
      if (mode === "initial" && result.code === 0 && workspaceSignature(outputDir) === before) {
        log(`[turn] ${turn.label}: no file changes; nudging`);
        const nudgeArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", "--continue", NUDGE_PROMPT];
        result = await runCommand(opencodeBin, nudgeArgv, {
          cwd: outputDir,
          env: {
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
          },
          timeoutMs: nodeTimeoutMs,
          logFile: path.join(logsDir, `${runStartedAt}-${turn.logName}-nudge.log`),
        });
      }
      if ([124, 125, 126].includes(result.code || 0) && !controller.lastFailure.includes("Shared requirement self-test allowance exhausted") && !controller.diagnostics.has(module.nodeId)
        && controller.budget.remaining("implementation") >= 10_000) {
        controller.diagnostics.add(module.nodeId);
        log(`[diagnostic] ${module.nodeId}: one fresh, bounded diagnosis after interrupted/unresolved self-test`);
        const diagnostic = [turn.prompt, "DIAGNOSTIC: The controller interrupted the preceding attempt or observed unresolved self-tests.",
          "Read ARCHITECTURE.md if present. First distinguish test setup, asynchronous cleanup, environment and product logic. Run one affected test with run_tests; never fix by deleting checks, weakening expected results, increasing suite timeouts or clearing baseline data.",
          "Repair only a demonstrated cause; preserve previous behavior. If unresolved, state the failure and stop. Update the short architecture index and report actual checks.",
          controller.lastFailure, result.output.slice(-3000)].join("\n\n");
        result = await runCommand(opencodeBin, ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", diagnostic], {
          cwd: outputDir, env: { OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`) },
          timeoutMs: Math.min(180_000, controller.budget.remaining("implementation")),
          logFile: path.join(logsDir, `${runStartedAt}-${turn.logName}-diagnostic.log`), heartbeatLabel: `diagnostic ${turn.label}`,
        });
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.code === 0) {
        log(`[turn] ${turn.label} ok in ${seconds}s`);
        for (const atomicId of turn.atomicScope) {
          runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
          runtime.events.markImplementationDone(atomicId, `implemented in ${seconds}s`);
        }
        if (!splitMode && finishesModule && !failedIds.includes(module.nodeId)) completedIds.push(module.nodeId);
      } else {
        log(`[turn] ${turn.label} FAILED (exit ${result.code}) after ${seconds}s`);
        moduleOk = false;
      }
    }

    let evolutionGateFailed = false;
    controller.phase = "boundary";
    controller.testScope = atomicIds.length ? atomicIds : [module.nodeId];
    {
      const gateLog = path.join(logsDir, `${runStartedAt}-module-${module.index}-gate.log`);
      let gateFailure = await checkEvolutionModule(outputDir, mode === "evolution" ? originalFiles : [], gateLog);
      if (gateFailure && workDeadline - Date.now() >= 60_000) {
        log(`[gate] ${module.nodeId}: ${gateFailure}; starting one repair turn`);
        await runCommand(opencodeBin, ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", EVOLUTION_GATE_REPAIR_PROMPT(gateFailure)], {
          cwd: outputDir,
          env: {
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
          },
          timeoutMs: Math.min(nodeTimeoutMs, workDeadline - Date.now()),
          logFile: path.join(logsDir, `${runStartedAt}-module-${module.index}-gate-repair.log`),
        });
        gateFailure = await checkEvolutionModule(outputDir, mode === "evolution" ? originalFiles : [], gateLog);
      }
      if (gateFailure) {
        log(`[gate] ${module.nodeId}: still failing: ${gateFailure}`);
        moduleOk = false;
        evolutionGateFailed = true;
        moduleCheckpoint.restore();
        for (let i = completedIds.length - 1; i >= 0; i--) if ([module.nodeId, ...atomicIds].includes(completedIds[i])) completedIds.splice(i, 1);
        for (const id of atomicIds) runtime.events.markImplementationFailed(id, "Candidate rejected; previous application checkpoint restored");
        log(`[gate] restored application checkpoint before ${module.nodeId}; incomplete candidate rejected`);
        await checkEvolutionModule(outputDir, mode === "evolution" ? originalFiles : [], gateLog);
      } else {
        log(`[gate] ${module.nodeId}: baseline files present and frontend builds`);
      }
    }

    // Mechanical audit: grep each ATOMIC node's own contract items in the
    // source. Self-assessment inflated ("audit 21/21" on a 1/41 run) - the
    // source of truth is what is actually present in the code. Runs in both
    // initial and evolution modes.
    let doneIds: string[] = [];
    if (atomicNodes.length && !evolutionGateFailed) {
      let audit = auditAtomicsMechanically(outputDir, atomicNodes);
      // Module-boundary seed repair: pre-provisioned objects are cheap to add
      // and every dependent scenario fails at its first step without them.
      // One bounded repair turn per module, then re-audit in place.
      if (mode === "evolution" && audit.missingSeeds.length && !seedRepairsAttempted.has(module.nodeId)
        && workDeadline - Date.now() >= 60_000) {
        seedRepairsAttempted.add(module.nodeId);
        log(`[seed] ${module.nodeId}: ${audit.missingSeeds.length} pre-provisioned identifiers missing from source; boundary repair turn`);
        await runCommand(opencodeBin, ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", SEED_FIX_PROMPT(audit.missingSeeds)], {
          cwd: outputDir,
          env: {
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
          },
          timeoutMs: Math.min(evolutionNodeTimeoutMs, workDeadline - Date.now()),
          logFile: path.join(logsDir, `${runStartedAt}-module-${module.index}-seed-fix.log`),
          heartbeatLabel: `seed repair ${module.nodeId}`,
        });
        audit = auditAtomicsMechanically(outputDir, atomicNodes);
      }
      doneIds = audit.doneIds;
      log(`[audit] ${module.nodeId}: mechanical DONE=${doneIds.join(",") || "none"} (of ${atomicIds.join(",")})`);
      for (const line of audit.report) log(`[audit]   ${line}`);
    } else {
      doneIds = moduleOk ? [module.nodeId] : [];
    }

    for (const atomicId of atomicIds.length ? atomicIds : [module.nodeId]) {
      if (doneIds.includes(atomicId)) {
        // Source inventory is useful feedback, but only executed Judge probes
        // may emit test:passed. In particular, an empty contract proves nothing.
        runtime.events.markImplementationDone(atomicId, "source inventory found contract strings; browser behavior remains unverified");
      }
      // not-done nodes stay untouched (default gray) - honest progress, no false red
    }
    if (doneIds.length) completedIds.push(...doneIds);
    if (mode === "evolution") {
      if (!moduleOk) {
        failedIds.push(module.nodeId);
      } else if (finishesModule && !failedIds.includes(module.nodeId)) {
        runtime.events.markImplementationDone(module.nodeId, "incremental implementation completed; external behavior not yet verified");
        completedIds.push(module.nodeId);
      }
    } else if (atomicIds.length && doneIds.length < atomicIds.length) moduleOk = false;
    if (mode === "initial" && atomicIds.length && doneIds.length === atomicIds.length) {
      // A complete source inventory is an implementation checkpoint only.
      // Independent browser evidence is required before any passed event.
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok (audit ${doneIds.length}/${atomicIds.length})`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
    } else if (mode === "initial" && moduleOk && !atomicIds.length) {
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
    } else if (mode === "initial") {
      // No markImplementationFailed: its "failed" status maps to FAILED state on the
      // canvas. Partial work keeps its implementation state until Judge runs.
      log(`[module ${module.index}/${module.total}] ${module.nodeId} partial (done: ${doneIds.join(",") || "none"})`);
      failedIds.push(module.nodeId);
    }
    runtime.events.notifyTraceabilityChanged(`module ${module.nodeId} finished`);
    // Boundary judge: a 6-minute checkpoint, skipped only when the clock is
    // nearly out. Skipping it entirely (v15) removed the only independent
    // signal for exactly the modules that needed it - the later new-feature
    // modules whose official tests failed while internal probes never ran.
    const boundaryJudgeSkipped = mode === "evolution" && workDeadline - Date.now() < 12 * 60_000;
    if (boundaryJudgeSkipped) log(`[boundary] skipping ${module.nodeId} audit; preserving time for remaining module turns`);
    if (!evolutionGateFailed && !boundaryJudgeSkipped && hasDeliverable(outputDir)) {
      log(`[boundary] independently checking ${module.nodeId} and previously attempted paths`);
      controller.latestReceipt = await verifyWithJudge(runtime, requirementsDir, outputDir, agentRoot, webPort, atomicIds);
      const nextStatuses = new Map(controller.latestReceipt.report.results.map((r) => [r.caseId, r.status]));
      if (previousModulePassed.some((r) => nextStatuses.get(r.caseId) !== "passed") && applicationDigest(outputDir) !== moduleCheckpoint.digest) {
        log(`[boundary] ${module.nodeId} lost previously passing evidence; restoring its application checkpoint`);
        moduleCheckpoint.restore();
        moduleOk = false;
        evolutionGateFailed = true;
        for (let i = completedIds.length - 1; i >= 0; i--) if ([module.nodeId, ...atomicIds].includes(completedIds[i])) completedIds.splice(i, 1);
        if (!failedIds.includes(module.nodeId)) failedIds.push(module.nodeId);
        controller.latestReceipt = await verifyWithJudge(runtime, requirementsDir, outputDir, agentRoot, webPort, atomicIds, false);
      }
    }
    moduleCheckpoint.dispose();
    fs.mkdirSync(path.join(outputDir, ".arc", "controller"), { recursive: true });
    fs.writeFileSync(path.join(outputDir, ".arc", "controller", `${module.nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), JSON.stringify({
      moduleId: module.nodeId, implementationCallCompleted: moduleOk && !evolutionGateFailed,
      diagnosticUsed: controller.diagnostics.has(module.nodeId), checkpointRestored: evolutionGateFailed,
      budget: controller.budget.snapshot(),
      note: "Implementation completion is not independent acceptance; see verification receipts.",
    }, null, 2));
    runtime.git.commit([
      `${module.nodeId} (${moduleOk ? "implement" : "partial"}): ${module.name}`, "",
      `Diagnostic used: ${controller.diagnostics.has(module.nodeId)}. Application checkpoint restored: ${evolutionGateFailed}.`,
      "Record controller receipt and module boundary evidence; source inventory alone does not imply acceptance.",
    ].join("\n"));
    if (evolutionGateFailed) {
      log(`[gate] stopping implementation after ${module.nodeId}; final recovery will handle the remaining failure`);
      break;
    }
  }

  clearInterval(watchdog);
  controller.phase = "delivery";
  controller.testScope = ["delivery"];
  const deliveryCheckpoint = new Checkpoint(outputDir, controller.privateDir);
  const previousPassed = controller.latestReceipt?.report.results.filter((r) => r.status === "passed") || [];

  // FINAL_CHECK: strict-mode self-audit pass.
  // Fresh session: it must audit the whole app with its own eyes, and a fresh
  // session also avoids re-carrying every module's transcript.
  log("[final-check] strict-mode audit");
  const finalArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto"];
  finalArgv.push(FINAL_CHECK_PROMPT(webPort, mode, requirementsDir));
  await runCommand(opencodeBin, finalArgv, {
    cwd: outputDir,
    env: {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
    },
    timeoutMs: Math.min(nodeTimeoutMs, 10 * 60 * 1000),
    logFile: path.join(logsDir, `${runStartedAt}-final-check.log`),
    heartbeatLabel: "final-check",
  });

  // VERBATIM LINT: mechanical check of requirement quoted strings vs source.
  // Fixes "Create an organization" vs "Create organization" class of failures
  // that cost score on anchored-regex text matches (run 019f6c601311).
  const verbatim = mode === "initial" ? extractVerbatimStrings(modules.map((m) => m.subtree)) : new Set<string>();
  const missing = mode === "initial" ? lintVerbatim(outputDir, verbatim) : [];
  const navOffenders = mode === "initial" ? lintNavStyle(outputDir) : [];
  log(`[verbatim] ${verbatim.size} contractual strings, ${missing.length} missing${missing.length ? `: ${missing.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}${missing.length > 8 ? " ..." : ""}` : ""}`);
  if (navOffenders.length) log(`[lint] router-Link offenders: ${navOffenders.slice(0, 6).join(", ")}${navOffenders.length > 6 ? " ..." : ""}`);
  if (missing.length || navOffenders.length) {
    log(`[verbatim] sending fix turn (strings=${missing.length}, nav=${navOffenders.length})`);
    const fixArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", VERBATIM_FIX_PROMPT(missing, navOffenders)];
    await runCommand(opencodeBin, fixArgv, {
      cwd: outputDir,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
      },
      timeoutMs: nodeTimeoutMs,
      logFile: path.join(logsDir, `${runStartedAt}-verbatim-fix.log`),
      heartbeatLabel: "verbatim-fix",
    });
    const retry = lintVerbatim(outputDir, verbatim);
    log(`[verbatim] after fix: ${retry.length} still missing${retry.length ? `: ${retry.slice(0, 5).map((s) => JSON.stringify(s)).join(", ")}` : ""}`);
  }

  // SEED LINT (evolution): the scenarios assume a set of pre-provisioned
  // objects already exist. Check the inherited application actually seeds each
  // one; a missing seed makes every dependent probe fail at its first step.
  if (mode === "evolution") {
    const seedIds = [...new Set(modules.flatMap((m) => extractTaskContract(m.subtree).seedIdentifiers))];
    const missingSeeds = lintVerbatim(outputDir, new Set(seedIds));
    log(`[seed] ${seedIds.length} pre-provisioned identifiers, ${missingSeeds.length} missing${missingSeeds.length ? `: ${missingSeeds.slice(0, 10).map((s) => JSON.stringify(s)).join(", ")}${missingSeeds.length > 10 ? " ..." : ""}` : ""}`);
    if (missingSeeds.length) {
      log("[seed] sending seed provisioning fix turn");
      await runCommand(opencodeBin, ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", SEED_FIX_PROMPT(missingSeeds)], {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: nodeTimeoutMs,
        logFile: path.join(logsDir, `${runStartedAt}-seed-fix.log`),
        heartbeatLabel: "seed-fix",
      });
      const retry = lintVerbatim(outputDir, new Set(seedIds));
      log(`[seed] after fix: ${retry.length} still missing${retry.length ? `: ${retry.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}` : ""}`);
    }
  }

  // Re-inventory after fixes. Finding source strings never proves behavior.
  if (mode === "initial") {
    const allAtomics: Record<string, unknown>[] = [];
    for (const m of modules) collectAtomicNodes(m.subtree, allAtomics);
    if (allAtomics.length) {
      const { doneIds: finalDone, report } = auditAtomicsMechanically(outputDir, allAtomics);
      log(`[audit] final source inventory: ${finalDone.length}/${allAtomics.length} contain extracted contract strings; behavior unverified`);
      for (const line of report) log(`[audit]   ${line}`);
      for (const node of allAtomics) {
        const id = String(node.id || "").trim();
        if (id && finalDone.includes(id)) {
          runtime.events.markImplementationDone(id, "contract strings present in source; awaiting independent browser verification");
        }
      }
    }
  }

  postflightLift(outputDir);
  if (mode === "initial") ensureDockerfile(outputDir);

  // REHEARSAL: build + startup probe BEFORE the platform's own
  // evaluation. A failed build scores 0 on every test; one repair turn is cheap.
  if (process.env.TORINE_SKIP_REHEARSAL !== "1") {
    const rehearsalLog = path.join(logsDir, `${runStartedAt}-rehearsal.log`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      log(`[rehearsal] attempt ${attempt}: frontend build`);
      const install = await npmInstall(path.join(outputDir, "frontend"), 10 * 60 * 1000, rehearsalLog);
      let failure = install.code === 0 ? null : `frontend npm install exit ${install.code}`;
      if (!failure) {
        const build = await runCommand("npm", ["run", "build"], {
          cwd: path.join(outputDir, "frontend"),
          timeoutMs: 10 * 60 * 1000,
          logFile: rehearsalLog,
        });
        failure = build.code === 0 ? null : `frontend npm run build exit ${build.code}`;
      }
      if (!failure) {
        log("[rehearsal] backend HTTP readiness probe on an isolated random port");
        const backendInstall = await npmInstall(path.join(outputDir, "backend"), 10 * 60 * 1000, rehearsalLog);
        if (backendInstall.code === 0) {
          failure = await rehearseBackend(path.join(outputDir, "backend"), 3100);
        } else {
          failure = `backend npm install exit ${backendInstall.code}`;
        }
      }
      if (!failure) {
        log("[rehearsal] app builds and starts cleanly");
        break;
      }
      log(`[rehearsal] FAILED: ${failure}`);
      if (attempt >= 2) break;
      log("[rehearsal] sending repair turn");
      const repairArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", "--continue", REPAIR_PROMPT(failure)];
      await runCommand(opencodeBin, repairArgv, {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: nodeTimeoutMs,
        logFile: path.join(logsDir, `${runStartedAt}-rehearsal-repair.log`),
      });
    }
    runtime.git.commit("chore: record delivery rehearsal attempt; independent verification follows");
  }

  const finalReceipt = await verifyWithJudge(runtime, requirementsDir, outputDir, agentRoot, webPort);
  if (previousPassed.some((old) => !finalReceipt.report.results.some((r) => r.caseId === old.caseId && r.status === "passed"))
    && deliveryCheckpoint.digest !== applicationDigest(outputDir)) {
    deliveryCheckpoint.restore();
    log("[delivery] rejected final edits that lost or could not revalidate previous success; restored runnable checkpoint");
    await verifyWithJudge(runtime, requirementsDir, outputDir, agentRoot, webPort);
  }
  deliveryCheckpoint.dispose();

  log(`[budget] ${JSON.stringify(controller.budget.snapshot())}`);
  log(`[done] completed=${completedIds.join(",") || "none"} failed=${failedIds.join(",") || "none"}`);
  if (!hasDeliverable(outputDir)) {
    log("[done] ERROR: deliverable layout incomplete");
    process.exitCode = 1;
  }
}

async function verifyWithJudge(runtime: AgentRuntime, requirementsDir: string, outputDir: string, agentRoot: string, webPort: number, scopeIds?: string[], allowRepair = true): Promise<JudgeReceipt> {
  if (!hasDeliverable(outputDir)) throw new Error("Judge requires an existing frontend/ and backend/ application");
  const configPath = writeOpencodeConfig(agentRoot);
  const opencodeBin = resolveOpencodeBin(agentRoot);
  const { providerId, modelId } = modelSpec();
  const context = controller;
  const receipt = await runJudgePhase({
    ...(context ? { scopeIds, session: context.session, evidenceRoot: path.join(context.privateDir, "judge"),
      // A scoped (module-boundary) judge must stay a checkpoint, not a second
      // implementation phase: cap it so probes + one repair cannot eat the
      // implementation budget of the remaining modules (run 1cabd30e4df7:
      // boundary judge consumed ~26 of 30 implementation minutes).
      deadline: Date.now() + Math.min(context.budget.remaining(context.phase), scopeIds ? 6 * 60_000 : 12 * 60_000),
      takePlan: () => context.budget.takePlan(context.phase),
      // Delivery (no scopeIds) gets two repair rounds: the official tests run
      // once at the end, so a failing feature must be fixed now or never.
      maxRepairs: allowRepair ? (scopeIds ? 1 : 2) : 0 } : {}),
    requirementsDir, outputDir, agentRoot, evaluationPort: webPort, modelId,
    log, command: runCommand,
    repair: async (prompt, timeoutMs, logFile, failedScope) => {
      const previousScope = context?.testScope;
      if (context && failedScope?.length) context.testScope = failedScope;
      try { return await runCommand(opencodeBin, [
      "run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--auto", prompt,
    ], {
      cwd: outputDir,
      env: { OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`) },
      timeoutMs, logFile, heartbeatLabel: "judge repair",
    }); } finally { if (context) context.testScope = previousScope; }
    },
    recordState: (id, state, message) => {
      if (state === "passed") runtime.events.markTestPassed(id, message);
      else if (state === "failed") runtime.events.markTestFailed(id, message);
      else if (!context || context.session.seenIds.has(id) || scopeIds?.includes(id)) runtime.traceability.upsertNodeState(id, "IMPLEMENTED", "implement");
    },
  });
  runtime.events.notifyTraceabilityChanged("independent requirement-derived Judge phase finished; see .arc/controller verification receipts");
  if (context) {
    const publicRoot = path.join(outputDir, ".arc", "controller"); fs.mkdirSync(publicRoot, { recursive: true });
    fs.writeFileSync(path.join(publicRoot, `verification-${Date.now()}-${randomUUID()}.json`), JSON.stringify({
      scopeIds: scopeIds || "final", states: receipt.states,
      cases: receipt.report.results.map(({ caseId, requirementId, status, failureKind }) => ({ caseId, requirementId, status, failureKind })),
      infrastructureError: Boolean(receipt.report.infrastructureError), budget: context.budget.snapshot(),
    }, null, 2));
  }
  runtime.git.commit([
    "chore: checkpoint application after independent Judge verification",
    "",
    "Record the independent public-requirement verification phase and any bounded application repair.",
    "Probe execution uses isolated application copies to preserve baseline data in the deliverable.",
    `Judge summary: ${receipt.summaryPath}. This checkpoint does not imply official acceptance.`,
  ].join("\n"));
  return receipt;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = AgentRuntime.fromEnv({ projectDir: path.resolve(args.outputDir) });
  const requirementsDir = path.resolve(args.requirementPath);
  const outputDir = path.resolve(args.outputDir);
  const agentRoot = path.dirname(fileURLToPath(import.meta.url));
  if (!fs.existsSync(requirementsDir)) throw new Error(`Requirement directory not found: ${requirementsDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  if (args.judgeOnly) {
    runtime.traceability.initDb();
    runtime.git.ensureRepo();
    await verifyWithJudge(runtime, requirementsDir, outputDir, agentRoot, args.webPort);
  } else {
    await runAgent(runtime, requirementsDir, outputDir, agentRoot, args.webPort);
  }
  // The platform blocks evaluation until our process exits. Any stray child
  // handle (grandchild server, orphaned pipe) must not keep us alive - force
  // exit after flushing (run a9a88145e0f4 hung 6h on this). Exit is deferred
  // through the write callbacks because pipe-mode stdout is async and a
  // synchronous process.exit() would truncate the final [done] log lines.
  const code = process.exitCode ?? 0;
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code));
  });
  const failsafe = setTimeout(() => process.exit(code), 2000);
  failsafe.unref?.();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
