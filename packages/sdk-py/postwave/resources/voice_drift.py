from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class VoiceDriftResource(SyncResource):
    def check(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/voice/drift", body=payload)


class AsyncVoiceDriftResource(AsyncResource):
    async def check(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/voice/drift", body=payload)
