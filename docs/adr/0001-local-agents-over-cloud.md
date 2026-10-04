# 0001. Local agents over cloud agents

Date: 2026-10-04
Status: Accepted

## Context

`@cursor/sdk` offers two runtimes behind one `Agent.create` call: local (agent loop runs in this
Node process, files come from disk) and cloud (provider-hosted VM with the repo cloned in). Model
inference is hosted by the provider in both. The owner's individual paid plan is used for this
project and cost must stay small and predictable.

## Decision

Use local agents only: `Agent.create({ local: { cwd, settingSources: ["project"] } })`. No code
path passes `cloud`.

## Alternatives considered

- **Cloud agents.** Isolation, parallelism, and survival across disconnects, but they need a
  connected GitHub repo, spin up VMs, and are not part of the plan this demo targets.
- **The agent runtime's CLI in a subprocess.** Workable, but stream parsing and usage accounting would be
  hand-rolled instead of typed (`RunResult.usage`, `SDKMessage`).

## Consequences

- The coder edits the local working tree directly, so the target workspace must be one we are
  happy to have modified. Runs are reviewable with `git diff`.
- Local tool calls run without approval in headless mode. This is mitigated by per-role tool
  policies (ADR context in `docs/architecture.md`), not by a sandbox.
- Requires Node.js >= 22.13 (SDK engine requirement).
- Success: a full pipeline completes on a laptop with the summed usage reported at the end.
