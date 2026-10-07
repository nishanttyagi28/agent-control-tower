# CodeGovernor

A small TypeScript orchestrator that runs a planner, a coder and a reviewer agent on a repository, with the important rules enforced in code and hooks rather than in prompts.

[![ci](https://github.com/nishanttyagi28/codegovernor/actions/workflows/ci.yml/badge.svg)](https://github.com/nishanttyagi28/codegovernor/actions/workflows/ci.yml)

![Replay of recorded run 2: budget pre-flight, reviewer FAIL, gate, one retry, PASS](docs/media/demo.gif)

Coding agents follow instructions most of the time, which isn't enough once they have a shell and write access. In the first real run of this repo, `AGENTS.md` and the coder prompt both said not to install packages. The coder couldn't find pytest, ran `pip3 install pytest --break-system-packages` and tried `apt-get install`. The reviewer only saw the files and the test output, so the run was reported as PASS.

CodeGovernor is one pipeline built around that lesson. Agents run locally through `@cursor/sdk`. Each role gets a fixed tool allowlist, the number of agent runs is capped before anything starts, and the final verdict passes through a deterministic gate. Every run leaves a log you can read afterwards.

## Install

Requirements: Node.js 22.13 or newer, and Python 3.12+ with the `venv` module (for the example workspaces).

```bash
git clone https://github.com/nishanttyagi28/codegovernor.git
cd codegovernor
npm ci
```

## Quick start

These don't call any model:

```bash
npm test               # unit tests
npm run demo:replay    # replays recorded run 2 in the terminal
```

To run the pipeline for real you need a user API key for the agent runtime. This spends plan usage:

```bash
export CURSOR_API_KEY=...        # never commit it
npm run pipeline                 # runs against examples/target
npm run pipeline -- --workspace examples/target-hidden-spec \
  --acceptance examples/acceptance/target-hidden-spec
npm run pipeline -- --help
```

The pipeline refuses to start if the target workspace has uncommitted changes, so the reviewed diff contains only what the agents changed.

## What it does

- **Tool allowlists per role.** The planner and reviewer are read-only. The coder can read and edit but has no shell. The orchestrator refuses to start a role that has a shell tool unless a command allowlist is also given.
- **Fail-closed hooks.** In each workspace, `.cursor/hooks.json` registers a shell hook that allows only running pytest, and a read hook that denies reads outside the workspace. Every denial starts with a rule ID such as `CG-SHELL-001 NO_PACKAGE_INSTALL`.
- **Deterministic gate.** Failing tests, a changed file the plan didn't declare, or a coder tool call outside the workspace forces FAIL, whatever the reviewer says.
- **Run budget.** The worst case (`1 + maxTasks + 1 + 2*maxRetries`) is checked against `--max-runs` (default 6) before the first run. A retry that repeats the earlier failure reasons stops with `DUPLICATE_FAILURE`.
- **Git checkpoints.** Checkpoints are kept under `refs/codegovernor/`, leaving HEAD, branches and the index alone. If the run doesn't pass, the workspace is restored and the attempt is saved as `failed.diff`.
- **Reviewer context.** The reviewer sees the workspace diff, the diff since its last review, and every coder tool call.
- **Run logs.** `runs/<timestamp>/` holds each prompt, every tool call (arguments redacted and truncated), the final text, model, token usage and an estimated cost.

Main options: `--max-runs`, `--max-retries`, `--timeout-min`, `--interactive`, and per-role `--planner-model`, `--coder-model` and `--reviewer-model`. Retry defaults come from the `json retry-policy` block in [AGENTS.md](AGENTS.md#6-retry-policy). Command-line flags override it.

## How it works

```text
GOAL.md -> planner (read-only) -> JSON plan
        -> coder, one task at a time (read + edit)
        -> pytest in <workspace>/.venv (+ optional hidden acceptance tests)
        -> reviewer (read-only) -> PASS / FAIL -> gate
        -> on FAIL: one retry with only the unresolved reasons, then review again
```

The orchestrator creates the workspace venv and installs pytest itself, so agents never install anything. Details are in [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/).

Two runs are recorded in `runs/`. In the first, `examples/target` passed on the first review. In the second, `examples/target-hidden-spec` failed once on a hidden acceptance test, then passed after one retry. Token counts, estimated costs and what changed after each run are in [docs/sample-runs.md](docs/sample-runs.md). What the replay shows is described in [docs/demo.md](docs/demo.md).

## Limitations

- **Hooks haven't been exercised in a real run.** No role has a shell, so the shell hook can't fire. Both hooks are covered by unit tests that run the real scripts. The orchestrator's own path check doesn't depend on hooks.
- **The read hook only sees file reads, not grep or glob.** In run 2 the planner found the "hidden" acceptance tests with a glob. "Hidden" only means they aren't in the workspace or in the prompts.
- **Features added after run 2 are unit-tested only.** That covers checkpoints, the duplicate-failure abort, `--interactive`, per-role models and the retry policy.
- **Path checks depend on the SDK's tool-call shape.** They read keys like `path` and `targetDirectory`. A tool that names paths differently wouldn't be checked.
- **Costs are list-price estimates**, not invoices. Only `composer-2.5` has a verified price in the table.
- This is a personal project at version 0.1.0, not a general framework.

## Development

```bash
npm run format:check
npm run typecheck
npm test
```

The hook tests run the real policy scripts with `python3`. CI also runs pytest in both example workspaces (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## License

MIT. See [LICENSE](LICENSE).
