from __future__ import annotations

import re
from typing import Literal, TypedDict, cast

from ._base import AsyncResource, SyncResource
from ._generic import q as encode_path_segment

GiftSubscriptionStatus = Literal[
    "pending",
    "paid",
    "redeemed",
    "cancelled",
    "expired",
    "refunded",
    "unclassified",
]
GiftSubscriptionFilter = Literal[
    "all",
    "open",
    "pending",
    "redeemed",
    "closed",
    "cancelled",
    "expired",
    "refunded",
]
GiftSubscriptionSort = Literal["newest", "oldest", "duration", "status"]

_GIFT_HISTORY_SEARCH_PATTERN = re.compile(r"^[0-9A-Fa-f]{8,32}$")
_GIFT_HISTORY_LABEL_PREFIX = re.compile(r"^gift record\s+", re.IGNORECASE)
_GIFT_HISTORY_ID_PATTERN = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$",
)


class GiftSubscription(TypedDict):
    """Identity-minimized historical gift evidence."""

    id: str
    label: str
    plan_label: str
    duration_months: int
    status: GiftSubscriptionStatus
    created_at: str
    redeemed_at: str | None
    expires_at: str | None
    canceled_at: str | None
    message_recorded: bool
    provider_invoice_linked: bool
    gifter_member_linked: bool
    recipient_member_linked: bool


class GiftSubscriptionListPage(TypedDict):
    items: list[GiftSubscription]
    total: int
    limit: int
    offset: int
    snapshot_at: str


class GiftSubscriptionStats(TypedDict):
    total: int
    pending: int
    paid: int
    granted: int
    canceled: int
    expired: int
    refunded: int
    conversionRate: float
    generated_at: str


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
            f"Gift history {name} must be an integer between {minimum} and {maximum}",
        )
    return value


def _compact_search(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("Gift history q must be a string")
    trimmed = value.strip()
    if not trimmed:
        return None
    compact = (
        _GIFT_HISTORY_LABEL_PREFIX.sub("", trimmed, count=1).replace("-", "").lower()
    )
    if _GIFT_HISTORY_SEARCH_PATTERN.fullmatch(compact) is None:
        raise ValueError(
            "Gift history q must be an 8-32 character hexadecimal record prefix",
        )
    return compact


def _canonical_gift_id(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("Gift history id must be a string")
    if _GIFT_HISTORY_ID_PATTERN.fullmatch(value) is None:
        raise ValueError("Gift history id must be a canonical UUID")
    return value.lower()


def _list_query(
    *,
    limit: int | None,
    offset: int | None,
    q: str | None,
    filter: GiftSubscriptionFilter | None,
    sort: GiftSubscriptionSort | None,
) -> dict[str, int | str | None]:
    return {
        "limit": _bounded_integer("limit", limit, 1, 100),
        "offset": _bounded_integer("offset", offset, 0, 10_000),
        "q": _compact_search(q),
        "filter": None if filter in (None, "all") else filter,
        "sort": None if sort in (None, "newest") else sort,
    }


class GiftSubscriptionsResource(SyncResource):
    """Read-only access to the sanitized historical gift archive."""

    def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        q: str | None = None,
        filter: GiftSubscriptionFilter | None = None,
        sort: GiftSubscriptionSort | None = None,
    ) -> GiftSubscriptionListPage:
        """Return a bounded archive page.

        ``q`` accepts a copied Gift record label or hyphenated UUID prefix,
        then sends only compact lowercase hexadecimal. Non-empty search
        values must contain 8-32 hexadecimal characters.
        """
        return cast(
            GiftSubscriptionListPage,
            self._client.request(
                "GET",
                "/api/v1/gift-subscriptions",
                query=_list_query(
                    limit=limit,
                    offset=offset,
                    q=q,
                    filter=filter,
                    sort=sort,
                ),
            ),
        )

    def stats(self) -> GiftSubscriptionStats:
        return cast(
            GiftSubscriptionStats,
            self._client.request("GET", "/api/v1/gift-subscriptions/stats"),
        )

    def get(self, gift_id: str) -> GiftSubscription:
        canonical_id = _canonical_gift_id(gift_id)
        return cast(
            GiftSubscription,
            self._client.request(
                "GET",
                f"/api/v1/gift-subscriptions/{encode_path_segment(canonical_id)}",
            ),
        )


class AsyncGiftSubscriptionsResource(AsyncResource):
    """Async read-only access to the sanitized historical gift archive."""

    async def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        q: str | None = None,
        filter: GiftSubscriptionFilter | None = None,
        sort: GiftSubscriptionSort | None = None,
    ) -> GiftSubscriptionListPage:
        """Return a bounded archive page using the sync client's validation."""
        return cast(
            GiftSubscriptionListPage,
            await self._client.request(
                "GET",
                "/api/v1/gift-subscriptions",
                query=_list_query(
                    limit=limit,
                    offset=offset,
                    q=q,
                    filter=filter,
                    sort=sort,
                ),
            ),
        )

    async def stats(self) -> GiftSubscriptionStats:
        return cast(
            GiftSubscriptionStats,
            await self._client.request("GET", "/api/v1/gift-subscriptions/stats"),
        )

    async def get(self, gift_id: str) -> GiftSubscription:
        canonical_id = _canonical_gift_id(gift_id)
        return cast(
            GiftSubscription,
            await self._client.request(
                "GET",
                f"/api/v1/gift-subscriptions/{encode_path_segment(canonical_id)}",
            ),
        )
