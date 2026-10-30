from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class DmarcResource(SyncResource):
    def reports(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/deliverability/dmarc-reports", query=query or None)


class AsyncDmarcResource(AsyncResource):
    async def reports(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/deliverability/dmarc-reports", query=query or None)
