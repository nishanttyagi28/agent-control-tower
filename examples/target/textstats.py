"""Text statistics helpers (stdlib only)."""

import re

_WORD_PATTERN = re.compile(r"[A-Za-z0-9']+")
_SENTENCE_SPLIT = re.compile(r"[.!?]+")


def word_count(text: str) -> int:
    """Count words in text.

    A word is a maximal run of ASCII letters, digits, or apostrophes.

    Args:
        text: Input string.

    Returns:
        Number of word tokens in ``text``.
    """
    return len(_WORD_PATTERN.findall(text))


def sentence_count(text: str) -> int:
    """Count sentences in text.

    A sentence ends at one or more of ``.``, ``!``, or ``?``. Trailing text
    without a terminator counts as one sentence if it contains at least one word.

    Args:
        text: Input string.

    Returns:
        Number of sentences in ``text``; 0 for empty or whitespace-only input.
    """
    stripped = text.strip()
    if not stripped:
        return 0
    parts = _SENTENCE_SPLIT.split(stripped)
    return sum(1 for part in parts if _WORD_PATTERN.search(part))


def top_words(text: str, n: int = 5) -> list[tuple[str, int]]:
    """Return the most frequent words and their counts.

    Words use the same definition as :func:`word_count`. Counts are aggregated
    case-insensitively; returned words are lowercase.

    Args:
        text: Input string.
        n: Number of top entries to return.

    Returns:
        Up to ``n`` ``(word, count)`` pairs sorted by count descending, then
        word ascending.

    Raises:
        ValueError: If ``n`` is negative.
    """
    if n < 0:
        raise ValueError("n must be non-negative")
    counts: dict[str, int] = {}
    for match in _WORD_PATTERN.finditer(text):
        word = match.group(0).lower()
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return ranked[:n]


def reading_time_minutes(text: str, wpm: int = 200) -> float:
    """Estimate reading time in minutes from word count.

    Args:
        text: Input string.
        wpm: Assumed words per minute; must be positive.

    Returns:
        ``word_count(text) / wpm``, rounded to two decimal places. Empty text
        yields ``0.0``.

    Raises:
        ValueError: If ``wpm`` is zero or negative.
    """
    if wpm <= 0:
        raise ValueError("wpm must be positive")
    return round(word_count(text) / wpm, 2)
