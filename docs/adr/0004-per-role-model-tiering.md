# 0004. Per-role models, defaulting to one cheap model

Date: 2026-10-04
Status: Accepted

## Context

The three roles do different work. The planner and reviewer read a lot and write a little;
the coder writes the code. In run 1 the coders used 84% of the tokens; in run 2 they used 38%,
and reviewer#2 alone used 34%. A common pattern is model tiering: a cheaper model
for high-volume roles and a stronger one where judgement matters (often the reviewer).

The owner of this repo is quota-conscious and has a standing rule: no model other than
`composer-2.5` (`fast=false`) unless explicitly chosen.

## Decision

- `src/config.ts` has `RoleModels` (`planner`, `coder`, `reviewer`). `DEFAULT_ROLE_MODELS`
  sets all three to `composer-2.5` with `fast=false`. Tiering is opt-in.
- The CLI takes `--planner-model`, `--coder-model` and `--reviewer-model`, plus the env vars
  `PLANNER_MODEL`, `CODER_MODEL` and `REVIEWER_MODEL`. `--model` sets all three. Precedence
  per role: role flag > role env > `--model` > default.
- A spec is `id` or `id:param=value,...`. A bare `composer-2.5` keeps `fast=false`. Other ids get
  only the params given, because the SDK fills unspecified params with their first allowed
  value, which can be a fast or high-effort variant. Pin params explicitly when tiering.
- Cost is estimated per run with that run's model. Only prices verified on the pricing page
  are in `MODEL_PRICES` (today: `composer-2.5`). Runs on other models are reported as
  `unpricedModels` instead of being guessed.

## Trade-offs

| Option | Cost | Quality risk | Notes |
|---|---|---|---|
| All `composer-2.5` (default) | lowest, predictable | reviewer may miss subtle defects | the deterministic gate (tests, scope, path checks) carries most of the safety |
| Stronger reviewer only | +1-2 runs at a higher rate | lower | reviewer runs are few, but reviewer#2 in run 2 read a lot (250k tokens) |
| Stronger coder | the largest token share at a higher rate | lower defect rate, fewer retries | can pay off if it saves a retry round (2 runs) |
| Stronger planner | 1 run | better task split and file lists | cheap to try; a bad plan wastes every later run |

Measure before switching. Compare `summary.json` across runs with the same goal. A tier
change is worth it only if it lowers retries or FAILs enough to pay for the higher rate.

## Consequences

- No behaviour or cost change by default.
- Each run log and `summary.json` records the model per run, so tiering experiments can be
  compared.
- Estimates for unpriced models are missing, not wrong. Add a price to `MODEL_PRICES` only
  from the official pricing page.
