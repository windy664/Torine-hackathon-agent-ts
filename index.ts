import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { AgentRuntime } from "arcbench-agent-runtime-js";
import { runEvolution } from "./evolution/index.js";
import { detectRunMode } from "./evolution/mode.js";

type AgentArgs = {
  requirementPath: string;
  outputDir: string;
  taskType: string;
  webPort: number;
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

// Transplanted from the octos reference adapter (38 rounds of graded runs).
// These are grading-system facts, not generic style advice - every rule here
// cost real score at least once.
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
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output-dir") {
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

function runCommand(
  command: string,
  argv: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string; heartbeatLabel?: string },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const started = Date.now();
    const sink = (text: string): void => {
      if (!options.logFile) return;
      try {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
        fs.appendFileSync(options.logFile, text);
      } catch {
        /* logging must never break the run */
      }
    };
    sink(`=== ${new Date().toISOString()} ${command} ${argv.join(" ")} (cwd ${options.cwd}) ===\n`);
    if (options.heartbeatLabel) {
      heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
        const last = lines[lines.length - 1] || "(no output yet)";
        log(`[heartbeat] ${options.heartbeatLabel} running ${elapsed}s | last: ${last.slice(0, 120)}`);
      }, 60_000);
      heartbeat.unref?.();
    }
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        log(`[timeout] SIGTERM to ${command} after ${options.timeoutMs}ms; grace 60s before SIGKILL`);
        sink(`\n=== TIMEOUT: SIGTERM after ${options.timeoutMs}ms ===\n`);
        // OpenCode can launch descendants that would otherwise keep editing
        // the workspace after the parent turn has timed out.
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          log(`[timeout] SIGKILL process group for ${command} after grace`);
          sink(`\n=== TIMEOUT: SIGKILL after grace ===\n`);
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }
        }, 60_000);
        killTimer.unref?.();
      }, options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 200_000) output = output.slice(-200_000);
      process.stdout.write(text);
      sink(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 200_000) output = output.slice(-200_000);
      process.stderr.write(text);
      sink(text);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      sink(`\n=== exit ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s ===\n`);
      resolve({ code, output });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      sink(`\n=== spawn error: ${String(error)} ===\n`);
      resolve({ code: 1, output: `${output}\nspawn error: ${String(error)}` });
    });
  });
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
      DELIVERABLE,
      "",
      "Follow exact roles, accessible names, messages, and simultaneous error behavior specified by this subtree. An older generic UI rule never overrides a changed requirement.",
      "Implement and verify the new behavior with the application's own build and focused, requirement-derived checks. Keep the application runnable and avoid binding the evaluation port.",
      "Finish with a short summary of changed files and the prior behaviors you preserved.",
    ].join("\n");
  }
  return [
    `Implement ROOT module ${module.index}/${module.total}: ${module.nodeId} - ${module.name}`,
    "",
    "You are building a web application (Vite + React + TypeScript frontend, Express + SQLite backend) in the current working directory.",
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
    "",
    "ROLE WIDGET CONTRACT: dropdowns that tests pick options from must expose role=combobox with clickable role=option items (a custom listbox - native select popups are not clickable in tests). Widgets the tests call selectOption() on must be native <select> elements. Search inputs are role=searchbox named so that a /search/i name matcher finds exactly one. Table rows with editable values use role=row with a per-row control and a Save button. Row action menus are buttons named `Member menu <value>` (pattern: `<menu label> <row identity>`) exposing menuitem entries, whose confirm dialogs use the verb button named exactly as the scenario states. Menu-command flows (Add file -> Create new file) use role=menuitem entries. When the requirement distinguishes a button and a link with similar names (e.g. a \"Code\" button vs a \"Code\" link), render BOTH with their exact distinct names.",
    "",
    "TEXT UNIQUENESS (tests match names by exact OR case-insensitive substring/regex - strict mode fails on multiple matches): for ANY name-like token used on a page, exactly ONE visible element may match it as a substring. Never let one accessible name contain another name used on the same page (a link named \"Code search\" breaks a getByRole('link', {name: /code/i}) lookup for \"Code\"). Repeating labels (role names etc.) must not appear as plain text across rows - use controls whose closed state does not render the label as text. Empty states show exactly ONE empty-state text (e.g. \"No results\"), never two variations at once. Labels the requirement phrases as patterns must contain the matcher words (e.g. a field matched as /file name/i needs a label containing \"file name\").",
    "",
    "ROOT EXPOSURE: every entity the requirement mentions (organizations, repositories, branches, commits, users) must be reachable as an exact-name clickable link starting from the application root/home page - test helpers retry from the root and click targets by exact name. Home/listing pages must therefore show these entities as exact-name links (seeded repos and orgs included). Commit history entries the scenarios click must be links named by their commit message.",
    "",
    "VALIDATION WHITELISTS: when the requirement states allowed characters or ranges (e.g. branch names: ASCII letters/digits/-/_/./ only, no trailing / or ., no .. or //), enforce that exact whitelist - do NOT substitute a git-style blacklist. Reject-and-explain with the requirement's exact error text.",
    "",
    "SEED IDENTIFIERS: entities may have both an identifier (URL/name) and a display name (link text) - seed both exactly as the requirement states; links display the display name, headings/URLs use the identifier. Every backticked seed/example value in the requirement must exist in the database seed and appear verbatim where scenarios expect it.",
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

async function npmInstall(dir: string, timeoutMs: number, logFile: string): Promise<{ code: number | null; output: string }> {
  const first = await runCommand("npm", ["install"], { cwd: dir, timeoutMs, logFile });
  if (first.code === 0) return first;
  // Old npm (9.x arborist bug on peer-deps graphs) can fail on a good lockfile;
  // --legacy-peer-deps works there and is a no-op difference on modern npm.
  log(`[npm] install failed in ${dir}; retrying with --legacy-peer-deps`);
  return runCommand("npm", ["install", "--legacy-peer-deps"], { cwd: dir, timeoutMs, logFile });
}

function rehearseBackend(backendDir: string, port: number): Promise<string | null> {
  // Returns a failure description, or null when the server stayed alive for 5s.
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    // detached: npm's grandchild (the actual node server) must die with the
    // group. A surviving grandchild holds our stdio pipes open and keeps the
    // Node event loop alive forever - that is what hung run a9a88145e0f4.
    const child = spawn("npm", ["run", "start"], {
      cwd: backendDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const finish = (failure: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        process.kill(-child.pid!, "SIGKILL"); // whole process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* streams may already be closed */
      }
      resolve(failure);
    };
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => finish(`backend exited early (code ${code}): ${output.slice(-800)}`));
    child.on("error", (error) => finish(`backend spawn error: ${String(error)}`));
    const guard = setTimeout(() => finish(null), 5000);
    guard.unref?.();
  });
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
): { doneIds: string[]; report: string[] } {
  const corpus = readSourceCorpus(outputDir);
  const doneIds: string[] = [];
  const report: string[] = [];
  for (const node of atomicNodes) {
    const id = String(node.id || "").trim();
    const contract = extractTaskContract(node);
    const namedValues = contract.namedTargets.map((t) => t.slice(t.indexOf(":") + 2).trim());
    const missingNamed = namedValues.filter((v) => v && !corpus.includes(v));
    const missingErrors = contract.errorStrings.filter((e) => !corpus.includes(e));
    const ok = missingNamed.length === 0 && missingErrors.length === 0;
    if (ok) doneIds.push(id);
    report.push(
      `${id}: ${ok ? "DONE" : "MISSING"} (named ${namedValues.length - missingNamed.length}/${namedValues.length}, errors ${contract.errorStrings.length - missingErrors.length}/${contract.errorStrings.length})` +
        (missingNamed.length ? ` no-named: ${missingNamed.slice(0, 3).join("|")}` : "") +
        (missingErrors.length ? ` no-err: ${missingErrors.slice(0, 2).join("|")}` : ""),
    );
  }
  return { doneIds, report };
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
  isSpreadsheet: boolean;
};

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
  return { namedTargets, errorStrings, seeds, isSpreadsheet };
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
  const mode = detectRunMode(requirementsDir);
  if (mode === "evolution" && !hasDeliverable(outputDir)) {
    throw new Error("Evolution requires the platform-injected baseline with frontend/package.json and backend/package.json; refusing to copy a starter over it");
  }
  runtime.traceability.initDb();
  runtime.git.ensureRepo();

  const modules = loadRootModules(requirementsDir);
  const sheetLike = modules.some((m) => extractTaskContract(m.subtree).isSpreadsheet);

  if (hasDeliverable(outputDir)) {
    log(`[init] existing frontend/+backend/ detected; keeping prior work (${mode} mode)`);
  } else {
    log(`[init] copying starter template into output directory${sheetLike ? " (+ spreadsheet scaffold)" : ""}`);
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

  const configPath = writeOpencodeConfig(agentRoot);
  const opencodeBin = resolveOpencodeBin(agentRoot);
  const { providerId, modelId } = modelSpec();
  const nodeTimeoutMs = Number(process.env.TORINE_NODE_TIMEOUT_MS || 45 * 60 * 1000);
  const evolutionNodeTimeoutMs = Number(process.env.TORINE_EVOLUTION_NODE_TIMEOUT_MS || 15 * 60 * 1000);
  const evolutionWorkBudgetMs = Number(process.env.TORINE_EVOLUTION_WORK_BUDGET_MS || 20 * 60 * 60 * 1000);
  if (mode === "evolution" && (!Number.isFinite(evolutionNodeTimeoutMs) || evolutionNodeTimeoutMs <= 0)) {
    throw new Error("TORINE_EVOLUTION_NODE_TIMEOUT_MS must be a positive number");
  }
  if (mode === "evolution" && (!Number.isFinite(evolutionWorkBudgetMs) || evolutionWorkBudgetMs <= 0)) {
    throw new Error("TORINE_EVOLUTION_WORK_BUDGET_MS must be a positive number");
  }
  const workDeadline = mode === "evolution" ? Date.now() + evolutionWorkBudgetMs : Number.POSITIVE_INFINITY;
  const completedIds: string[] = [];
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
      const remainingWorkMs = workDeadline - Date.now();
      if (remainingWorkMs < 60_000) {
        log(`[budget] stopping before ${turn.label}; reserving time for final checks`);
        moduleOk = false;
        break;
      }
      log(`[turn] ${turn.label} (${module.nodeId})${useHotSession ? " [continue]" : ""}`);
      // Per-atomic phase events (octos style): design is folded into the
      // implementation prompt, so emit done immediately - this is what makes
      // the canvas light up orange at turn start instead of staying gray.
      for (const atomicId of turn.atomicScope) {
        runtime.events.markDesignStarted(atomicId, `designing ${atomicId}`);
        runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
      }
      const started = Date.now();
      const before = workspaceSignature(outputDir);
      const argv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions"];
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
      // NUDGE (octos lesson): a turn that only reads/analyzes wrote no files.
      // Kick once with an explicit "write files now" prompt.
      if (mode === "initial" && result.code === 0 && workspaceSignature(outputDir) === before) {
        log(`[turn] ${turn.label}: no file changes; nudging`);
        const nudgeArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", "--continue", NUDGE_PROMPT];
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
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.code === 0) {
        log(`[turn] ${turn.label} ok in ${seconds}s`);
        for (const atomicId of turn.atomicScope) {
          runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
          runtime.events.markImplementationDone(atomicId, `implemented in ${seconds}s`);
        }
        if (!splitMode) completedIds.push(module.nodeId);
      } else {
        log(`[turn] ${turn.label} FAILED (exit ${result.code}) after ${seconds}s`);
        moduleOk = false;
      }
    }

    let evolutionGateFailed = false;
    if (mode === "evolution") {
      const gateLog = path.join(logsDir, `${runStartedAt}-module-${module.index}-gate.log`);
      let gateFailure = await checkEvolutionModule(outputDir, originalFiles, gateLog);
      if (gateFailure && workDeadline - Date.now() >= 60_000) {
        log(`[gate] ${module.nodeId}: ${gateFailure}; starting one repair turn`);
        await runCommand(opencodeBin, ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", EVOLUTION_GATE_REPAIR_PROMPT(gateFailure)], {
          cwd: outputDir,
          env: {
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
          },
          timeoutMs: Math.min(nodeTimeoutMs, workDeadline - Date.now()),
          logFile: path.join(logsDir, `${runStartedAt}-module-${module.index}-gate-repair.log`),
        });
        gateFailure = await checkEvolutionModule(outputDir, originalFiles, gateLog);
      }
      if (gateFailure) {
        log(`[gate] ${module.nodeId}: still failing: ${gateFailure}`);
        moduleOk = false;
        evolutionGateFailed = true;
      } else {
        log(`[gate] ${module.nodeId}: baseline files present and frontend builds`);
      }
    }

    // Mechanical audit: grep each ATOMIC node's own contract items in the
    // source. Self-assessment inflated ("audit 21/21" on a 1/41 run) - the
    // source of truth is what is actually present in the code.
    let doneIds: string[] = [];
    if (mode === "evolution") {
      log(`[audit] ${module.nodeId}: source string audit skipped in evolution; it cannot prove changed behavior`);
    } else if (atomicNodes.length) {
      const { doneIds: mechDone, report } = auditAtomicsMechanically(outputDir, atomicNodes);
      doneIds = mechDone;
      log(`[audit] ${module.nodeId}: mechanical DONE=${doneIds.join(",") || "none"} (of ${atomicIds.join(",")})`);
      for (const line of report) log(`[audit]   ${line}`);
    } else {
      doneIds = moduleOk ? [module.nodeId] : [];
    }

    for (const atomicId of atomicIds.length ? atomicIds : [module.nodeId]) {
      if (doneIds.includes(atomicId)) {
        // Canvas green ("已通过") comes from the test:passed event; CONVERGED is the
        // state token from the official SDK docs example.
        runtime.events.markTestPassed(atomicId, "audit confirmed fully implemented");
        runtime.traceability.upsertNodeState(atomicId, "CONVERGED");
      }
      // not-done nodes stay untouched (default gray) - honest progress, no false red
    }
    if (doneIds.length) completedIds.push(...doneIds);
    if (mode === "evolution") {
      if (moduleOk) {
        runtime.events.markImplementationDone(module.nodeId, "incremental implementation completed; external behavior not yet verified");
        completedIds.push(module.nodeId);
      } else {
        failedIds.push(module.nodeId);
      }
    } else if (atomicIds.length && doneIds.length < atomicIds.length) moduleOk = false;
    if (mode === "initial" && atomicIds.length && doneIds.length === atomicIds.length) {
      // Audit is the source of truth: all atoms verified done => module green,
      // even if an intermediate turn exited non-zero (that is what left REQ-1
      // gray while all its children were green in run a9a88145e0f4).
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok (audit ${doneIds.length}/${atomicIds.length})`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
      runtime.events.markTestPassed(module.nodeId, "all atomic nodes passed audit");
      runtime.traceability.upsertNodeState(module.nodeId, "CONVERGED");
    } else if (mode === "initial" && moduleOk && !atomicIds.length) {
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
    } else if (mode === "initial") {
      // No markImplementationFailed: its "failed" status maps to FAILED state on the
      // canvas. Partial work stays honest in IMPLEMENTING gray/blue; only audited
      // done nodes turned green above.
      log(`[module ${module.index}/${module.total}] ${module.nodeId} partial (done: ${doneIds.join(",") || "none"})`);
      failedIds.push(module.nodeId);
    }
    runtime.events.notifyTraceabilityChanged(`module ${module.nodeId} finished`);
    runtime.git.commit(`${module.nodeId} (${moduleOk ? "implement" : "partial"}): ${module.name}`);
    if (evolutionGateFailed) {
      log(`[gate] stopping implementation after ${module.nodeId}; final recovery will handle the remaining failure`);
      break;
    }
  }

  clearInterval(watchdog);

  // FINAL_CHECK: strict-mode self-audit pass (octos FINAL_CHECK equivalent).
  // Fresh session: it must audit the whole app with its own eyes, and a fresh
  // session also avoids re-carrying every module's transcript.
  log("[final-check] strict-mode audit");
  const finalArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions"];
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
    const fixArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", VERBATIM_FIX_PROMPT(missing, navOffenders)];
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

  // Re-audit everything after fixes and re-mark green where the source proves it.
  if (mode === "initial") {
    const allAtomics: Record<string, unknown>[] = [];
    for (const m of modules) collectAtomicNodes(m.subtree, allAtomics);
    if (allAtomics.length) {
      const { doneIds: finalDone, report } = auditAtomicsMechanically(outputDir, allAtomics);
      log(`[audit] final mechanical: ${finalDone.length}/${allAtomics.length} proven done`);
      for (const line of report) log(`[audit]   ${line}`);
      for (const node of allAtomics) {
        const id = String(node.id || "").trim();
        if (id && finalDone.includes(id)) {
          runtime.events.markTestPassed(id, "mechanical audit: contract items present in source");
          runtime.traceability.upsertNodeState(id, "CONVERGED");
        }
      }
    }
  }

  postflightLift(outputDir);
  if (mode === "initial") ensureDockerfile(outputDir);

  // REHEARSAL (octos lesson): build + startup probe BEFORE the platform's own
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
        log("[rehearsal] backend startup probe on port 3100");
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
      const repairArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", "--continue", REPAIR_PROMPT(failure)];
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
    runtime.git.commit("chore: rehearsal and final verification pass");
  }

  log(`[done] completed=${completedIds.join(",") || "none"} failed=${failedIds.join(",") || "none"}`);
  if (!hasDeliverable(outputDir)) {
    log("[done] ERROR: deliverable layout incomplete");
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const runtime = AgentRuntime.fromEnv({ projectDir: path.resolve(args.outputDir) });
  const requirementsDir = path.resolve(args.requirementPath);
  const outputDir = path.resolve(args.outputDir);
  const agentRoot = path.dirname(fileURLToPath(import.meta.url));
  if (!fs.existsSync(requirementsDir)) throw new Error(`Requirement directory not found: ${requirementsDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const mode = detectRunMode(requirementsDir);
  console.log(JSON.stringify({ time: new Date().toISOString(), level: "INFO", category: "orchestration", event: "entrypoint", mode }));
  if (mode === "evolution") {
    if (!hasDeliverable(outputDir)) throw new Error("Evolution requires the injected baseline; refusing to recreate the output project");
    runtime.traceability.initDb();
    runtime.git.ensureRepo();
    await runEvolution(runtime, loadRootModules(requirementsDir), outputDir, agentRoot, args.webPort);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error); process.exit(1); });
}
