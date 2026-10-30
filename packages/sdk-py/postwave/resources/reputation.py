from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ..types.deliverability import Reputation


class ReputationResource(SyncResource):
    def get(self) -> Reputation:
        return Reputation.model_validate(self._client.request("GET", "/api/v1/reputation"))


class AsyncReputationResource(AsyncResource):
    async def get(self) -> Reputation:
        return Reputation.model_validate(await self._client.request("GET", "/api/v1/reputation"))
