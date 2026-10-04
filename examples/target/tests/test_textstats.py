"""Tests for textstats."""

import pytest

import textstats


def test_word_count_normal() -> None:
    assert textstats.word_count("Hello, world!") == 2
    assert textstats.word_count("don't stop3") == 2
    assert textstats.word_count("One two three four") == 4


def test_word_count_empty_and_whitespace() -> None:
    assert textstats.word_count("") == 0
    assert textstats.word_count("   \n\t  ") == 0
    assert textstats.word_count("...") == 0


def test_sentence_count_normal() -> None:
    assert textstats.sentence_count("Hello. World!") == 2
    assert textstats.sentence_count("One? Two! Three.") == 3
    assert textstats.sentence_count("No terminator here") == 1


def test_sentence_count_empty_and_whitespace() -> None:
    assert textstats.sentence_count("") == 0
    assert textstats.sentence_count("   ") == 0
    assert textstats.sentence_count("...") == 0
    assert textstats.sentence_count("!!!") == 0


def test_top_words_normal() -> None:
    text = "The cat sat on the mat. The CAT was happy."
    assert textstats.top_words(text, 3) == [("the", 3), ("cat", 2), ("happy", 1)]
    assert textstats.top_words("Hello HELLO hello", 2) == [("hello", 3)]
    assert textstats.top_words("z z a a b", 2) == [("a", 2), ("z", 2)]


def test_top_words_empty() -> None:
    assert textstats.top_words("", 5) == []
    assert textstats.top_words("   ", 5) == []


def test_top_words_invalid_n() -> None:
    with pytest.raises(ValueError, match="n must be non-negative"):
        textstats.top_words("hello", -1)


def test_reading_time_minutes_normal() -> None:
    assert textstats.reading_time_minutes("one two three four", wpm=200) == 0.02
    assert textstats.reading_time_minutes("word " * 100, wpm=250) == 0.4


def test_reading_time_minutes_empty() -> None:
    assert textstats.reading_time_minutes("") == 0.0
    assert textstats.reading_time_minutes("   ", wpm=100) == 0.0


def test_reading_time_minutes_invalid_wpm() -> None:
    with pytest.raises(ValueError, match="wpm must be positive"):
        textstats.reading_time_minutes("hello", wpm=0)
    with pytest.raises(ValueError, match="wpm must be positive"):
        textstats.reading_time_minutes("hello", wpm=-5)
