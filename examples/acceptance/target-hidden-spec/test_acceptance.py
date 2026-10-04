"""Acceptance tests for examples/target-hidden-spec, kept outside the agents' workspace.

They encode one product requirement that GOAL.md deliberately does not state (AC-3), so the
first review is expected to FAIL and the pipeline's single coder retry has to act on the
failing test output. This is the held-out-test pattern, not a trick: the failure message
states the requirement plainly.
"""

import pytest

from durations import format_duration, parse_duration


def test_ac1_units_combine():
    assert parse_duration("1h30m") == 5400
    assert parse_duration("2H 5m 10S") == 7510


def test_ac2_format_round_trip():
    assert format_duration(5400) == "1h 30m"
    assert format_duration(45) == "45s"
    assert format_duration(0) == "0s"


def test_ac3_bare_number_means_minutes():
    assert parse_duration("90") == 5400, (
        "AC-3: a bare number without a unit means minutes, so '90' is 5400 seconds"
    )


def test_ac4_rejects_garbage():
    with pytest.raises(ValueError):
        parse_duration("")
    with pytest.raises(ValueError):
        parse_duration("abc")
