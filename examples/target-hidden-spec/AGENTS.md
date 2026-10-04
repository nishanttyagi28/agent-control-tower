# AGENTS.md (examples/target-hidden-spec)

Instructions for AI agents working in this directory. This file governs everything under
`examples/target-hidden-spec/`. Agents here run headless: nobody answers questions, so when
something is ambiguous choose the simplest behaviour consistent with this file and state the
assumption in your final message.

## 1. Project

`durations`: parse and format human-readable durations. The goal is in `GOAL.md`.
The orchestrator also runs acceptance tests that live outside this directory. If they fail,
their output is passed back to you; treat a failing acceptance test as a requirement.
Non-goals: days/weeks units, fractional values, localisation, a CLI.

## 2. Layout

```text
examples/target-hidden-spec/
|-- AGENTS.md            # this file (do not edit)
|-- GOAL.md              # the goal (do not edit)
|-- pyproject.toml       # metadata + pytest config (do not edit)
|-- .cursor/hooks.json   # shell allowlist + read-scope hooks (do not edit)
|-- durations.py         # the module: all library code lives here
`-- tests/
    `-- test_durations.py
```

Do not create other files or folders (no `__init__.py` in `tests/`, no `conftest.py`).

## 3. Commands

| Task | Command |
|------|---------|
| Run tests | `.venv/bin/python -m pytest -q` (the orchestrator runs this; agents have no shell) |

Do not install packages, create virtualenvs, or run git commands. A `beforeShellExecution`
hook (`.cursor/hooks/shell_policy.py`) enforces this: only `python3 -m pytest` and
`python3 -m compileall` (or the same via `.venv/bin/python`) are allowed.
A `beforeReadFile` hook (`.cursor/hooks/read_policy.py`) denies reading any file outside
this directory.

## 4. Coding conventions

- Python 3.12, standard library only (pytest is the only exception, in tests).
- Type hints on every public function. Google-style docstrings with `Args:`, `Returns:`,
  `Raises:`.
- Pure functions: no I/O, no global state, no printing. ASCII only.
- Invalid input raises `ValueError` with a clear message. No `assert` for validation.
- Keep the module well under 120 lines.

## 5. Tests

- Every public function has tests for the normal case, edge cases, and each `ValueError`.
- Tests are deterministic and offline. Plain `assert` and `pytest.raises`.
- Do not weaken or delete existing tests to make something pass.

## 6. Definition of done

- The test suite (including the orchestrator's acceptance tests) exits 0.
- Only files from section 2 were created or changed.
- Final message lists files changed and any assumptions.
