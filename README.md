# Torine-hackathon-agent-ts

ARC-Bench hackathon agent. A TypeScript adapter layer that drives **opencode**
(stock `opencode-ai` binary via npm - zero fork/patch) as the coding engine,
adds competition-grade orchestration around it: requirement-tree contract
extraction, module scheduling with evolution delta priority, an independent
browser-based Judge with bounded repairs, and mechanical seed/verbatim lints.

## Architecture

```
platform runner → npm install (opencode binary lands via npm)
  → tsx index.ts            (adapter: scheduling, contracts, events)
    → opencode run --auto   (stock engine: reads requirements, writes code)
```

- **Task contract sheet**: `extractTaskContract()` derives named UI targets,
  error strings, and seed values from the *current* requirement subtree at
  runtime - one agent package serves every task without hardcoded per-task
  strings.
- **Seed declarations**: `extractSeedDeclarations()` parses scenario GIVEN /
  pre-provisioned initial state out of the requirements and enforces it three
  ways: as a prompt contract (PRE-PROVISIONED INITIAL STATE), as part of the
  mechanical per-module audit, and as a dedicated seed lint with a repair turn.
- **Evolution mode**: keeps the platform-injected baseline, prioritizes the
  delta requirements, repairs missing seeds at module boundaries, and never
  copies a starter over existing work.
- **Independent Judge**: a separate model call receives public requirements
  only and produces a validated JSON browser plan. The harness runs real
  Chromium against isolated application copies and feeds failures to bounded
  repair turns (module boundary: 1, delivery: 2).
- **Mechanics**: hot sessions for initial runs, fresh sessions for bounded
  evolution turns, per-module mechanical audits, build/startup rehearsal with
  repair, verbatim lint, strict-mode final check, selftest Dockerfile output.

## Layout

| Path | Purpose |
| --- | --- |
| `index.ts` | Orchestration: phases, prompts, audits, budgets |
| `controller-*.ts` | Scheduler, budget/state, test tooling, opencode plugin |
| `judge*.ts` | Judge plan generation, Playwright runner, repair loop |
| `template/`, `sheet-scaffold/` | Starter scaffolds for empty output dirs |
| `skills/` | Skills injected into the opencode config |
| `tests/` | Controller/scheduler/judge unit tests |

## Run

```bash
npm install
npm start -- <requirements-dir> --output-dir <output-dir>
npm run judge -- <requirements-dir> --output-dir <output-dir>   # judge-only
```

## Tests

```bash
npm run typecheck
npx tsx --test tests/controller.test.ts tests/controller-scheduler.test.ts
```
