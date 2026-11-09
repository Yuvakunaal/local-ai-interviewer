"""What a cloud call costs. Prices verified against Ollama's pricing page; DeepSeek v4.1 Flash is half price off-peak."""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.pricing import DEFAULT_PRICES, ModelPrice, cost_usd, find_price, is_peak, normalise

UTC = timezone.utc
WED_NOON = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)      # a Wednesday


# Ollama's "Model pricing" table (pay-as-you-go, USD per 1M tokens: input, output), copied from the page on 31 Oct 2026, for the three models the app uses.
# DeepSeek has a peak rate (the row as listed) and an off-peak rate (the "Off-Peak" row).
PUBLISHED = {"gpt-oss:120b": (0.15, 0.60), "deepseek-v4.1-flash": (0.30, 1.20, 0.15, 0.60), "gemma4:31b": (0.14, 0.40)}


def test_the_three_models_have_exactly_the_published_prices():
    assert set(DEFAULT_PRICES) == set(PUBLISHED)
    for name, row in PUBLISHED.items():
        p = DEFAULT_PRICES[name]
        assert (p.input_per_m, p.output_per_m) == row[:2], name
        assert (p.offpeak_input_per_m, p.offpeak_output_per_m) == (row[2:] if len(row) == 4 else (None, None)), name


def test_deepseek_is_not_the_0_15_0_60_people_quote_at_peak():
    d = DEFAULT_PRICES["deepseek-v4.1-flash"]
    assert (d.input_per_m, d.output_per_m, d.offpeak_input_per_m, d.offpeak_output_per_m) == (0.30, 1.20, 0.15, 0.60)


def test_cost_is_tokens_times_the_per_million_price():
    assert cost_usd(DEFAULT_PRICES["gpt-oss:120b"], 900, 450, WED_NOON) == 0.000405
    assert cost_usd(DEFAULT_PRICES["gemma4:31b"], 900, 450, WED_NOON) == 0.000306
    assert cost_usd(DEFAULT_PRICES["gpt-oss:120b"], 1_000_000, 1_000_000, WED_NOON) == 0.75
    assert cost_usd(DEFAULT_PRICES["gpt-oss:120b"], None, None, WED_NOON) == 0.0


@pytest.mark.parametrize("when, peak", [
    (datetime(2026, 11, 4, 11, 59, tzinfo=UTC), False), (datetime(2026, 11, 4, 12, 0, tzinfo=UTC), True), (datetime(2026, 11, 4, 17, 59, tzinfo=UTC), True),
    (datetime(2026, 11, 4, 18, 0, tzinfo=UTC), False),                                        # Wednesday boundaries
    (datetime(2026, 11, 7, 14, 0, tzinfo=UTC), False), (datetime(2026, 11, 8, 14, 0, tzinfo=UTC), False),   # Saturday / Sunday afternoon
    (datetime(2026, 11, 6, 17, 0, tzinfo=UTC), True), (datetime(2026, 11, 9, 12, 0, tzinfo=UTC), True),     # Friday / Monday
])
def test_peak_is_weekdays_12_to_18_utc(when, peak):
    assert is_peak(when) is peak


def test_peak_is_decided_in_utc_whatever_the_local_timezone():
    india = timezone(timedelta(hours=5, minutes=30))
    assert is_peak(datetime(2026, 11, 4, 17, 30, tzinfo=india)) is True       # 12:00 UTC
    assert is_peak(datetime(2026, 11, 4, 17, 29, tzinfo=india)) is False      # 11:59 UTC


def test_deepseek_costs_double_at_peak_and_models_without_an_off_peak_rate_never_change():
    ds, gpt = DEFAULT_PRICES["deepseek-v4.1-flash"], DEFAULT_PRICES["gpt-oss:120b"]
    peak, off = WED_NOON, datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
    assert cost_usd(ds, 1000, 1000, peak) == 0.0015 and cost_usd(ds, 1000, 1000, off) == 0.00075
    assert cost_usd(gpt, 1000, 1000, peak) == cost_usd(gpt, 1000, 1000, off)


def test_a_model_without_a_price_is_unknown_not_free():
    assert find_price("acme-future-1", DEFAULT_PRICES) is None
    assert cost_usd(None, 1000, 1000, WED_NOON) is None


@pytest.mark.parametrize("name", ["gemma4:31b", "GEMMA4:31B", "gemma4:31b-cloud", "gemma4:31b:cloud", " gemma4:31b "])
def test_the_cli_and_api_spellings_find_the_same_price(name):
    assert find_price(name, DEFAULT_PRICES) is DEFAULT_PRICES["gemma4:31b"]
    assert normalise(name) == "gemma4:31b"


def test_prices_are_validated():
    with pytest.raises(ValueError):
        ModelPrice(input_per_m=-1, output_per_m=1)
    with pytest.raises(ValueError):
        ModelPrice(input_per_m=1, output_per_m=1e9)
