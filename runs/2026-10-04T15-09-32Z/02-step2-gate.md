# Run 2: step2-gate

- model: composer-2.5 fast=false
- status: finished
- duration_ms: 78940
- usage: {"inputTokens":347315,"outputTokens":9118,"cacheReadTokens":310008,"cacheWriteTokens":0,"totalTokens":666441}
- tool_calls (43): read x15, glob x2, grep x6, edit x19, shell


## Tool calls

1. read "/workspace/cursor-multiagent-demo/src/types.ts"
2. read "/workspace/cursor-multiagent-demo/src/run-log.ts"
3. read "/workspace/cursor-multiagent-demo/AGENTS.md"
4. read "/workspace/cursor-multiagent-demo/src/cursor-runner.ts"
5. read "/workspace/cursor-multiagent-demo/src/pipeline.ts"
6. read "/workspace/cursor-multiagent-demo/src/cli.ts"
7. glob "\"**/tool-gate*\""
8. read "/workspace/cursor-multiagent-demo/src/roles.ts"
9. read "/workspace/cursor-multiagent-demo/src/redact.ts"
10. read "/workspace/cursor-multiagent-demo/src/tool-calls.ts"
11. read "/workspace/cursor-multiagent-demo/tests/run-log.test.ts"
12. read "/workspace/cursor-multiagent-demo/tests/pipeline.test.ts"
13. grep "\"PipelineReport\" in /workspace/cursor-multiagent-demo/tests"
14. read "/workspace/cursor-multiagent-demo/tests/fakes.ts"
15. grep "\"tool_call|ToolCall\" in /workspace/cursor-multiagent-demo"
16. grep "\"policyEvents|PipelineReport|finish\\\\(\" in /workspace/cursor-multiagent-demo"
17. grep "\"tool_call\" in /workspace/cursor-multiagent-demo/node_modules/@cursor/sdk/dist/esm (glob *.d.ts)"
18. grep "\"PipelineReport|policyEvents\" in /workspace/cursor-multiagent-demo/tests"
19. read "/workspace/cursor-multiagent-demo/node_modules/@cursor/sdk/dist/esm/messages.d.ts"
20. glob "\"tests/*.test.ts\""
21. read "/workspace/cursor-multiagent-demo/tests/replay.test.ts"
22. read "/workspace/cursor-multiagent-demo/tests/roles.test.ts"
23. edit "/workspace/cursor-multiagent-demo/src/tool-gate.ts"
24. edit "/workspace/cursor-multiagent-demo/src/cursor-runner.ts"
25. edit "/workspace/cursor-multiagent-demo/src/types.ts"
26. edit "/workspace/cursor-multiagent-demo/src/cursor-runner.ts"
27. edit "/workspace/cursor-multiagent-demo/src/cursor-runner.ts"
28. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
29. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
30. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
31. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
32. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
33. edit "/workspace/cursor-multiagent-demo/src/pipeline.ts"
34. edit "/workspace/cursor-multiagent-demo/src/run-log.ts"
35. edit "/workspace/cursor-multiagent-demo/src/run-log.ts"
36. edit "/workspace/cursor-multiagent-demo/src/cli.ts"
37. edit "/workspace/cursor-multiagent-demo/tests/tool-gate.test.ts"
38. edit "/workspace/cursor-multiagent-demo/tests/pipeline.test.ts"
39. edit "/workspace/cursor-multiagent-demo/tests/pipeline.test.ts"
40. edit "/workspace/cursor-multiagent-demo/tests/run-log.test.ts"
41. edit "/workspace/cursor-multiagent-demo/tests/run-log.test.ts"
42. grep "\"export.*ZERO_USAGE\" in /workspace/cursor-multiagent-demo/src"
43. shell "export PATH=$PWD/.node22/bin:$PATH && npx prettier --write src tests && npm run -s format:check && npm run -s typecheck && npx vitest run"

## Prompt

````text
You are working in the CodeGovernor repository (current directory). Read AGENTS.md first and follow it (strict TypeScript, no `any`, no non-null assertions on model data, ASCII only, comments explain why). Step 1 (already committed) gave the hook scripts rule IDs CG-SHELL-000..004 and CG-READ-000..001; their deny messages start with "<ID> <NAME>: ". This is step 2 of 3; do only this step.

## Goal
An orchestrator-level tool gate in TypeScript, before any agent starts, plus surfacing of rule IDs after runs.

## Files you may change (and no others)
- src/tool-gate.ts (new)
- src/types.ts, src/pipeline.ts, src/cursor-runner.ts, src/run-log.ts, src/cli.ts
- tests/tool-gate.test.ts (new), tests/pipeline.test.ts, tests/run-log.test.ts
Do not edit roles.ts, hooks, docs, README, AGENTS.md, examples/, runs/. Do not commit, push or branch.

## Design (implement exactly this)
1. src/tool-gate.ts
   - Constants: `GATE_SHELL_TOOL = { id: "CG-GATE-001", name: "SHELL_TOOL_NOT_ALLOWED" }` and `GATE_SHELL_CALL = { id: "CG-GATE-002", name: "SHELL_CALL_RECORDED" }`.
   - `isShellTool(name: string): boolean`: true for "shell" and any name matching /shell|terminal|bash|exec/i.
   - `validateRoleTools(roleTools: Record<Role, ToolPolicy>, commandAllowlist: readonly string[] = []): string[]` returns one message per (role, tool) where the role's allowlist contains a shell tool and `commandAllowlist` is empty. Message: `CG-GATE-001 SHELL_TOOL_NOT_ALLOWED: role <role> is configured with tool <tool>; no orchestrator command allowlist was provided. See AGENTS.md section 4.` With a non-empty commandAllowlist, return [].
   - `extractRuleIds(text: string): string[]`: unique matches of /\bCG-[A-Z]+-\d{3}\b/g in order.
   - `interface PolicyEvent { label: string; role: Role; tool: string; ruleId: string; detail?: string }` and `policyEvents(runs: Array<{ role: Role; label: string; calls: ToolCallRecord[] }>): PolicyEvent[]`: for every call, one event per rule ID in `call.ruleIds`, plus a CG-GATE-002 event for every call where isShellTool(call.name) (even when it has no rule ID). `detail` is `truncate(redact(call.detail))` (src/redact.ts, src/tool-calls.ts).
