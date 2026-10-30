from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class SuppressionsResource(SyncResource):
    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/suppressions", body=payload)

    def bulk_create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/suppressions/bulk", body=payload)


class AsyncSuppressionsResource(AsyncResource):
    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/suppressions", body=payload)

    async def bulk_create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/suppressions/bulk", body=payload)
