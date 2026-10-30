from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class SafetyResource(SyncResource):
    def check(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/safety/check", body=payload)


class AsyncSafetyResource(AsyncResource):
    async def check(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/safety/check", body=payload)
