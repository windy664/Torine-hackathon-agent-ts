import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(directory, "agent.zip"))) throw new Error("Usage: tsx tests/validate-candidate.ts CANDIDATE_DIRECTORY (already unpacked and npm ci completed)");
const unpacked = path.join(directory, "unpacked"), reports = path.join(directory, "validation"); fs.mkdirSync(reports, { recursive: true });
if (fs.lstatSync(path.join(unpacked, "node_modules")).isSymbolicLink()) throw new Error("Candidate validation requires independent dependencies, not a shared node_modules symlink");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const file of ["index.ts", "package.json", "package-lock.json", ...fs.readdirSync(path.join(repo, "evolution")).map(name => `evolution/${name}`)]) {
  if (hash(path.join(repo, file)) !== hash(path.join(unpacked, file))) throw new Error(`Candidate differs from source: ${file}`);
}
// Run test imports from the unpacked candidate too. Executing worktree tests
// with a candidate tsx binary still resolves worktree node_modules, hiding
// lockfile/runtime mismatches. Tests are verification-only, not ZIP contents.
fs.cpSync(path.join(repo, "tests"), path.join(unpacked, "tests"), { recursive: true });
const env = { ...process.env, TORINE_AGENT_ROOT: unpacked, TORINE_PLAYWRIGHT_MODULE: path.join(unpacked, "node_modules/playwright"), TORINE_PLAYWRIGHT_ASSERT: path.join(unpacked, "node_modules/playwright/test.js") };
const steps = [
  { name: "typecheck", binary: path.join(unpacked, "node_modules/.bin/tsc"), args: ["--noEmit"], cwd: unpacked },
  { name: "unit-browser", binary: path.join(unpacked, "node_modules/.bin/tsx"), args: ["--test", ...fs.readdirSync(path.join(unpacked, "tests")).filter(name => name.endsWith(".test.ts")).map(name => path.join(unpacked, "tests", name))], cwd: unpacked },
  { name: "protocol", binary: path.join(unpacked, "node_modules/.bin/tsx"), args: [path.join(unpacked, "tests/protocol-smoke.ts")], cwd: unpacked },
  { name: "devtools-protocol", binary: path.join(unpacked, "node_modules/.bin/tsx"), args: [path.join(unpacked, "tests/devtools-protocol.ts")], cwd: unpacked },
  { name: "controller", binary: path.join(unpacked, "node_modules/.bin/tsx"), args: [path.join(unpacked, "tests/controller-smoke.ts")], cwd: unpacked },
  { name: "entrypoint", binary: path.join(unpacked, "node_modules/.bin/tsx"), args: [path.join(unpacked, "tests/entrypoint-smoke.ts")], cwd: unpacked },
];
const results = [];
for (const step of steps) {
  const started = Date.now(); console.log(`Validating ${step.name}...`);
  const logFile = path.join(reports, `${step.name}.log`);
  fs.writeFileSync(logFile, "", { mode: 0o600 });
  const result = await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(step.binary, step.args, { cwd: step.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      fs.appendFileSync(logFile, chunk); output = (output + chunk.toString()).slice(-200_000);
    });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, step.name === "entrypoint" ? 12 * 60_000 : 180_000);
    child.on("error", error => output += String(error));
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  results.push({ name: step.name, code: result.code, durationMs: Date.now() - started, log: `${step.name}.log` });
  console.log(`${step.name}: ${result.code === 0 ? "PASS" : "FAIL"}`);
  if (result.code !== 0) { console.log(result.output.slice(-4000)); break; }
}
const report = { zipSha256: hash(path.join(directory, "agent.zip")), runtimeFilesMatchSource: true, cleanDependencyInstall: "npm ci performed in unpacked candidate before this runner", realModelRequests: 0, platformSubmitted: false, results, completed: new Date().toISOString() };
fs.writeFileSync(path.join(reports, "result.json"), JSON.stringify(report, null, 2) + "\n");
if (results.length !== steps.length || results.some(result => result.code !== 0)) process.exitCode = 1;
console.log(JSON.stringify(report));
