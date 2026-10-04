#!/usr/bin/env python3
"""beforeReadFile hook: agents may only read files inside this workspace.

Contract (https://cursor.com/docs/agent/hooks): JSON on stdin with "file_path" (absolute),
"content" and "attachments"; JSON on stdout with "permission" ("allow" | "deny") and an
optional "user_message". Registered with failClosed, so a crash or timeout blocks the read.

The workspace root is derived from this file's location (<ws>/.cursor/hooks/read_policy.py),
never from hook input. Paths are resolved (symlinks and "..") before the check, so a link
inside the workspace that points outside it is denied too.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def decide(file_path: str, root: Path) -> tuple[str, str]:
    """Return ("allow" | "deny", reason)."""
    if not file_path.strip():
        return "deny", "empty file_path"
    candidate = Path(file_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if resolved == root or root in resolved.parents:
        return "allow", "inside workspace"
    return "deny", f"{file_path} is outside the workspace {root}"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        file_path = payload["file_path"]
        if not isinstance(file_path, str):
            raise TypeError("file_path must be a string")
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        permission, reason = "deny", f"invalid hook input: {exc}"
    else:
        permission, reason = decide(file_path, workspace_root())

    response: dict[str, str] = {"permission": permission}
    if permission == "deny":
        response["user_message"] = f"Blocked by read_policy hook: {reason}"
    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
