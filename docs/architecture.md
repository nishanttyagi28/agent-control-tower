# Architecture

## Components

| Module | Responsibility |
|--------|----------------|
| `src/cli.ts` | Entry point. Reads `GOAL.md` and the AGENTS.md retry policy, resolves per-role models and flags, wires the real runner, writes logs. |
| `src/pipeline.ts` | Control flow: plan, code each task, test, review, up to `maxRetries` checkpointed fix rounds. Pure orchestration over interfaces. |
| `src/cursor-runner.ts` | The only module that calls `@cursor/sdk` at runtime. One fresh local agent per role run, using the model in the request. Records each tool call with its args and paths. |
| `src/roles.ts` | Tool allowlist per role. No role has a shell; only the coder can edit. |
| `src/parse.ts` | Extracts and validates the planner plan (incl. declared `files`) and reviewer verdict. |
| `src/budget.ts`, `src/config.ts` | Run cap, timeouts, per-role models (`RoleModels`), verified list prices. |
| `src/policy.ts` | Parses the `json retry-policy` block in AGENTS.md; flag > AGENTS.md > default. |
| `src/retry.ts` | Reason normalisation, checkpointed retry reasons, `FailureTracker` (duplicate-failure detection). |
| `src/checkpoint.ts` | Git checkpoints under `refs/codegovernor/<run>/` via a throwaway index; diff between checkpoints; restore. |
| `src/approve.ts` | `--interactive` y/n prompt and the budget-threshold rule. |
| `src/tool-scope.ts` | Coder tool-call summary for the reviewer and the deterministic "stayed inside the workspace" check. |
| `src/test-runner.ts` | Creates/reuses `<workspace>/.venv`, installs pytest, runs tests with the absolute venv python (plus optional hidden acceptance tests). |
| `src/workspace.ts` | `git status --porcelain` / `git diff` scoped to the workspace, and the plan-scope check. |
| `src/redact.ts`, `src/tool-calls.ts` | Secret redaction and tool-arg rendering/truncation for logs and prompts. |
| `src/run-log.ts` | Writes trimmed, redacted per-run markdown logs, `summary.json`, and `failed.diff` on failure. |
| `src/replay.ts`, `src/demo-replay.ts` | Offline replay of a committed run: a fake `AgentRunner`, test runner and workspace inspector fed from `runs/<ts>/`, driven through the real `runPipeline` and gate. |
| `examples/*/.cursor/hooks.json` | Fail-closed `beforeShellExecution` (command allowlist) and `beforeReadFile` (workspace-only reads) hooks (ADR 0003). |
| `prompts/*.md` | One template per role, `{{placeholder}}` substitution, unknown placeholders fail. |

## Flow

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant P as planner (read-only)
    participant C as coder (read + edit)
    participant T as test command
    participant R as reviewer (read-only)
    O->>O: workspace must be clean; checkpoint "base"
    O->>P: goal + max_tasks
    P-->>O: JSON plan (<= maxTasks tasks, each with files)
    loop each task
        O->>C: task instructions + allowed files
        C-->>O: summary (files edited in workspace)
    end
    O->>O: any coder tool path outside workspace => FAIL, no retry
    O->>T: venv python -m pytest (+ hidden acceptance)
    T-->>O: exit code + output
    O->>O: git status + diff; checkpoint "review-N"
    O->>R: plan + tests + full diff + diff since last review + coder tool calls
    R-->>O: {"verdict": PASS|FAIL, "reasons": [...]}
    O->>O: gate: tests red or undeclared file changed => FAIL
    opt FAIL and retries left (maxRetries, default 1)
        O->>O: --interactive: ask y/n
        O->>C: only the unresolved reasons (continue from checkpoint)
        O->>T: run tests
        O->>R: review again
        O->>O: >= 80% of reasons repeat and retries left => DUPLICATE_FAILURE
    end
    opt not PASS
        O->>O: checkpoint "failed", save failed.diff, restore "base"
    end
```

## Key properties

- **Bounded cost.** The run cap is checked against the worst case before the first run
  (`1 + maxTasks + 1 + 2 * maxRetries <= maxRuns`, 6 with defaults) for any `maxRetries`, and
  enforced again before every run. The duplicate-failure check stops a retry loop that is not
  making progress before it spends the remaining budget.
- **Deterministic gate.** The orchestrator runs the tests itself with the workspace venv's
  absolute interpreter. `gateReview` turns a reviewer PASS into FAIL when the tests exit
  non-zero or when `git status` shows a changed file the plan did not declare. A coder tool
  call that names a path outside the workspace fails the pipeline before the reviewer runs.
- **Least privilege.** Planner and reviewer get `read`, `grep`, `glob`, `ls`. The coder adds
  `edit`. No role has a shell. Each workspace has fail-closed hooks: `beforeShellExecution`
  allowlists `python -m pytest|compileall`, and `beforeReadFile` denies reads outside the
  workspace (ADR 0003).
- **Recoverable workspace.** Checkpoints are dangling commits pinned under
  `refs/codegovernor/<run>/`. They are built from a temporary index, so HEAD, branches and the
  user's index are untouched, and nothing is pushed. On any non-PASS outcome the workspace's
  working tree is restored to `base`, and the failed state stays inspectable
  (`git diff refs/codegovernor/<run>/base refs/codegovernor/<run>/failed`).
- **Checkpointed retries.** A retry continues from the current workspace and sees only the
  latest unresolved reasons. The reviewer sees the full diff and the diff since its last review.
- **Policy in files.** Retry defaults live in a machine-readable block in AGENTS.md. Per-role
  models default to `composer-2.5` (`fast=false`) for every role (ADR 0004).
- **Human in the loop, opt-in.** `--interactive` asks before the run that crosses 80% of the
  run cap and before every retry. EOF or anything but `y` stops.
- **Fresh context per run.** Each role run is a new `Agent.create` call, so prompts stay small
  and every run can be reproduced from its logged prompt.
- **Small, redacted logs.** Per run: model, prompt, each tool call with args cut to 200 chars,
  final text, usage. Everything is redacted first (secret env values and token patterns).

## Failure handling

| Situation | Outcome |
|-----------|---------|
| Workspace dirty before the first run | `ERROR`, no agent runs, nothing restored |
| Invalid retry policy block in AGENTS.md or bad flag value | CLI exits before any agent runs |
| Agent run ends `error` / `cancelled` (incl. timeout) | `ERROR`, no further runs |
| Planner or reviewer output is not valid JSON of the expected shape | `ERROR` |
| Coder tool call touched a path outside the workspace | `FAIL`, no reviewer run, no retry |
| Tests red or undeclared file changed | reviewer verdict forced to `FAIL` |
| Retry repeats >= overlap threshold of earlier reasons, retries left | `DUPLICATE_FAILURE` |
| Human answers no (`--interactive`) | `STOPPED_BY_USER`, before the run is spent |
| Run cap reached | `BUDGET_EXHAUSTED` |
| Reviewer FAIL after the last retry | `FAIL` |
| Any outcome other than `PASS` after the base checkpoint | `failed.diff` saved, workspace restored |
