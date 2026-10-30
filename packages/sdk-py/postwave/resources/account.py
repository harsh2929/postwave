from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class AccountResource(SyncResource):
    def me(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/me")

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("PATCH", "/api/v1/me", body=patch)


class AsyncAccountResource(AsyncResource):
    async def me(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/me")

    async def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("PATCH", "/api/v1/me", body=patch)
