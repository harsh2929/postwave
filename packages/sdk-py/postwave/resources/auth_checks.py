from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ..types.deliverability import AuthCheck


class AuthChecksResource(SyncResource):
    def list(self) -> list[AuthCheck]:
        return [AuthCheck.model_validate(p) for p in self._client.request("GET", "/api/v1/auth-checks")]


class AsyncAuthChecksResource(AsyncResource):
    async def list(self) -> list[AuthCheck]:
        rows = await self._client.request("GET", "/api/v1/auth-checks")
        return [AuthCheck.model_validate(p) for p in rows]
