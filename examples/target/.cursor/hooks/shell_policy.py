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

# Stable rule IDs (precedence: 000, 004, 002, 001, allowlist -> 003).
RULE_INVALID = ("CG-SHELL-000", "INVALID_HOOK_INPUT")
RULE_NO_PACKAGE = ("CG-SHELL-001", "NO_PACKAGE_INSTALL")
RULE_NO_SYSTEM = ("CG-SHELL-002", "NO_SYSTEM_PACKAGES")
RULE_NOT_ALLOWLIST = ("CG-SHELL-003", "NOT_IN_ALLOWLIST")
RULE_NO_REMOTE = ("CG-SHELL-004", "NO_REMOTE_SCRIPT")

AGENTS_REF = "See AGENTS.md section 3 (Commands)."
AGENT_SUFFIX = (
    " Do not retry with another package manager, path or variant; only "
    "'python3 -m pytest' and 'python3 -m compileall' are allowed and the orchestrator "
    "owns the environment."
)

SHELL_META = re.compile(r"[;|&`$<>\n\r]")
SIMPLE_CMD_SPLIT = re.compile(r"&&|\|\||[;&|\n\r&]")
PYTHON_BIN = re.compile(r"^python3?(\.\d+)?$")
REMOTE_SCRIPT = re.compile(
    r"(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh|dash|python3?|perl|ruby)\b",
    re.IGNORECASE,
)

# (basename, subcommands or None for any invocation)
SYSTEM_PACKAGE_MANAGERS: tuple[tuple[str, frozenset[str] | None], ...] = (
    ("apt", None),
    ("apt-get", None),
    ("dpkg", None),
    ("yum", None),
    ("dnf", None),
    ("apk", None),
    ("pacman", None),
    ("brew", None),
    ("port", None),
)

# Each entry: (basename matcher, subcommands or None for any, reason fragment)
PACKAGE_INSTALL_RULES: tuple[tuple[re.Pattern[str] | str, frozenset[str] | None, str], ...] = (
    (re.compile(r"^pip3?(\.\d+)?$"), None, "pip"),
    ("pipx", None, "pipx"),
    ("easy_install", None, "easy_install"),
    ("uv", frozenset({"pip", "add", "tool"}), "uv"),
    ("poetry", frozenset({"add", "install"}), "poetry"),
    ("pdm", frozenset({"add", "install"}), "pdm"),
    ("conda", frozenset({"install", "create", "update"}), "conda"),
    ("mamba", frozenset({"install", "create", "update"}), "mamba"),
    ("micromamba", frozenset({"install", "create", "update"}), "micromamba"),
    ("npm", frozenset({"install", "i", "ci", "add"}), "npm"),
    ("npx", None, "npx"),
    ("yarn", frozenset({"add", "install"}), "yarn"),
    ("pnpm", frozenset({"add", "install", "i"}), "pnpm"),
    ("bun", frozenset({"add", "install", "i"}), "bun"),
    ("cargo", frozenset({"install", "add"}), "cargo"),
    ("go", frozenset({"install", "get"}), "go"),
    ("gem", frozenset({"install"}), "gem"),
    ("composer", frozenset({"install", "require"}), "composer"),
)


def workspace_root() -> Path:
    # Derived from this file's location (<ws>/.cursor/hooks/shell_policy.py), not from hook
    # input, so the agent cannot widen the allowlist by changing cwd.
    return Path(__file__).resolve().parents[2]


def allowed_interpreters(root: Path) -> set[str]:
    venv_python = root / ".venv" / "bin" / "python"
    return {"python3", str(venv_python), ".venv/bin/python", "./.venv/bin/python"}


def format_deny(rule: tuple[str, str], reason: str) -> tuple[str, str]:
    rule_id, rule_name = rule
    user_message = f"{rule_id} {rule_name}: {reason}. {AGENTS_REF}"
    return user_message, user_message + AGENT_SUFFIX


def strip_cd_prefix(command: str, root: Path) -> str:
    match = re.match(r"^\s*cd\s+(\S+)\s*&&\s*(.*)$", command, re.DOTALL)
    if match is None:
        return command
    target = match.group(1).strip("'\"")
    if Path(target).resolve() != root and target not in (".", "./"):
        return command  # leaves "&&" in place, which SHELL_META rejects below
    return match.group(2)


def extract_segments(command: str) -> list[str]:
    """Collect the raw command and nested subshell/command-substitution fragments."""
    segments = [command]
    for pattern in (r"\$\(([^)]*)\)", r"`([^`]*)`", r"\(([^)]*)\)"):
        for match in re.finditer(pattern, command):
            segments.append(match.group(1))
    return segments


def split_simple_commands(text: str) -> list[str]:
    return [part.strip() for part in SIMPLE_CMD_SPLIT.split(text) if part.strip()]


def tokenize_simple_command(text: str) -> list[str] | None:
    try:
        return shlex.split(text)
    except ValueError:
        parts = text.split()
        return parts if parts else None


def strip_wrappers(argv: list[str]) -> list[str]:
    idx = 0
    while idx < len(argv):
        word = argv[idx]
        if word == "sudo":
            idx += 1
            while idx < len(argv) and argv[idx].startswith("-") and argv[idx] not in ("-u",):
                idx += 1
            if idx < len(argv) and argv[idx] == "-u":
                idx += 2
            continue
        if word in ("doas", "command", "exec", "nohup", "time", "nice", "xargs"):
            idx += 1
            continue
        if word == "env":
            idx += 1
            while idx < len(argv):
                arg = argv[idx]
                if "=" in arg and not arg.startswith("-"):
                    idx += 1
                    continue
                if arg in ("-i", "-u", "--"):
                    idx += 2 if arg != "--" else 1
                    continue
                break
            continue
        if "=" in word and not word.startswith("-"):
            idx += 1
            continue
        break
    return argv[idx:]


