"""Parse and format human-readable durations."""

import re

_UNIT_SECONDS = {"h": 3600, "m": 60, "s": 1}
_TOKEN_RE = re.compile(r"(?i)(\d+)([hms])")


def parse_duration(text: str) -> int:
    """Parse a human-readable duration string into total seconds.

    Args:
        text: Duration with one or more tokens like ``1h``, ``30m``, ``45s``,
            optionally separated by whitespace (case-insensitive).

    Returns:
        Total duration in seconds.

    Raises:
        ValueError: If ``text`` is empty, whitespace-only, or cannot be fully
            parsed as valid duration tokens.
    """
    stripped = text.strip()
    if not stripped:
        raise ValueError("duration string is empty")

    if stripped.isdigit():
        return int(stripped) * _UNIT_SECONDS["m"]

    total = 0
    pos = 0
    length = len(stripped)
    found_token = False

    while pos < length:
        while pos < length and stripped[pos].isspace():
            pos += 1
        if pos >= length:
            break
        match = _TOKEN_RE.match(stripped, pos)
        if match is None:
            raise ValueError("invalid duration syntax")
        amount = int(match.group(1))
        unit = match.group(2).lower()
        total += amount * _UNIT_SECONDS[unit]
        pos = match.end()
        found_token = True

    if not found_token:
        raise ValueError("duration string is empty")

    return total


def format_duration(seconds: int) -> str:
    """Format a non-negative duration in seconds as human-readable text.

    Args:
        seconds: Duration in seconds (must be non-negative).

    Returns:
        String with non-zero hour, minute, and second parts as ``<n>h``,
        ``<n>m``, ``<n>s`` joined by a single space; zero components omitted.
        ``0`` is formatted as ``0s``.

    Raises:
        ValueError: If ``seconds`` is negative.
    """
    if seconds < 0:
        raise ValueError("seconds must be non-negative")
    if seconds == 0:
        return "0s"

    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)

    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if secs:
        parts.append(f"{secs}s")

    return " ".join(parts)
