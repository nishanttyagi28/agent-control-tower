#!/usr/bin/env python3
"""beforeShellExecution hook: allowlist shell commands for agents in this workspace.

Contract (https://cursor.com/docs/agent/hooks): JSON on stdin with at least "command";
JSON on stdout with "permission" set to "allow" or "deny". Registered with failClosed, so a
crash or timeout also blocks the command.

Allowed, and nothing else:
  python3 -m pytest [args]          python3 -m compileall [args]
  <workspace>/.venv/bin/python -m pytest|compileall [args]   (absolute or .venv/bin/python)
optionally prefixed by "cd <workspace> && ". Any other shell syntax (; | & ` $ < > newline)
is rejected so an allowed prefix cannot smuggle a second command.
"""

from __future__ import annotations

import json
import re
import shlex
import sys
from pathlib import Path

ALLOWED_MODULES = ("pytest", "compileall")

# Checked first so the agent gets a specific reason for the most common escape attempts.
FORBIDDEN_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"--break-system-packages", "--break-system-packages is forbidden"),
    (r"(^|[\s/;&|(])pip3?(\s|$)", "pip is forbidden; the orchestrator owns the environment"),
    (r"-m\s+pip(\s|$)", "python -m pip is forbidden; the orchestrator owns the environment"),
    (r"(^|[\s;&|(])uv\s+pip(\s|$)", "uv pip is forbidden"),
    (r"(^|[\s;&|(])conda\s+install(\s|$)", "conda install is forbidden"),
    (r"(^|[\s/;&|(])apt(-get)?(\s|$)", "apt/apt-get is forbidden"),
    (r"(^|[\s;&|(])npm\s+(install|i|ci|add)(\s|$)", "npm install is forbidden"),
)

SHELL_META = re.compile(r"[;|&`$<>\n\r]")


def workspace_root() -> Path:
    # Derived from this file's location (<ws>/.cursor/hooks/shell_policy.py), not from hook
    # input, so the agent cannot widen the allowlist by changing cwd.
    return Path(__file__).resolve().parents[2]


def allowed_interpreters(root: Path) -> set[str]:
    venv_python = root / ".venv" / "bin" / "python"
    return {"python3", str(venv_python), ".venv/bin/python", "./.venv/bin/python"}


def strip_cd_prefix(command: str, root: Path) -> str:
    match = re.match(r"^\s*cd\s+(\S+)\s*&&\s*(.*)$", command, re.DOTALL)
    if match is None:
        return command
    target = match.group(1).strip("'\"")
    if Path(target).resolve() != root and target not in (".", "./"):
        return command  # leaves "&&" in place, which SHELL_META rejects below
    return match.group(2)


def decide(command: str, root: Path) -> tuple[str, str]:
    """Return ("allow" | "deny", reason)."""
    if not command.strip():
        return "deny", "empty command"
    for pattern, reason in FORBIDDEN_PATTERNS:
        if re.search(pattern, command):
            return "deny", reason
    rest = strip_cd_prefix(command, root)
    if SHELL_META.search(rest):
        return "deny", "shell operators are not allowed; run one allowlisted command"
    try:
        argv = shlex.split(rest)
    except ValueError:
        return "deny", "command could not be parsed"
    if len(argv) < 3 or argv[1] != "-m":
        return "deny", "only 'python3 -m pytest' or 'python3 -m compileall' are allowed"
    if argv[0] not in allowed_interpreters(root):
        return "deny", f"interpreter {argv[0]!r} is not allowed"
    if argv[2] not in ALLOWED_MODULES:
        return "deny", f"module {argv[2]!r} is not allowed"
    return "allow", "allowlisted"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        command = payload["command"]
        if not isinstance(command, str):
            raise TypeError("command must be a string")
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        permission, reason = "deny", f"invalid hook input: {exc}"
    else:
        permission, reason = decide(command, workspace_root())

    response: dict[str, str] = {"permission": permission}
    if permission == "deny":
        response["user_message"] = f"Blocked by shell_policy hook: {reason}"
        response["agent_message"] = (
            f"Command blocked: {reason}. Do not retry variants. Only 'python3 -m pytest' and "
            "'python3 -m compileall' are allowed; the orchestrator runs tests and owns the env."
        )
    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
