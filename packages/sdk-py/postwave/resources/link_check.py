from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class LinkCheckResource(SyncResource):
    def check_campaign(self, campaign_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/check-links")


class AsyncLinkCheckResource(AsyncResource):
    async def check_campaign(self, campaign_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/check-links")
