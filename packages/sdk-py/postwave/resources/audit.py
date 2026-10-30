from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class AuditResource(SyncResource):
    def list(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/audit", query=query or None)


class AsyncAuditResource(AsyncResource):
    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/audit", query=query or None)
