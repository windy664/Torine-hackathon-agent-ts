# Torine-hackathon-agent-ts

`main` contains the OpenCode mainline agent and its submission package.

Maintained branches (cleaned up on 2026-10-07):

- [`main`](https://github.com/windy664/Torine-hackathon-agent-ts/tree/main): OpenCode mainline, including the independent Judge work.
- [`improve/opencode-evolution`](https://github.com/windy664/Torine-hackathon-agent-ts/tree/improve/opencode-evolution): this worktree's controller, observability and reliability iteration; not automatically the platform submission.
- [`baseline/preliminary-20261003`](https://github.com/windy664/Torine-hackathon-agent-ts/tree/baseline/preliminary-20261003): frozen preliminary baseline at `655dce0b7d64866e705b2721f2f0487823635655`; all 57 files in the audited preliminary upload match this commit byte-for-byte.

The `dsh` and `experiment/multi-engine` branch names have been retired locally
and remotely. Their worktrees, uncommitted files and Git history were archived,
not discarded. See [branch ownership, pending work and recovery](docs/BRANCH_HANDOFF.md).
Deleting branch names does not erase historical commits or rewrite `main`.

ARC-Bench hackathon agent. TypeScript adapter layer driving **opencode** as the
coding engine (stock `opencode-ai` binary via npm - zero fork/patch). Built on
the official ARC-Bench TypeScript starter template.

## Architecture

```
platform runner → npm install (opencode binary lands via npm)
  → tsx index.ts            (adapter: task slicing, contracts, events)
    → opencode run --continue  (stock engine: reads req, writes code, skills)
```

- **Task contract sheet**: `extractTaskContract()` derives named UI targets,
  error strings, and seed values from the *current* requirement subtree at
  runtime - one agent package serves every task (stage-1/2/3, sheet) without
  hardcoded per-task strings.
- **Mechanics**: hot sessions (`--continue`) for initial runs, fresh sessions
  for bounded Evolution turns, per-module audits, NUDGE turns,
  build/startup rehearsal with repair, verbatim lint (requirement quoted
  strings vs source), strict-mode final check, selftest Dockerfile output.

## Entrypoint Contract

ARC-Bench runs this agent as:

```bash
npm install            # runner installs Node deps first
tsx index.ts /path/to/requirements --output-dir /path/to/output --type web
```

ZIP root must contain `index.ts` + `package.json`.

Build the competition submission ZIP with `sh pack-agent.sh`. Each run writes to
a new `/tmp/torine-agent.XXXXXX/torine-evolution-agent.zip` path and prints it.
Upload that ZIP as a **TypeScript agent**
to the Hackathon Evolution competition. `pack-app.sh` is only for packaging an
already generated application for the separate self-test channel.

For an Evolution requirement directory, the platform first injects this team's
previous application into `--output-dir`. The adapter detects Evolution from the
requirement directory or root title and refuses to start if either
`frontend/package.json` or `backend/package.json` is missing. It preserves the
injected project and asks OpenCode for focused changes to the existing code.
Evolution runs skip starter copying, whole-tree string lint and source-string
"passed" claims, which cannot prove changed behavior. The agent is instructed
to use the supplied requirements and application source only; it must not seek
platform or hidden tests. Each work prompt includes the product-wide and module
requirements as well as its own subtree, so permission and persistence rules are
not lost when a module is split into smaller turns. By default, implementation
turns stop after 20 hours (`TORINE_EVOLUTION_WORK_BUDGET_MS` can change this),
leaving time inside the 24-hour container limit for final build and startup
checks. Each Evolution turn has a 15-minute default cap, and timed-out
OpenCode subprocess groups are stopped before the next turn begins. After each
module, the adapter checks that the baseline files still exist, the frontend
builds, and the backend starts. A failed check gets one focused repair turn;
if it still fails, implementation stops and the final recovery phase runs.

## Layout

- `index.ts` — adapter: parses requirements.yaml, drives opencode per ROOT
  module subtree, reports SDK events, commits checkpoints, postflight checks.
- `arcbench-agent-runtime-js/` — official ARC-Bench SDK (events, traceability, git).
- `skills/` — ARC-Bench skills (opencode-native SKILL.md, mounted via config).
- `template/` — starter web app (Vite + React + TS frontend, Express + SQLite backend).
- `examples/` — model calling / SDK usage references from the official template.

## Engine

`opencode-ai` npm package (postinstall places the `opencode` binary). The
adapter writes an `opencode.json` (via `OPENCODE_CONFIG`) that maps
`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL` to a bundled
`@ai-sdk/openai-compatible` provider, then runs one `opencode run` per ROOT
subtree with `--dangerously-skip-permissions`.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `TORINE_NODE_TIMEOUT_MS` | `2700000` | per-turn OpenCode timeout |
| `TORINE_EVOLUTION_NODE_TIMEOUT_MS` | `900000` | per-turn timeout for Evolution; independent sessions avoid transcript growth |
| `TORINE_EVOLUTION_WORK_BUDGET_MS` | `72000000` | maximum time for Evolution implementation turns; reserves time for final checks |
| `TORINE_SMOKE` | unset | `1` = run frontend npm install + build smoke after run |

## Scoring notes (hackathon)

- Final score uses only the LAST saved submission, best run per task under it.
- Stage route: implement Stage 1 first; Stage 2/3 continue from the
  highest-scoring app of the previous stage (evolution mode: existing
  `frontend/`+`backend/` in output dir is preserved automatically).
