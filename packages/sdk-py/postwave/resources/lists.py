from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class ListsResource(SyncResource):
    def list(self) -> Any:
        return self._client.request("GET", "/api/v1/lists")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/lists", body=payload)

    def for_subscriber(self, subscriber_id: str) -> dict[str, Any]:
        if not subscriber_id.strip():
            raise ValueError("Subscriber ID is required")
        return self._client.request("GET", f"/api/v1/lists/for-subscriber/{q(subscriber_id.strip())}")

    def delete(self, list_id: str | int) -> Any:
        return self._client.request("DELETE", f"/api/v1/lists/{q(list_id)}")


class AsyncListsResource(AsyncResource):
    async def list(self) -> Any:
        return await self._client.request("GET", "/api/v1/lists")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/lists", body=payload)

    async def for_subscriber(self, subscriber_id: str) -> dict[str, Any]:
        if not subscriber_id.strip():
            raise ValueError("Subscriber ID is required")
        return await self._client.request("GET", f"/api/v1/lists/for-subscriber/{q(subscriber_id.strip())}")

    async def delete(self, list_id: str | int) -> Any:
        return await self._client.request("DELETE", f"/api/v1/lists/{q(list_id)}")
