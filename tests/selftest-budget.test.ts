import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfTestBudget } from "../evolution/selftest-budget.js";

test("budget configuration rejects non-finite, fractional and non-positive values", () => {
  for (const value of [0, -1, NaN, Infinity, 1.2]) {
    for (const key of ["maxChecks", "maxFailures", "maxMs"]) assert.throws(() => new SelfTestBudget({ [key]: value }), /positive safe integer/);
  }
});
test("successful checks do not clear failures and concurrent checks cannot overspend", () => {
  const budget = new SelfTestBudget();
  budget.begin("check"); assert.throws(() => budget.begin("check"), /Concurrent/); budget.finish(true);
  budget.begin("check"); budget.finish(false);
  budget.begin("check"); const final = budget.finish(true);
  assert.equal(final.failures, 2); assert.equal(final.checksStarted, 3); assert.equal(final.reason, "failure-limit");
  assert.throws(() => budget.begin("start"), /failure-limit/);
});
test("different requirements have independent budgets", () => {
  const first = new SelfTestBudget({ maxChecks: 1 }), second = new SelfTestBudget({ maxChecks: 1 });
  first.begin("check"); first.finish(false);
  assert.throws(() => first.begin("check"), /check-limit/);
  second.begin("check"); assert.equal(second.finish(false).checksStarted, 1);
});
