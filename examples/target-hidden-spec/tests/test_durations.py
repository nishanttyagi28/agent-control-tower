"""Tests for parse_duration and format_duration."""

import pytest

from durations import format_duration, parse_duration


def test_parse_combined_units_no_space() -> None:
    assert parse_duration("1h30m") == 5400


def test_parse_seconds_only() -> None:
    assert parse_duration("45s") == 45


def test_parse_with_spaces() -> None:
    assert parse_duration("2h 5m") == 7500


def test_parse_case_insensitive() -> None:
    assert parse_duration("1H30M") == 5400
    assert parse_duration("45S") == 45


def test_parse_single_hour() -> None:
    assert parse_duration("2h") == 7200


def test_parse_single_minute() -> None:
    assert parse_duration("3m") == 180


def test_parse_zero_seconds() -> None:
    assert parse_duration("0s") == 0


def test_parse_multiple_spaces_between_tokens() -> None:
    assert parse_duration("1h   30m") == 5400


def test_parse_raises_on_empty_string() -> None:
    with pytest.raises(ValueError, match="empty"):
        parse_duration("")


def test_parse_raises_on_whitespace_only() -> None:
    with pytest.raises(ValueError, match="empty"):
        parse_duration("   \t  ")


def test_parse_raises_on_token_without_digit() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("h")
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("m30")


def test_parse_raises_on_unknown_unit() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("1x")
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("5d")


def test_parse_raises_on_negative_number() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("-1h")


def test_parse_raises_on_fractional_number() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("1.5h")
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("2.5m")


def test_parse_raises_on_trailing_junk() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("1h extra")


def test_parse_raises_on_leading_junk() -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_duration("about 1h")


def test_format_goal_examples() -> None:
    assert format_duration(5400) == "1h 30m"
    assert format_duration(45) == "45s"
    assert format_duration(0) == "0s"


def test_format_single_hour() -> None:
    assert format_duration(3600) == "1h"


def test_format_boundaries() -> None:
    assert format_duration(59) == "59s"
    assert format_duration(60) == "1m"
    assert format_duration(3599) == "59m 59s"
    assert format_duration(3600) == "1h"


def test_format_omits_zero_units() -> None:
    assert format_duration(3661) == "1h 1m 1s"
    assert format_duration(3601) == "1h 1s"
    assert format_duration(61) == "1m 1s"


def test_format_raises_on_negative_seconds() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        format_duration(-1)


def test_format_parse_round_trip() -> None:
    for n in (0, 45, 60, 5400, 7500, 3600):
        assert parse_duration(format_duration(n)) == n
