# Branch cleanup and AI handoff — 2026-10-07

This is a point-in-time record. Inspect current Git and platform state before
acting; a previous conversation's plan is not evidence that a change was made.

Latest continuation: [v6 reliability increment](RELIABILITY_V6.md). It records
the candidate check budget, serial/session policy, independent dependency
validation and remaining limits. The earlier pending-work section below is a
historical snapshot; use the v6 record and actual validation result for current
status. Mainline is concurrently developing its own controller: do not edit or
merge its dirty files from this worktree.

## User direction and branch ownership

Keep `main` and our iteration branch, freeze a preliminary comparison branch,
and retire the unused engine experiments. Do not change the coding engine or
create more experiments during this cleanup. Write detailed commits so another
AI can continue safely.

| Branch | Worktree / owner | Role |
| --- | --- | --- |
| `main` | `/home/windy/Project/Torine-hackathon-agent-ts`; competitor-tracking / Judge conversation | Mainline integration and independent requirement-derived Judge |
| `improve/opencode-evolution` | `/home/windy/Project/Torine-hackathon-agent-opencode-improve`; this conversation | Controller, logging, bounded self-tests and execution reliability |
| `baseline/preliminary-20261003` | No active worktree; keep frozen | Preliminary comparison at `655dce0b7d64866e705b2721f2f0487823635655` |

Only the three branches above remain locally and on GitHub after cleanup.
Mainline and iteration are not interchangeable release versions. Do not merge,
rewrite another conversation's work, or submit an agent merely because this
document describes a possible next step.

## Verified preliminary baseline

The audited preliminary agent came from submission `aa300ec3f7ec`, associated
with preliminary GitHub run `222b8baa514d` and Sheet run `50d810790e7f`.

- Commit: `655dce0b7d64866e705b2721f2f0487823635655`.
- Archive: `/home/windy/.local/share/torine-artifacts/20261007/initial-audit/initial-agent.zip`.
- Archive SHA256: `05fef0ab2e0b4b626ec4cdb992ca34073361d63e9e4445fe0f7520363fd96600`.
- Compared every archive file with `git show 655dce0:<path>`: **57 identical files, zero differences, zero missing paths**.
- This verifies packaged file content, not new behavior, score improvement, or identical ZIP container bytes after repackaging.

Do not confuse this preliminary archive with first-generation finals run
`0335bdeccc5d`: that run's actual agent archive was separately downloaded and
does not have the same entrypoint hash. Preserve the preliminary branch as-is;
make comparison changes on an explicitly agreed development branch.

## Retired experiments and recoverability

Local and remote branch names removed:

- `dsh` at `dbe1c14f3e3d12b437777d6f8074a17e950fe6e5`.
- `experiment/multi-engine` at `7a40251713c9b746e4be5c20fb79283bc63fcee2`.

Backup directory:
`/home/windy/.local/share/torine-artifacts/20261007/branch-cleanup-adhk2f34/`.

It contains a verified `repository.bundle`, generated `MANIFEST.json` with
original tips/paths/statuses/hashes, and both complete archived worktrees:

- `worktrees/dsh/` preserves untracked `conversation.ts`, `observability.ts`,
  `telemetry-plugin.mjs`; SHA256 values were checked before and after moving.
- `worktrees/multi-engine/` preserves the clean multi-engine worktree.

The archived worktrees remain registered in Git at detached HEADs. They are
backups, not active development branches. Moving them preserved dependencies,
ignored files and uncommitted content. No application source was discarded.
Remote deletion used an atomic push with expected-tip leases; unseen remote
commits would have rejected the cleanup. No force-push or rewrite of mainline
history was performed. Old commit URLs can still exist after branch deletion.

If restoration is requested, recreate the named branch at the recorded SHA,
switch the corresponding archived worktree onto it, then move that worktree
back to its recorded original path. Confirm the destination is free first.
The bundle provides an additional history recovery source; never delete it
without explicit direction.

## Pending iteration work — NOT validated or released

Before this documentation-only handoff, the iteration worktree already had
uncommitted changes in `evolution/devtools.ts`, `devtools-plugin.mjs`,
`engine.ts`, and `index.ts`. They were preserved and excluded from this commit.
They contain candidate snapshot/data refresh, check-count limits, session reset
and partial-delivery changes. Do not claim them verified or include them in a
formal package without completing regression checks.

The newly discussed independent watchdog and three-minute / two-failure
self-test budget were **not implemented** by this branch cleanup. Existing
EventLog/billing controls are not proof that those new safeguards exist.

Known environment hazard: this iteration worktree's `node_modules` is a symlink
to mainline. At inspection, iteration locked Playwright 1.57.0 but resolved
mainline's 1.61.1. Never run `npm install` / `npm ci` through this symlink. Use
an independently unpacked candidate directory for installs and verification;
resolve shared dependencies deliberately before claiming reproducibility.

## Platform state is separate from Git state

Our last uploaded submission was `6a4545a2ee66`, an unchanged copy of platform
submission `57c4927247fd`, resaved with `credential_mode=official_evaluation`.
Archive SHA256: `9ac3129b654ff2b874cd79b7b0a3681e5c92aec4aa002d1f64ac3afa74c527fd`.
It was NOT a package of the pending iteration changes or the new Judge.

Our GitHub `2f7cc479798e` and Sheet `52f6d8bcedc6` runs were explicitly cancelled
at the user's request before this cleanup. Their records/logs remain under
`/tmp/torine-final-uploads/latest-v7-official-gd7gojby/`.
Another conversation may submit or run newer work: inspect live state instead
of assuming our stopped pair is the latest platform activity.

Latest user direction for this conversation: **do not submit; explain iteration
first**. Branch cleanup does not authorize starting, stopping, deleting or
reordering platform submissions/runs. Use only public requirements and our own
permitted artifacts; do not discover/use hidden tests. Unknown usage is not
zero cost; heartbeats, builds and small local checks are not full acceptance.

## Commit and next-agent checklist

Every meaningful commit should describe motivation/evidence, changed behavior,
actual verification commands/results, known limitations, unfinished work and
the next safe step. Include branch, ZIP hash and submission/run IDs when
relevant; never include credentials. Documentation-only commits must say so.

Before continuing, inspect `git status`, branch, current commits, worktree
locations and live run state. Coordinate with the Judge conversation before
integrating overlapping verification flows. Complete isolated fault-injection
tests before claiming reliability or requesting a new formal submission.
