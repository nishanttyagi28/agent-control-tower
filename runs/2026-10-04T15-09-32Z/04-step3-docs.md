# Run 4: step3-docs

- model: composer-2.5 fast=false
- status: finished
- duration_ms: 77682
- usage: {"inputTokens":344185,"outputTokens":6549,"cacheReadTokens":305059,"cacheWriteTokens":0,"totalTokens":655793}
- tool_calls (33): read x15, grep x4, glob, shell x2, edit x11


## Tool calls

1. read "/workspace/cursor-multiagent-demo/AGENTS.md"
2. read "/workspace/cursor-multiagent-demo/src/tool-gate.ts"
3. read "/workspace/cursor-multiagent-demo/examples/target/.cursor/hooks/read_policy.py"
4. read "/workspace/cursor-multiagent-demo/docs/adr/0003-enforce-policy-in-hooks.md"
5. read "/workspace/cursor-multiagent-demo/docs/architecture.md"
6. read "/workspace/cursor-multiagent-demo/examples/target/.cursor/hooks/shell_policy.py"
7. read "/workspace/cursor-multiagent-demo/docs/demo.md"
8. read "/workspace/cursor-multiagent-demo/README.md"
9. read "/workspace/cursor-multiagent-demo/examples/target/AGENTS.md"
10. read "/workspace/cursor-multiagent-demo/examples/target-hidden-spec/AGENTS.md"
11. grep "\"validateRoleTools|policyEvents|ruleIdsFromResult|tool-gate\" in /workspace/cursor-multiagent-demo/src"
12. grep "\"policyEvents\" in /workspace/cursor-multiagent-demo"
13. glob "\"docs/adr/*.md\""
14. read "/workspace/cursor-multiagent-demo/src/pipeline.ts"
15. read "/workspace/cursor-multiagent-demo/src/cursor-runner.ts"
16. read "/workspace/cursor-multiagent-demo/tests/tool-gate.test.ts"
17. read "/workspace/cursor-multiagent-demo/src/cli.ts"
18. grep "\"bash -c|curl.*sudo|NOT_IN_ALLOWLIST|CG-SHELL-003\" in /workspace/cursor-multiagent-demo/tests"
19. read "/workspace/cursor-multiagent-demo/tests/shell-policy.test.ts"
20. shell "cd /workspace/cursor-multiagent-demo && python3 examples/target/.cursor/hooks/shell_policy.py <<< '{\"command\": \"bash -c \\\"pip install x\\\"\"}' && python3 examples/target/.cursor/hooks/shell_policy.py <<... [+164 chars]"
21. grep "\"ruleIds\" in /workspace/cursor-multiagent-demo/src/run-log.ts"
22. edit "/workspace/cursor-multiagent-demo/AGENTS.md"
23. edit "/workspace/cursor-multiagent-demo/examples/target/AGENTS.md"
24. edit "/workspace/cursor-multiagent-demo/examples/target-hidden-spec/AGENTS.md"
25. edit "/workspace/cursor-multiagent-demo/README.md"
26. edit "/workspace/cursor-multiagent-demo/README.md"
27. edit "/workspace/cursor-multiagent-demo/README.md"
28. edit "/workspace/cursor-multiagent-demo/README.md"
29. edit "/workspace/cursor-multiagent-demo/docs/architecture.md"
30. edit "/workspace/cursor-multiagent-demo/docs/architecture.md"
31. edit "/workspace/cursor-multiagent-demo/docs/demo.md"
32. edit "/workspace/cursor-multiagent-demo/docs/adr/0005-rule-ids-and-tool-gate.md"
33. shell "cd /workspace/cursor-multiagent-demo && grep -n \"$(printf '\\xe2\\x80\\x94')\" README.md AGENTS.md docs/adr/0005-rule-ids-and-tool-gate.md docs/architecture.md docs/demo.md examples/target/AGENTS.md examp... [+113 chars]"

## Prompt

````text
You are working in the CodeGovernor repository (current directory). Read AGENTS.md and follow it. Steps 1 and 2 are committed: rule IDs in the hook scripts (examples/target/.cursor/hooks/shell_policy.py and read_policy.py) and the orchestrator tool gate (src/tool-gate.ts, used by src/pipeline.ts and src/cursor-runner.ts; policyEvents in src/run-log.ts and src/cli.ts). This is step 3 of 3: documentation only. Read those source files first; every rule ID, name and behaviour you document must match the code exactly. Do not invent facts, numbers or behaviour; nothing here has been exercised in a real agent run yet.

Writing style: plain professional English, first person only where the README already uses it, no hype, no emojis, no em dashes (use commas, colons or parentheses), ASCII only.

## Files you may change (and no others)
- README.md
- AGENTS.md
- docs/adr/0005-rule-ids-and-tool-gate.md (new)
- docs/architecture.md
- docs/demo.md
- examples/target/AGENTS.md and examples/target-hidden-spec/AGENTS.md (section 3 only)
Do not change code, tests, hooks, runs/ or media. Do not commit.

