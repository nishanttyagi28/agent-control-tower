# 0003. Enforce agent policy in hooks and the orchestrator, not in prompts

Date: 2026-10-04
Status: Accepted

## Context

In the first real run (`runs/2026-10-04T01-45-08Z`), `AGENTS.md` and the coder prompt both
said "do not install packages". The coder still ran `pip3 install pytest
--break-system-packages` and tried `apt-get install`, because its shell resolved `python3` to
a system interpreter without pytest. The reviewer only reads files, so the violation was
invisible to the pipeline. Instructions influence a model; they do not bind it.

## Decision

Rules that matter are enforced by mechanisms the model cannot talk its way around:

1. **No capability where none is needed.** All roles get tool allowlists. No role gets a shell.
   The coder has `read, grep, glob, ls, edit`.
2. **Orchestrator owns the environment.** It creates `<workspace>/.venv`, installs pytest and
   runs tests with the absolute interpreter path. Agents never choose commands.
3. **Hook as defence in depth.** Each workspace has `.cursor/hooks.json` with a
   `beforeShellExecution` command hook (`failClosed: true`). It allows only
   `python3`/venv-python `-m pytest|compileall` and denies shell operators. If a shell is ever
   re-enabled, or a human runs Cursor in that folder, the policy still holds.
4. **Deterministic gate.** Failing tests, or a changed file not declared in the plan, force
   FAIL in TypeScript whatever the reviewer says.
5. **Observable.** Every tool call is logged with redacted, truncated args.

## Alternatives considered

- **Stronger prompt wording.** Already tried in run 1, and it is not verifiable.
- **`local.sandboxOptions`.** It constrains filesystem and network but does not express "only
  pytest". It also needs bubblewrap on the host. It is complementary and could be added later.
- **Prompt-based hooks (LLM-evaluated).** They cost model usage on every command and are not
  deterministic.
- **Keep the coder's shell behind the hook.** It would exercise the hook in real runs, but the
  coder does not need a shell when the orchestrator runs the tests.

## Consequences

- The coder cannot run tests itself, so the feedback loop goes through the reviewer round.
  Run 2 shows that the single retry is enough for a missed requirement.
- The hook is not exercised by real runs while no role has a shell. Its behaviour is covered by
  unit tests that run the real script and replay run 1's commands.
- Read tools are still not confined to the workspace (run 2: the planner globbed for the
  hidden tests). A `beforeReadFile` hook is the next step if that matters.
- Success: no agent tool call in a committed run log executes a command outside the
  allowlist, and the scope gate has a unit test for every failure mode.