def argv_base(argv: list[str]) -> str:
    return Path(argv[0]).name


def check_remote_script(command: str) -> str | None:
    if REMOTE_SCRIPT.search(command):
        return "curl or wget piped into a shell or interpreter is forbidden"
    return None


def check_break_system_packages(command: str) -> str | None:
    if "--break-system-packages" in command:
        return "--break-system-packages is a system package install"
    return None


def matches_manager(
    base: str,
    argv: list[str],
    managers: tuple[tuple[str, frozenset[str] | None], ...],
    label: str,
) -> str | None:
    for name, subcommands in managers:
        if base != name:
            continue
        if subcommands is None:
            return f"{base} is a {label}"
        if len(argv) >= 2 and argv[1] in subcommands:
            if base == "uv" and argv[1] == "tool":
                if len(argv) >= 3 and argv[2] == "install":
                    return "uv tool install is a package install"
                continue
            return f"{base} {argv[1]} is a {label}"
        if base == "yarn" and len(argv) == 1:
            return "yarn is a package install"
    return None


def check_python_module_install(argv: list[str]) -> str | None:
    if not argv or not PYTHON_BIN.match(argv_base(argv)):
        return None
    if len(argv) >= 3 and argv[1] == "setup.py" and argv[2] == "install":
        return f"{argv_base(argv)} setup.py install is a package install"
    if len(argv) >= 3 and argv[1] == "-m":
        if argv[2] == "pip":
            return f"{argv_base(argv)} -m pip is a package install"
    return None


def check_package_install(command: str) -> str | None:
    for segment in extract_segments(command):
        for simple in split_simple_commands(segment):
            argv = tokenize_simple_command(simple)
            if not argv:
                continue
            argv = strip_wrappers(argv)
            if not argv:
                continue
            reason = check_python_module_install(argv)
            if reason:
                return reason
            base = argv_base(argv)
            for pattern, subcommands, _label in PACKAGE_INSTALL_RULES:
                if isinstance(pattern, re.Pattern):
                    if not pattern.match(base):
                        continue
                    if subcommands is None or (len(argv) >= 2 and argv[1] in subcommands):
                        if base.startswith("pip"):
                            return f"{base} install is a package install"
                        return f"{base} is a package install"
                    continue
                reason = matches_manager(base, argv, ((pattern, subcommands),), "package install")
                if reason:
                    return reason
    return None


def check_system_packages(command: str) -> str | None:
    reason = check_break_system_packages(command)
    if reason:
        return reason
    for segment in extract_segments(command):
        for simple in split_simple_commands(segment):
            argv = tokenize_simple_command(simple)
            if not argv:
                continue
            argv = strip_wrappers(argv)
            if not argv:
                continue
            base = argv_base(argv)
            reason = matches_manager(base, argv, SYSTEM_PACKAGE_MANAGERS, "system package manager")
            if reason:
                return reason
    return None


def check_allowlist(command: str, root: Path) -> tuple[str, str] | None:
    """Return None if allowed, else (rule, reason)."""
    if not command.strip():
        return RULE_NOT_ALLOWLIST, "empty command is not allowlisted"
    rest = strip_cd_prefix(command, root)
    if SHELL_META.search(rest):
        return RULE_NOT_ALLOWLIST, "shell operators are not allowed; run one allowlisted command"
    try:
        argv = shlex.split(rest)
    except ValueError:
        return RULE_NOT_ALLOWLIST, "command could not be parsed"
    if len(argv) < 3 or argv[1] != "-m":
        return RULE_NOT_ALLOWLIST, "only 'python3 -m pytest' or 'python3 -m compileall' are allowed"
    if argv[0] not in allowed_interpreters(root):
        return RULE_NOT_ALLOWLIST, f"interpreter {argv[0]!r} is not allowlisted"
    if argv[2] not in ALLOWED_MODULES:
        return RULE_NOT_ALLOWLIST, f"module {argv[2]!r} is not allowlisted"
    return None


def decide(command: str, root: Path) -> tuple[str, str, str | None]:
    """Return (permission, user_message, agent_message). agent_message is None when allowed."""
    remote = check_remote_script(command)
    if remote:
        user, agent = format_deny(RULE_NO_REMOTE, remote)
        return "deny", user, agent

    system = check_system_packages(command)
    if system:
        user, agent = format_deny(RULE_NO_SYSTEM, system)
        return "deny", user, agent

    package = check_package_install(command)
    if package:
        user, agent = format_deny(RULE_NO_PACKAGE, package)
        return "deny", user, agent

    blocked = check_allowlist(command, root)
    if blocked:
        rule, reason = blocked
        user, agent = format_deny(rule, reason)
        return "deny", user, agent

    return "allow", "allowlisted", None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        command = payload["command"]
        if not isinstance(command, str):
            raise TypeError("command must be a string")
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        reason = f"invalid hook input: {exc}"
        user_message, agent_message = format_deny(RULE_INVALID, reason)
        permission = "deny"
    else:
        permission, user_message, agent_message = decide(command, workspace_root())
        if permission == "allow":
            user_message = "allowlisted"

    response: dict[str, str] = {"permission": permission}
    if permission == "deny":
        response["user_message"] = user_message
        response["agent_message"] = agent_message
    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
