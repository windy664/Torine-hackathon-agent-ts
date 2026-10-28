import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { EventLog } from "../evolution/events.js";
import { buildApp, runCases, type Plan } from "../evolution/checks.js";

test("real browser detects an injected assertion failure, verifies persistence and leaves original data untouched", { timeout: 40_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "torine-browser-test-"));
  const workspace = path.join(temp, "app");
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/app");
  fs.cpSync(source, workspace, { recursive: true });
  const data = path.join(workspace, "backend/data.json"); fs.writeFileSync(data, JSON.stringify({ name: "Original" }));
  const before = createHash("sha256").update(fs.readFileSync(data)).digest("hex");
  const log = new EventLog(path.join(temp, "logs"));
  const build = await buildApp(workspace, log, Date.now() + 20_000); assert.equal(build.state, "passed", build.detail);
  const plan: Plan = { cases: [{ id: "save-reload", kind: "evolution", sourceQuote: "A saved name survives reload", steps: [
    { action: "goto", path: "/" }, { action: "value", target: { label: "Name" }, expected: "Original" },
    { action: "fill", target: { label: "Name" }, value: "Updated" }, { action: "click", target: { role: "button", name: "Save" } },
    { action: "text", target: { role: "status", name: "" }, expected: "Saved" }, { action: "reload" }, { action: "value", target: { label: "Name" }, expected: "Updated" },
  ] }, { id: "injected-failure", kind: "regression", sourceQuote: "Failure cannot be self-reported as passed", steps: [
    { action: "goto", path: "/" }, { action: "value", target: { label: "Name" }, expected: "Deliberately wrong" },
  ] }] };
  try {
    const results = await runCases(workspace, plan, log, Date.now() + 20_000);
    assert.equal(results[0].state, "passed", results[0].detail); assert.equal(results[1].state, "product_failed", results[1].detail);
    assert.equal(createHash("sha256").update(fs.readFileSync(data)).digest("hex"), before);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
