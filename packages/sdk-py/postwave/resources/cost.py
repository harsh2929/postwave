from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class CostResource(SyncResource):
    def aggregate(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/cost/aggregate", query=query or None)


class AsyncCostResource(AsyncResource):
    async def aggregate(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/cost/aggregate", query=query or None)
