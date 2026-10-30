from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class PreferencesResource(SyncResource):
    def get_public(self, token: str) -> Any:
        return self._client.request("GET", f"/api/public/preferences/{q(token)}")

    def update_public(self, token: str, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", f"/api/public/preferences/{q(token)}", body=payload)

    def subscriber_topics(self, email: str) -> Any:
        return self._client.request("GET", f"/api/v1/subscribers/{q(email)}/topics")

    def update_subscriber_topics(self, email: str, payload: dict[str, Any]) -> Any:
        return self._client.request("PUT", f"/api/v1/subscribers/{q(email)}/topics", body=payload)


class AsyncPreferencesResource(AsyncResource):
    async def get_public(self, token: str) -> Any:
        return await self._client.request("GET", f"/api/public/preferences/{q(token)}")

    async def update_public(self, token: str, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", f"/api/public/preferences/{q(token)}", body=payload)

    async def subscriber_topics(self, email: str) -> Any:
        return await self._client.request("GET", f"/api/v1/subscribers/{q(email)}/topics")

    async def update_subscriber_topics(self, email: str, payload: dict[str, Any]) -> Any:
        return await self._client.request("PUT", f"/api/v1/subscribers/{q(email)}/topics", body=payload)