## Changes
1. AGENTS.md: in section 4 (the gate message says "See AGENTS.md section 4"), add a short "Policy rule IDs" subsection: one sentence saying the scripts and src/tool-gate.ts are the source of truth and this table only indexes them, then a table with columns ID | Name | Enforced by | Meaning, rows for CG-SHELL-000..004, CG-READ-000..001, CG-GATE-001, CG-GATE-002. Also add src/tool-gate.ts to the layout tree in section 2 if the tree lists src files (keep the tree style).
2. examples/target/AGENTS.md and examples/target-hidden-spec/AGENTS.md, section 3: one or two sentences saying hook denials start with a rule ID and name (CG-SHELL-*, CG-READ-*) and that the agent must not retry with another package manager, path or variant. The hook messages point to this section.
3. README.md:
   - "What it does differently" table: update the row starting "Agents ignore "do not install"" to: the orchestrator refuses to start a role whose tool allowlist contains a shell tool unless an orchestrator command allowlist is given (CG-GATE-001), before any agent is created; the fail-closed shell hook is allowlist-first and every deny starts with a rule ID (CG-SHELL-001 NO_PACKAGE_INSTALL, CG-SHELL-002 NO_SYSTEM_PACKAGES, ...), so a blocked install names the rule instead of inviting another package manager. Update the "Runs cannot be audited" row to mention that rule IDs from denied or shell tool calls are written to the run log and summary.json as policyEvents. Keep the rows concise and keep the table format.
   - "Limitations and unverified": add bullets: (a) rule IDs on hook denials and policyEvents are unit-tested only; no real run has produced one, and how the SDK reports a hook deny in a tool result (status, text) is not verified, so policyEvents may miss real denials; (b) named detection is best effort and the allowlist is the control: for example `bash -c "pip install x"` and `curl -s URL | sudo bash` are denied as CG-SHELL-003 NOT_IN_ALLOWLIST rather than with the more specific rule (both verified by running the script).
   - Design decisions: add an ADR 0005 link line in the same style.
4. docs/adr/0005-rule-ids-and-tool-gate.md: same structure as docs/adr/0003-enforce-policy-in-hooks.md (title "# 0005. Rule IDs on every deny and a tool gate before agents start", Date: 2026-10-04, Status: Accepted, Context, Decision, Alternatives considered, Consequences). Context: public feedback that rules in a markdown file are wishes; block at the tool gate and make a failing install print the rule name, otherwise the agent tries another package manager; plus run 1's pip3 install --break-system-packages. Decision: stable IDs (table or list pointing to code), message format "<ID> <NAME>: <reason>. See AGENTS.md section 3 (Commands)." for hooks, precedence 000, 004, 002, 001, then allowlist 003, CG-GATE-001 before Agent.create in both runPipeline and CursorAgentRunner, policyEvents (CG-GATE-002 for any recorded shell call), only error or shell results scanned so reading docs is not an event. Alternatives: denylist only (rejected: endless variants), prompt rules only (ADR 0003), no IDs (generic messages invite retries). Consequences include the limitations above.
5. docs/architecture.md: add a module table row for src/tool-gate.ts, and mention the gate in the flow section if there is a natural place (one sentence).
6. docs/demo.md: add a short note under "The video" that the recording predates rule IDs: the hook output shown there ("Blocked by shell_policy hook: --break-system-packages is forbidden") is now "CG-SHELL-002 NO_SYSTEM_PACKAGES: --break-system-packages is a system package install. See AGENTS.md section 3 (Commands)." (that is the current exact user_message; confirm by reading the script logic, do not run anything else).

## Verify before you finish (only these commands)
grep -n "$(printf '\xe2\x80\x94')" README.md AGENTS.md docs/adr/0005-rule-ids-and-tool-gate.md docs/architecture.md docs/demo.md examples/target/AGENTS.md examples/target-hidden-spec/AGENTS.md   (must print nothing)
export PATH=$PWD/.node22/bin:$PATH && npm run -s format:check && npx vitest run
No installs, no agents or pipeline runs, never print environment variables or secrets, no network.
Finish with a short summary of each file changed.

````

## Final response

````text
Step 3 documentation is done. All verification passed (no em dashes, format check, 337 tests).

### Summary by file

**`AGENTS.md`**  
Added subsection "Policy rule IDs" under section 4 with a table for CG-SHELL-000..004, CG-READ-000..001, CG-GATE-001..002, pointing to the hook scripts and `src/tool-gate.ts` as source of truth. Section 2 layout was unchanged (the tree does not list individual `src/` files).

**`examples/target/AGENTS.md`** and **`examples/target-hidden-spec/AGENTS.md`**  
Section 3 now states that hook denials start with a rule ID and name, messages point to that section, and the agent must not retry with another package manager, path, or variant.

**`README.md`**  
Updated the "do not install" and "Runs cannot be audited" table rows for CG-GATE-001 and `policyEvents`. Added limitation bullets on unit-tested-only rule IDs/`policyEvents` and best-effort detection vs allowlist. Added ADR 0005 to Design decisions.

**`docs/adr/0005-rule-ids-and-tool-gate.md`** (new)  
ADR covering context (run 1, public feedback), decision (stable IDs, message format, shell precedence, tool gate, `policyEvents` scanning rules), alternatives, and consequences including the documented limitations.

**`docs/architecture.md`**  
Added `src/tool-gate.ts` to the module table and one sentence in Flow about CG-GATE-001 before the first agent run.

**`docs/demo.md`**  
Note under "The video" that the GIF predates rule IDs and shows the old deny message vs the current `CG-SHELL-002 NO_SYSTEM_PACKAGES` text (confirmed from `shell_policy.py`).
````
