from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class TrackResource(SyncResource):
    def publish(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/track", body=payload)

    def events(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/track/events", query=query or None)


class AsyncTrackResource(AsyncResource):
    async def publish(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/track", body=payload)

    async def events(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/track/events", query=query or None)
