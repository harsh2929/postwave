from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class SandboxResource(SyncResource):
    def campaign_status(self, campaign_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/sandbox/campaigns/{q(campaign_id)}/status")


class AsyncSandboxResource(AsyncResource):
    async def campaign_status(self, campaign_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/sandbox/campaigns/{q(campaign_id)}/status")
