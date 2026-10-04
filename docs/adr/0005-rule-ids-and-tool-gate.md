# 0005. Rule IDs on every deny and a tool gate before agents start

Date: 2026-10-04
Status: Accepted

## Context

Public feedback on this repo was that rules written in a markdown file are wishes: unless
something blocks the tool call, an agent that hits an obstacle will try another package manager
or path. A failing install should print the rule name, not a generic "blocked" message that
invites a variant command.

Run 1 (`runs/2026-10-04T01-45-08Z`) showed the same pattern: `AGENTS.md` and the coder prompt
forbade installs, but the coder still ran `pip3 install pytest --break-system-packages` and
tried `apt-get install` when the system `python3` had no pytest.

## Decision

1. **Stable rule IDs in code.** Shell and read hooks, and the orchestrator tool gate, each
   define IDs and names. The table in [AGENTS.md](../../AGENTS.md#policy-rule-ids) indexes them;
   the scripts and `src/tool-gate.ts` are the source of truth.
2. **Hook deny message format.** Denials use
   `<ID> <NAME>: <reason>. See AGENTS.md section 3 (Commands).` Shell denials also append an
   agent message telling the model not to retry with another package manager, path or variant.
3. **Shell hook precedence.** In `shell_policy.py`, checks run in order: invalid input (000),
   remote script (004), system packages (002), package install (001), then allowlist (003).
4. **Tool gate before agents.** `validateRoleTools` runs in `runPipeline` before any agent
   work, and `validateRoleToolList` runs in `CursorAgentRunner` before `Agent.create`. If a
   role's tool allowlist includes a shell tool and no orchestrator command allowlist was
   provided, the pipeline returns `ERROR` with CG-GATE-001 and no agent is created.
5. **`policyEvents` in run logs.** After the run, `policyEvents` collects one entry per rule ID
   found on a tool call, plus CG-GATE-002 for every recorded shell tool call. Rule IDs are
   parsed only from tool results with status `error`, or from any shell tool result, so a
   successful `read` of a file that mentions a rule ID does not create an event. Events are
   written to per-run markdown (rule IDs appended to the tool-call line) and to
   `summary.json`; the CLI prints one line per event.

## Alternatives considered

- **Denylist only.** Rejected: package managers and install spellings have endless variants;
  an allowlist plus named rules for the common escapes is easier to audit.
- **Prompt rules only.** Already rejected in ADR 0003; run 1 showed prompts do not bind the
  model when a shell is available.
- **No rule IDs.** Rejected: generic hook messages ("blocked", "forbidden") invite the agent
  to try `pip3` after `pip`, or `apt` after `pip3`.

## Consequences

- Every deny names a rule the agent and the human can look up in AGENTS.md.
- The orchestrator fails closed before spending a run on a misconfigured role with a shell tool.
- Shell tool calls are always visible in `policyEvents`, even when the hook allowed them.
- Rule IDs on hook denials and `policyEvents` are covered by unit tests only; no real run has
  produced one yet. How the SDK surfaces a hook deny in a tool result (status, text) is not
  verified, so `policyEvents` may miss real denials.
- Named install and remote-script detection is best effort; the allowlist is the real control.
  For example `bash -c "pip install x"` and `curl -s URL | sudo bash` are denied as
  CG-SHELL-003 NOT_IN_ALLOWLIST rather than CG-SHELL-001 or CG-SHELL-004 (verified by running
  the script).
