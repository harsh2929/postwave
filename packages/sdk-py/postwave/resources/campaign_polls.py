"""Authenticated campaign poll materialization, list, and tally operations."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from ..types.polls import (
    CampaignPollDefinition,
    CampaignPollList,
    CampaignPollMaterializationInput,
    CampaignPollTally,
)
from ._base import AsyncResource, SyncResource


_OPAQUE_CURSOR = re.compile(r"^[A-Za-z0-9._-]+$")


def _segment(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"campaign poll {label} is required")
    return quote(value, safe="")


def _materialization_body(
    value: CampaignPollMaterializationInput | dict[str, Any],
) -> dict[str, Any]:
    # `extra="forbid"` makes the AST the only source of question/options even
    # for callers using an untyped dict.
    return CampaignPollMaterializationInput.model_validate(value).model_dump(
        mode="json", exclude_none=True
    )


def _poll_segment(value: str) -> str:
    validated = CampaignPollMaterializationInput(
        content_revision_id="validation-only", poll_key=value
    ).poll_key
    return quote(validated, safe="")


def _list_query(limit: int | None, cursor: str | None) -> dict[str, Any] | None:
    if limit is not None and (
        isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100
    ):
        raise ValueError("campaign poll list limit must be an integer from 1 to 100")
    if cursor is not None and (
        not isinstance(cursor, str)
        or not 1 <= len(cursor) <= 512
        or _OPAQUE_CURSOR.fullmatch(cursor) is None
    ):
        raise ValueError(
            "campaign poll list cursor must be a 1-512 byte opaque ASCII cursor"
        )
    query = {"limit": limit, "cursor": cursor}
    return query if any(value is not None for value in query.values()) else None


class CampaignPollsResource(SyncResource):
    """Campaign-scoped operations; signed recipient links are not SDK calls."""

    def materialize(
        self,
        campaign_id: str,
        payload: CampaignPollMaterializationInput | dict[str, Any],
    ) -> CampaignPollDefinition:
        value = self._client.request(
            "POST",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}/polls",
            body=_materialization_body(payload),
        )
        return CampaignPollDefinition.model_validate(value)

    def list(
        self,
        campaign_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> CampaignPollList:
        value = self._client.request(
            "GET",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}/polls",
            query=_list_query(limit, cursor),
        )
        return CampaignPollList.model_validate(value)

    def tally(self, campaign_id: str, poll_key: str) -> CampaignPollTally:
        value = self._client.request(
            "GET",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}"
            f"/polls/{_poll_segment(poll_key)}/tally",
        )
        return CampaignPollTally.model_validate(value)


class AsyncCampaignPollsResource(AsyncResource):
    async def materialize(
        self,
        campaign_id: str,
        payload: CampaignPollMaterializationInput | dict[str, Any],
    ) -> CampaignPollDefinition:
        value = await self._client.request(
            "POST",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}/polls",
            body=_materialization_body(payload),
        )
        return CampaignPollDefinition.model_validate(value)

    async def list(
        self,
        campaign_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> CampaignPollList:
        value = await self._client.request(
            "GET",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}/polls",
            query=_list_query(limit, cursor),
        )
        return CampaignPollList.model_validate(value)

    async def tally(self, campaign_id: str, poll_key: str) -> CampaignPollTally:
        value = await self._client.request(
            "GET",
            f"/api/v1/campaigns/{_segment(campaign_id, 'campaign ID')}"
            f"/polls/{_poll_segment(poll_key)}/tally",
        )
        return CampaignPollTally.model_validate(value)