2. src/types.ts: add optional `ruleIds?: string[]` to ToolCallRecord (doc comment: rule IDs found in the tool result, e.g. a hook deny).
3. src/cursor-runner.ts:
   - In collectToolCall, when the event has a `result`, stringify it defensively (string as-is, otherwise JSON.stringify in try/catch) and set `ruleIds` from extractRuleIds when non-empty.
   - In run(), before Agent.create: `const refused = validateRoleTools({ [req.role]: ROLE_TOOLS[req.role] } as Record<Role, ToolPolicy>, ...)` is awkward; instead add a small helper in tool-gate.ts `validateRoleToolList(role, tools, commandAllowlist)` that validateRoleTools uses, and call it here with ROLE_TOOLS[req.role].tools. If it returns messages, return `{ status: "error", text: "", toolCalls: [], error: messages.join("; ") }` without creating an agent. The runner gets an optional `commandAllowlist?: readonly string[]` option (default []).
4. src/pipeline.ts:
   - PipelineOptions gets `roleTools?: Record<Role, ToolPolicy>` (default ROLE_TOOLS from src/roles.ts) and `commandAllowlist?: readonly string[]` (default []).
   - At the start of runPipeline, right after validateBudget and before the baseline workspace inspection, run validateRoleTools; if it returns messages, return the report via the existing finish("ERROR", <messages joined by "; ">) path so that zero agent runs happen and the runner is never called.
   - PipelineReport gets `policyEvents: PolicyEvent[]`, computed in finish() from all runs.
5. src/run-log.ts:
   - formatToolCalls appends ` [<ruleIds joined by ",">]` to a call line when ruleIds is non-empty (after the redacted, truncated detail).
   - summary.json gets `policyEvents` (already redacted by policyEvents) when non-empty.
6. src/cli.ts: after printReport, if report.policyEvents is non-empty, print one line per event: `policy: <ruleId> <label> <tool> <detail>`. No new CLI flags.

## Tests (vitest, offline, fakes only; never a real agent)
- tests/tool-gate.test.ts: validateRoleTools rejects a role config with "shell" (message starts with "CG-GATE-001 SHELL_TOOL_NOT_ALLOWED: role coder"), accepts the real ROLE_TOOLS, accepts shell when commandAllowlist is non-empty; isShellTool cases; extractRuleIds (dedupe, ignores lowercase/near-misses); policyEvents emits a CG-SHELL-001 event for a call with ruleIds and a CG-GATE-002 event for a shell call, with redacted detail (use a fake token like "ghp_" + 36 alphanumerics built by concatenation, and assert it does not appear).
- tests/pipeline.test.ts: a pipeline with roleTools giving coder ["read","edit","shell"] returns outcome ERROR, message contains CG-GATE-001, runs is empty and the ScriptedRunner received zero requests; the same config with commandAllowlist ["python3 -m pytest"] proceeds normally. A run whose coder tool call has ruleIds ["CG-SHELL-001"] yields report.policyEvents with that rule ID.
- tests/run-log.test.ts: a tool call with ruleIds is written with " [CG-SHELL-001]" and redacted detail; summary.json contains policyEvents.
- Keep all existing tests passing (update fakes only where the new required report field needs it).

## Verify before you finish (only these commands)
export PATH=$PWD/.node22/bin:$PATH
npx prettier --write src tests   (formatting only)
npm run -s format:check && npm run -s typecheck && npx vitest run
Never install packages, never run npm run pipeline or npm run demo:replay with a real agent, never print environment variables or secrets, no network.

Finish with a short summary: files changed, new exports, test counts.

````

## Final response

````text
Step 2 is done. All gates pass.

## Summary

### Files changed
| File | Change |
|------|--------|
| `src/tool-gate.ts` | **New** — shell detection, role-tool validation, rule-ID extraction, policy events |
| `src/types.ts` | Optional `ruleIds?: string[]` on `ToolCallRecord` |
| `src/cursor-runner.ts` | Pre-run validation; `ruleIds` from tool results; `commandAllowlist` option |
| `src/pipeline.ts` | `roleTools` / `commandAllowlist` options; startup gate; `policyEvents` on report |
| `src/run-log.ts` | Rule IDs in tool-call lines; `policyEvents` in `summary.json` |
| `src/cli.ts` | Prints `policy: …` lines after the report |
| `tests/tool-gate.test.ts` | **New** — 6 tests |
| `tests/pipeline.test.ts` | +3 tests (shell gate, allowlist bypass, policy events) |
| `tests/run-log.test.ts` | +1 test (rule IDs + summary) |

### New exports (`src/tool-gate.ts`)
- `GATE_SHELL_TOOL`, `GATE_SHELL_CALL`
- `isShellTool`, `validateRoleToolList`, `validateRoleTools`, `extractRuleIds`
- `PolicyEvent`, `policyEvents`

### Tests
**333 passed** (17 files), including **6** new tool-gate tests and **4** new/updated pipeline + run-log tests.
````
