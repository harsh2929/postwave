from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class ArchiveResource(SyncResource):
    def list(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/archive", query=query or None)

    def publish_campaign(self, campaign_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/publish-archive")

    def unpublish_campaign(self, campaign_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/unpublish-archive")


class AsyncArchiveResource(AsyncResource):
    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/archive", query=query or None)

    async def publish_campaign(self, campaign_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/publish-archive")

    async def unpublish_campaign(self, campaign_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/unpublish-archive")
