# 0002. Hard run budget per pipeline

Date: 2026-10-04
Status: Accepted

## Context

Multi-agent loops are the usual way agent workflows overspend: a reviewer keeps failing, the
coder keeps retrying. The SDK has no max-turns or token-budget option, so limits have to be
enforced by the orchestrator. Usage draws from the owner's Pro plan.

## Decision

- Model `composer-2.5` with `fast=false` pinned explicitly (unspecified params default to the
  first allowed value).
- At most 2 planned tasks, 1 coder retry, 6 agent runs per pipeline. The cap equals the worst
  case, and `validateBudget` rejects any configuration where the cap is below it.
- 8 minute wall-clock timeout per run, then `run.cancel()`.
- No retries on infrastructure errors: an errored or cancelled run ends the pipeline.
- Usage from every `RunResult.usage` is summed and printed with a list-price estimate.

## Alternatives considered

- **Token budget.** Usage is only reported at turn end, so a token cap can only stop the next
  run, not the current one. The run cap gives the same bound with simpler semantics.
- **One long-lived agent across roles.** Fewer creates, but context (and input tokens) grows
  with every step and roles could not have different tool policies.

## Consequences

- Larger goals do not fit in two tasks; that is intentional for a demo. Raising limits needs a
  new ADR.
- Success: no pipeline run exceeds 6 agent runs, and every run's usage is in `summary.json`.
