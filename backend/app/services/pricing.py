"""What a cloud call costs. Ollama cloud meters tokens per model (prices per million tokens).

The app is built around three models, and these are their rates from Ollama's own "Model pricing" table (pay-as-you-go, read 31 Oct 2026,
cross-checked against an independent tracker): gpt-oss:120b $0.15 in / $0.60 out; gemma4 $0.14 / $0.40 (one row for every size);
DeepSeek v4.1 Flash $0.30 / $1.20, but HALF of that off-peak (every hour outside 12:00-18:00 UTC on weekdays, and all weekend).
Cached input is cheaper still; replies do not say how much was cached, so estimates use the full input price (an upper bound).
Prices change: every value is a default and can be edited in Settings -> AI models (edits are kept, defaults update with the app).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


class ModelPrice(BaseModel):
    """US dollars per million tokens. The off-peak fields apply only to models that have an off-peak rate."""

    input_per_m: float = Field(ge=0, le=10_000)
    output_per_m: float = Field(ge=0, le=10_000)
    offpeak_input_per_m: Optional[float] = Field(default=None, ge=0, le=10_000)
    offpeak_output_per_m: Optional[float] = Field(default=None, ge=0, le=10_000)


DEFAULT_PRICES: dict[str, ModelPrice] = {
    "gpt-oss:120b": ModelPrice(input_per_m=0.15, output_per_m=0.6),
    "deepseek-v4.1-flash": ModelPrice(input_per_m=0.30, output_per_m=1.20, offpeak_input_per_m=0.15, offpeak_output_per_m=0.60),
    "gemma4:31b": ModelPrice(input_per_m=0.14, output_per_m=0.4),
}


def is_peak(at: datetime) -> bool:
    """Peak = 12:00-18:00 UTC on Monday-Friday."""
    u = at.astimezone(timezone.utc)
    return u.weekday() < 5 and 12 <= u.hour < 18


def normalise(model: str) -> str:
    """'gemma4:31b-cloud' / 'gemma4:31b:cloud' (the CLI spelling) and 'gemma4:31b' (the API spelling) are the same model."""
    m = model.strip().lower()
    return re.sub(r"[-:]cloud$", "", m)


def find_price(model: str, prices: dict[str, ModelPrice]) -> Optional[ModelPrice]:
    wanted = normalise(model)
    for name, price in prices.items():
        if normalise(name) == wanted:
            return price
    return None


def cost_usd(price: Optional[ModelPrice], prompt_tokens: Optional[int], output_tokens: Optional[int], at: datetime) -> Optional[float]:
    """Estimated cost in dollars, or None when the model has no price (so it is reported as unknown, not as free)."""
    if price is None:
        return None
    off = not is_peak(at) and price.offpeak_input_per_m is not None and price.offpeak_output_per_m is not None
    rate_in = price.offpeak_input_per_m if off else price.input_per_m
    rate_out = price.offpeak_output_per_m if off else price.output_per_m
    return round(((prompt_tokens or 0) * float(rate_in) + (output_tokens or 0) * float(rate_out)) / 1_000_000, 6)
