from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class SendTimeResource(SyncResource):
    def subscriber_best_time(self, subscriber_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/subscribers/{q(subscriber_id)}/best-send-time")

    def schedule_campaign(self, campaign_id: str, payload: dict[str, Any] | None = None) -> Any:
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{q(campaign_id)}/schedule-by-best-time",
            body=payload or {},
        )


class AsyncSendTimeResource(AsyncResource):
    async def subscriber_best_time(self, subscriber_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/subscribers/{q(subscriber_id)}/best-send-time")

    async def schedule_campaign(self, campaign_id: str, payload: dict[str, Any] | None = None) -> Any:
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{q(campaign_id)}/schedule-by-best-time",
            body=payload or {},
        )
