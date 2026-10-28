# v6 reliability increment and AI handoff — 2026-10-07

Scope: `improve/opencode-evolution` only. Keep stock OpenCode 1.18.34; do not
merge into the concurrently edited mainline, switch engines, or submit/run on
the competition platform. This document supersedes older submission authority
and per-turn self-test limits in historical v3/v4/v5 notes.

## What changed

- `SelfTestBudget` belongs to a public requirement, not an OpenCode process.
  Implementation and packet repair share at most six checks, 180,000ms of
  cumulative active startup/check time, and two total failed operations.
  Success does not erase earlier failures. Source edits, app restart and
  session reset do not replenish the budget. The one final-delivery repair
  has a separate bounded budget; this is not a whole-run three-minute limit.
- Exhaustion aborts the owning implementation process group. The controller
  records abort/stop reason, retains partial edits, performs independent local
  verification and may continue later packets. Aborted execution remains
  unchecked even when the unchanged baseline passes a behavior probe.
- Status/stop/cleanup remain available after exhaustion. Development receipts
  and structured events record count, failures, active time and limit reason.
  Recognized Bash test commands are routed to `torine_check` instead of
  silently escaping the parent-owned budget.
- Preserve and validate the previously uncommitted snapshot fix: source/build/
  script changes refresh the private app; unchanged checks share private state;
  restart restores baseline data. Original output data is not a reset target.
- Restore the omitted `maxCheckMs` option type. Resolve Playwright's installer
  through its declared package executable, not unsupported `playwright/cli`.
- Candidate validation now copies verification-only tests into the unpacked
  candidate and imports its dependencies. Merely running a worktree test with
  a candidate's tsx binary still resolved shared mainline dependencies before.

The previously pending `evolution/index.ts` changes are included in this
candidate: browser/planner failure does not forbid all development, interrupted
sessions reset, packet repair is bounded to one attempt, ordinary incomplete
behavior is reported as partial rather than preventing platform delivery.
Baseline preservation violations still block delivery. These are not official
test-pass events.

## Sessions are not subagent fan-out

The controller loops packets serially; `Engine` additionally rejects concurrent
turns on its shared output project. It creates a module session lazily and
explicitly reuses its ID for later packets/repair in that module. A new module
starts another session. Interrupted sessions can be reset without resetting
their requirement's check budget. Cross-module context is a bounded handoff
and initial project map, not the whole growing chat history.

`task` is denied globally and on the implementation agent. No whole-document
parallel dispatch or writing subagents are enabled. The configured read-only
`verifier` is not a subagent rollout; the planner currently calls a tool-free
gateway conversion. Parent/child log support does not establish actual child
agent use. Mainline's current per-packet fresh-session implementation is a
different controller, not this feature's session policy.

## Verification and artifacts

Development checks passed before packaging: typecheck, 40 unit/browser cases,
actual OpenCode session protocol, actual OpenCode DevTools protocol, and the
injected-failure -> one repair -> frozen-browser-plan regression controller.
Fixture startup/termination timing was adjusted for instrumented Node cold
starts; production command/startup limits were not increased by those changes.

The actual CLI interrupted-packet fixture also passed: two failed checks abort
REQ-1-1, `implementationStopReason` records `failure-limit`, REQ-1-2 still
executes and checks successfully, and the overall local result stays partial.
Its report is under `/tmp/torine-entrypoint-xBId5e/interrupted/output/.arc/torine/`.

Candidate directory:
`/tmp/torine-final-uploads/opencode-v6-reliability-XQJbtNIi/`.

ZIP SHA256:
`b5e1b12716388ee6137ba616ec3ecff8c123e9df65a2f5ea2c78a0998990e442`.

`npm ci --no-audit --no-fund` was run in `unpacked/`, not through the worktree's
shared node_modules symlink. The full same-ZIP verification has completed;
consult `validation/result.json` and `validation-final-run.log` for final status.
The entrypoint gate includes GitHub/Sheet neutral-directory mode detection,
planning degradation/recovery, mixed coverage, and repeated-failure
interruption followed by successful execution of the next packet.

The first same-ZIP gate attempt passed five groups but failed its interruption
fixture: the synthetic gateway's formatted-JSON selector never injected the
two failures. A marker scoped to the first public fixture requirement fixes
injection without weakening the partial/abort/next-packet assertions. Preserved
evidence: `validation-attempt-1/`, `interrupted-routing-check.log`, and
`/tmp/torine-entrypoint-xBId5e/interruption-routing.jsonl`. The candidate runtime
and ZIP were not changed to make that test green. The complete rerun is in
`validation-final-run.log`; the validation runner now streams fixture logs
while running instead of withholding all progress until process exit.

Final same-ZIP result: **all six verification groups passed**, completed
2026-10-07 05:40:20 UTC. Typecheck passed; unit/browser **40/40**; actual
OpenCode protocol passed; DevTools protocol passed; bounded controller repair
passed; all **six CLI entrypoint cases** passed. Degraded, mixed and interrupted
cases correctly remain partial rather than being promoted to full acceptance.
The ZIP still has the SHA above and runtime files match the feature source.
Persistent ZIP/log backup:
`/home/windy/.local/share/torine-artifacts/20261007/opencode-v6-reliability-XQJbtNIi/`.

All model responses are from local deterministic gateways. No competition
submission, paid-model request, cancellation or platform reorder occurred.
Chromium 143 build 1200 was installed for Playwright 1.57.0; this Ubuntu host
uses the Ubuntu 24.04 fallback build, not official support for the host OS.

## Limits and next safe step

- This is a local reliability increment, not evidence of a higher score or
  complete GitHub/Sheet behavior coverage on real baseline projects.
- Budget timers and process supervision still depend on this Node controller
  event loop. An independent external watchdog is NOT implemented here.
  Termination/cleanup adds grace time beyond nominal active-time limits.
- Bash detection is best effort, not an OS sandbox. An opaque/arbitrary script
  can hide testing; the overall turn deadline remains necessary.
- Requirement budgets are in-memory and do not survive a controller restart.
  Task fan-out remains disabled; no claim of subagent savings is made.
- Implementation scheduling still follows document order. Change/dependency
  prioritization, stronger rollback, complete cost visibility and integration
  with mainline's independently developed Judge/controller need separate
  review. Do not create a third orchestrator to address those gaps.

Before continuing, read `BRANCH_HANDOFF.md`, inspect branch/status/current main
diffs and this candidate's actual verification result. Review mainline overlap
before selecting integration commits. Further real gateway/baseline or paid
platform testing requires the user's budget/submission direction.
