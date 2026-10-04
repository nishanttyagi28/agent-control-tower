# AGENTS.md

Instructions for AI coding agents (Cursor, Claude Code, Codex, and others) working on this
repository. Humans should read it too: it is the contract for how changes are made here.

Each workspace under `examples/` (`target/`, `target-hidden-spec/`) has its own `AGENTS.md`
and `.cursor/hooks.json`. Inside a workspace, its `AGENTS.md` governs and this one does not.
`examples/acceptance/` holds hidden acceptance tests; never move them into a workspace.

## 1. Project overview

A small TypeScript orchestrator that drives local Cursor agents through `@cursor/sdk` in a
planner -> coder -> reviewer pipeline, with hard run and token budgets. The example target is
a tiny Python module built from a one-line goal.

Primary language: TypeScript on Node.js >= 22.13. Non-goals: cloud agents, parallel agents,
a general agent framework, any UI.

## 2. Repository layout

```text
.
|-- AGENTS.md / CLAUDE.md / .cursor/rules/core.mdc   # agent instructions
|-- src/                 # orchestrator (library code + cli.ts entry point)
|-- prompts/             # one prompt template per role: planner.md, coder.md, reviewer.md
|-- tests/               # vitest unit tests; fakes only, never the network
|-- examples/target*/    # self-contained workspaces, each with AGENTS.md + .cursor/hooks.json
|-- examples/acceptance/ # hidden acceptance tests, outside every workspace
|-- runs/<timestamp>/    # committed, trimmed logs of real pipeline runs
|-- docs/architecture.md, docs/adr/NNNN-*.md
`-- .github/workflows/ci.yml
```

Put code where the layout says. If a file does not fit, stop and ask.

## 3. Commands

| Task | Command |
|------|---------|
| Install | `npm ci` |
| Format | `npm run format` (check: `npm run format:check`) |
| Type check | `npm run typecheck` |
| Unit tests | `npm test` |
| Full local gate | `npm run format:check && npm run typecheck && npm test` |
| Real pipeline run (spends usage) | `npm run pipeline` (needs `CURSOR_API_KEY`) |

Never run `npm run pipeline` unless the human asked for a real run in this session.

## 4. Coding conventions

- TypeScript `strict` with `noUncheckedIndexedAccess`. No `any`, no non-null assertions on
  data that came from a model.
- All budgets, prices, and defaults live in `src/config.ts`. No magic numbers elsewhere.
- Everything that talks to Cursor goes through the `AgentRunner` interface in `src/types.ts`.
  Only `src/cursor-runner.ts` imports runtime values from `@cursor/sdk`.
- Model output is untrusted input: parse and validate it (`src/parse.ts`), never `eval` it.
- Enforce policy in code or hooks, not prompts (ADR 0003). No role gets a shell tool.
- The two copies of `.cursor/hooks/shell_policy.py` must stay identical (a test checks it).
- Comments explain why, not what. ASCII only.

## 5. Agent operating rules

1. Restate the task and what is out of scope.
2. Read every file you will change and its tests before editing.
3. Give a short numbered plan with exact paths. Wait for approval if it touches more than 3
   files, changes a budget default, adds a dependency, or touches CI.
4. Never invent SDK APIs. Confirm names in `node_modules/@cursor/sdk/dist/esm/*.d.ts` or the
   official docs at https://cursor.com/docs/api/sdk/typescript.
5. Never invent numbers. Token counts and costs come from a committed `runs/*/summary.json`.
6. Budgets may only get stricter without an ADR (see `docs/adr/0002-run-budget.md`).
7. Unit tests never call a real agent or the network.
8. Stop and report when the same failure repeats twice. Do not loop.

## 6. Retry policy

The orchestrator reads the block below at startup (`src/policy.ts`). Precedence per field:
CLI flag > this block > built-in default. Unknown keys or out-of-range values stop the
pipeline before any agent runs. The run cap (`maxRuns`, 6) is not set here; raising
`maxRetries` also needs `--max-runs` to cover `1 + maxTasks + 1 + 2*maxRetries`.

```json retry-policy
{
  "maxRetries": 1,
  "duplicateFailure": { "enabled": true, "overlapThreshold": 0.8 },
  "confirmThreshold": 0.8
}
```

- `maxRetries` (0-5): coder retries after a FAIL. Flag: `--max-retries`.
- `duplicateFailure`: abort with `DUPLICATE_FAILURE` when at least `overlapThreshold` of a
  retry's FAIL reasons repeat earlier ones. Flags: `--duplicate-overlap`, `--no-duplicate-check`.
- `confirmThreshold` (0-1]: with `--interactive`, ask before the run that crosses this
  fraction of `maxRuns`. Flag: `--confirm-threshold`.

## 7. Safety and git

- Never print, log, or commit `CURSOR_API_KEY` or any other secret. Keys come from the
  environment; `.env.example` documents them.
- Never `git push`, force-push, rewrite history, or open PRs unless explicitly asked.
- Conventional Commits: `<type>(<scope>): <summary>`, types `feat fix test docs ci chore
  refactor`. Small commits that each pass the local gate.

## 8. Definition of done

- [ ] Local gate passes (paste the summary lines).
- [ ] New behaviour has a unit test that would fail without the change.
- [ ] `docs/architecture.md` / ADRs updated if the design changed.
- [ ] No secrets, debug output, or commented-out code left behind.
