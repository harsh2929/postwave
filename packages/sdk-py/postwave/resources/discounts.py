from __future__ import annotations

import re
from typing import Literal, TypedDict, cast

from ._base import AsyncResource, SyncResource
from ._generic import q as encode_path_segment

DiscountAppliesTo = Literal["first_payment", "recurring", "both"]

_DISCOUNT_RECORD_ID_PATTERN = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$",
)


class _OptionalDiscountHistoryFields(TypedDict, total=False):
    percent_off: int | None
    amount_off_cents: int | None
    max_redemptions: int | None
    expires_at: str | None


class DiscountHistoryRecord(_OptionalDiscountHistoryFields):
    """Sanitized history record; redeemable and provider identifiers are absent."""

    id: str
    label: str
    currency: str
    times_redeemed: int
    applies_to: DiscountAppliesTo
    created_at: str


class DiscountHistoryPage(TypedDict):
    items: list[DiscountHistoryRecord]
    has_more: bool


class DiscountRedemptionEvent(TypedDict):
    """PII-free redemption evidence for one opaque discount record."""

    redeemed_at: str
    subscriber_linked: bool


class DiscountRedemptionsPage(TypedDict):
    items: list[DiscountRedemptionEvent]
    has_more: bool


def _canonical_record_id(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("Discount history record_id must be a string")
    if _DISCOUNT_RECORD_ID_PATTERN.fullmatch(value) is None:
        raise ValueError("Discount history record_id must be a canonical UUID")
    return value.lower()


def _bounded_integer(
    name: str,
    value: int | None,
    minimum: int,
    maximum: int,
) -> int | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ValueError(
            f"Discount history {name} must be an integer between {minimum} and {maximum}",
        )
    return value


class DiscountsResource(SyncResource):
    """Read-only access to sanitized local discount history."""

    def list(
        self,
        *,
        record_id: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> DiscountHistoryPage:
        """Return one strict archive page (limit 1-100, default 50; offset default 0)."""
        return cast(
            DiscountHistoryPage,
            self._client.request(
                "GET",
                "/api/v1/discounts",
                query={
                    "record_id": (
                        None
                        if record_id is None
                        else _canonical_record_id(record_id)
                    ),
                    "limit": _bounded_integer("limit", limit, 1, 100),
                    "offset": _bounded_integer("offset", offset, 0, 10_000),
                },
            ),
        )

    def redemptions(
        self,
        record_id: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> DiscountRedemptionsPage:
        """Return PII-free events (limit 1-100, default 50; offset default 0)."""
        record_id = _canonical_record_id(record_id)
        query = {
            "limit": _bounded_integer("limit", limit, 1, 100),
            "offset": _bounded_integer("offset", offset, 0, 10_000),
        }
        return cast(
            DiscountRedemptionsPage,
            self._client.request(
                "GET",
                f"/api/v1/discounts/{encode_path_segment(record_id)}/redemptions",
                query=query,
            ),
        )


class AsyncDiscountsResource(AsyncResource):
    """Async read-only access to sanitized local discount history."""

    async def list(
        self,
        *,
        record_id: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> DiscountHistoryPage:
        """Return one strict archive page (limit 1-100, default 50; offset default 0)."""
        return cast(
            DiscountHistoryPage,
            await self._client.request(
                "GET",
                "/api/v1/discounts",
                query={
                    "record_id": (
                        None
                        if record_id is None
                        else _canonical_record_id(record_id)
                    ),
                    "limit": _bounded_integer("limit", limit, 1, 100),
                    "offset": _bounded_integer("offset", offset, 0, 10_000),
                },
            ),
        )

    async def redemptions(
        self,
        record_id: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> DiscountRedemptionsPage:
        """Return PII-free events (limit 1-100, default 50; offset default 0)."""
        record_id = _canonical_record_id(record_id)
        query = {
            "limit": _bounded_integer("limit", limit, 1, 100),
            "offset": _bounded_integer("offset", offset, 0, 10_000),
        }
        return cast(
            DiscountRedemptionsPage,
            await self._client.request(
                "GET",
                f"/api/v1/discounts/{encode_path_segment(record_id)}/redemptions",
                query=query,
            ),
        )
