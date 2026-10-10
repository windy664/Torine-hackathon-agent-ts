import assert from "node:assert/strict";
import test from "node:test";
import { buildJudgePackets, parseProbePlan, judgeRequirementStates, localPath, isEvolutionRequirement, fatalGatewayError } from "../judge-plan.js";
import { fixtureRoot, fixturePlan } from "./judge-fixture.js";

test("validates a requirement-backed plan with precise scenario and assertion coverage", () => {
  const packet = buildJudgePackets(fixtureRoot())[0];
  const plan = parseProbePlan(JSON.stringify(fixturePlan(packet)), packet);
  assert.equal(plan.cases.length, 4);
  assert.deepEqual(plan.uncovered, []);
  const passed = plan.cases.map((c) => ({ caseId: c.id, requirementId: c.requirementId, scenarioId: c.scenarioId, status: "passed" as const }));
  assert.deepEqual(judgeRequirementStates([packet], [plan], passed), { "REQ-1": "passed" });
  assert.equal(judgeRequirementStates([packet], [plan], passed.slice(1))["REQ-1"], "unverified");
  assert.equal(judgeRequirementStates([packet], [plan], [{ ...passed[0], status: "failed" }])["REQ-1"], "failed");
});

test("rejects fabricated evidence, cross-scenario assertions, executable operations and unsafe navigation", () => {
  const packet = buildJudgePackets(fixtureRoot())[0];
  for (const mutate of [
    (p: any) => { p.cases[0].expectationBasis = ["a completely invented requirement"]; },
    (p: any) => { p.cases[0].outcomeChecks[0].assertionIndexes = [1]; },
    (p: any) => { p.cases[0].scenarioId = "REQ-unpublished#1"; },
    (p: any) => { p.cases[0].outcomeChecks[0].outcomeId = "REQ-1#2:then-3"; },
    (p: any) => { p.cases[0].steps[1].op = "evaluate"; },
    (p: any) => { p.cases[0].steps[1].locator = { by: "css", text: "#name" }; },
    (p: any) => { p.cases[0].steps[0].value = "//external.test/"; },
    (p: any) => { p.cases[0].steps[0].value = "/\\external.test/"; },
    (p: any) => { p.cases[0].steps[1].locator.first = true; },
  ]) {
    const raw = fixturePlan(packet); mutate(raw);
    assert.throws(() => parseProbePlan(JSON.stringify(raw), packet));
  }
  assert.equal(localPath("/editor?name=a#tab"), "/editor?name=a#tab");
  assert.throws(() => localPath("https://external.test/"));
});

test("empty plans and missing mappings stay uncovered, even if emitted probes pass", () => {
  const packet = buildJudgePackets(fixtureRoot())[0];
  const empty = parseProbePlan(JSON.stringify({ packetId: packet.id, cases: [], uncovered: [] }), packet);
  assert.equal(empty.uncovered.length, 4);
  assert.equal(judgeRequirementStates([packet], [empty], [])["REQ-1"], "unverified");
  const raw = fixturePlan(packet) as any;
  raw.cases[0].outcomeChecks = [];
  const partial = parseProbePlan(JSON.stringify(raw), packet);
  assert.equal(partial.uncovered.length, 1);
  const passed = partial.cases.map((c) => ({ caseId: c.id, requirementId: c.requirementId, scenarioId: c.scenarioId, status: "passed" as const }));
  assert.equal(judgeRequirementStates([packet], [partial], passed)["REQ-1"], "unverified");
  const declared = fixturePlan(packet) as any;
  declared.uncovered = [{ requirementId: "REQ-1", scenarioId: "REQ-1#1", reason: "A THEN clause cannot be expressed in this DSL" }];
  assert.equal(judgeRequirementStates([packet], [parseProbePlan(JSON.stringify(declared), packet)], passed)["REQ-1"], "unverified");
});

test("bounded packets retain all scenarios, ancestors, seeds and dependency context; changes first", () => {
  const root = fixtureRoot() as any;
  root.children.unshift({ id: "REQ-old", type: "ATOMIC", name: "Old", description: "Unchanged baseline", scenarios: root.children[0].scenarios });
  root.children[1].dependencies = ["REQ-old"];
  const packets = buildJudgePackets(root, 100_000, 2);
  assert.equal(packets[0].requirements[0].id, "REQ-1");
  assert.equal(packets[0].requirements[0].prerequisites[0].id, "REQ-old");
  assert.deepEqual(packets[0].root.data, { name: "Old", count: 0 });
  const scenarios = packets.flatMap((p) => p.requirements.flatMap((r) => r.scenarios));
  assert.equal(scenarios.length, 8);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, 8);
});

test("GitHub finals is recognized from its change contract under a generic mount directory", () => {
  const root = fixtureRoot();
  root.name = "GitHub Collaboration Platform Core Requirements";
  assert.equal(isEvolutionRequirement(root, "/workspace/requirements"), true);
  assert.equal(isEvolutionRequirement({ id: "ROOT", name: "GitHub", children: [{ id: "REQ-1", description: "Create a new account" }] }, "/workspace/requirements"), false);
  assert.equal(isEvolutionRequirement({ id: "ROOT", name: "GitHub" }, "/tasks/hackathon-evolution--github"), true);
});

test("fatal gateway errors are distinguished from ordinary app or transient errors", () => {
  assert.equal(fatalGatewayError("Error: access key balance is exhausted (request id: example)"), true);
  assert.equal(fatalGatewayError("insufficient_quota"), true);
  assert.equal(fatalGatewayError("invalid_api_key"), true);
  assert.equal(fatalGatewayError("HTTP 429 rate limit; try later"), false);
  assert.equal(fatalGatewayError("frontend build exit 1"), false);
});
