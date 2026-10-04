# AGENTS.md (examples/target)

Instructions for AI agents working in this directory. This file governs everything under
`examples/target/`. It is read by headless agents driven by the pipeline in the parent repo,
so nobody is available to answer questions: when something is ambiguous, choose the simplest
behaviour consistent with this file and state the assumption in your final message.

## 1. Project

`textstats`: small, pure text statistics helpers. The goal for the current work is in
`GOAL.md`. Non-goals: CLI, packaging/publishing, NLP libraries, language detection.

## 2. Layout

```text
examples/target/
|-- AGENTS.md            # this file (do not edit)
|-- GOAL.md              # the goal (do not edit)
|-- pyproject.toml       # metadata + pytest config (do not edit)
|-- textstats.py         # the module: all library code lives here
`-- tests/
    `-- test_textstats.py
```

Do not create other files or folders (no `__init__.py` in `tests/`, no `conftest.py`).

## 3. Commands

| Task | Command |
|------|---------|
| Run tests | `python3 -m pytest -q` (from this directory) |

Do not install packages, create virtualenvs, or run git commands.

## 4. Coding conventions

- Python 3.12, standard library only. No third-party imports anywhere, including tests
  (pytest itself is the only exception).
- Type hints on every public function. Google-style docstrings with `Args:` and `Returns:`.
- Pure functions: no I/O, no global state, no printing.
- ASCII only in code and comments.
- Validate arguments explicitly and raise `ValueError` with a clear message (for example
  `n < 0` or `wpm <= 0`). Do not use `assert` for validation.
- Keep it small: the whole module should stay well under 150 lines.

## 5. Behaviour contract

Unless `GOAL.md` says otherwise:

- A word is a maximal run of letters, digits, or apostrophes (`re` pattern `[A-Za-z0-9']+`),
  compared case-insensitively where counting matters.
- A sentence ends at one or more of `.`, `!`, `?`. Trailing text without a terminator counts
  as a sentence if it contains a word. Empty or whitespace-only text has 0 sentences.
- `top_words` returns `list[tuple[str, int]]`, lowercase words, sorted by count descending and
  then alphabetically, so the output is deterministic.
- `reading_time_minutes` returns a `float` rounded to 2 decimals; empty text returns `0.0`.

## 6. Tests

- Every public function has tests for the normal case, empty input, and each `ValueError`.
- Tests are deterministic and offline. Use plain `assert` in tests and `pytest.raises`.
- Do not weaken or delete existing tests to make something pass.

## 7. Definition of done

- `python3 -m pytest -q` exits 0.
- Only files from section 2 were created or changed.
- Final message lists files changed, the test result line, and any assumptions.
