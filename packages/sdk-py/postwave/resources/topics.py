from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class TopicsResource(SyncResource):
    def list(self) -> Any:
        return self._client.request("GET", "/api/v1/topics")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/topics", body=payload)

    def update(self, topic_id: str, patch: dict[str, Any]) -> Any:
        return self._client.request("PATCH", f"/api/v1/topics/{q(topic_id)}", body=patch)

    def subscribe(self, subscriber_email: str, topic_id: str) -> Any:
        return self._client.request(
            "POST",
            f"/api/v1/subscribers/{q(subscriber_email)}/topics/{q(topic_id)}/subscribe",
        )

    def unsubscribe(self, subscriber_email: str, topic_id: str) -> Any:
        return self._client.request(
            "POST",
            f"/api/v1/subscribers/{q(subscriber_email)}/topics/{q(topic_id)}/unsubscribe",
        )


class AsyncTopicsResource(AsyncResource):
    async def list(self) -> Any:
        return await self._client.request("GET", "/api/v1/topics")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/topics", body=payload)

    async def update(self, topic_id: str, patch: dict[str, Any]) -> Any:
        return await self._client.request("PATCH", f"/api/v1/topics/{q(topic_id)}", body=patch)

    async def subscribe(self, subscriber_email: str, topic_id: str) -> Any:
        return await self._client.request(
            "POST",
            f"/api/v1/subscribers/{q(subscriber_email)}/topics/{q(topic_id)}/subscribe",
        )

    async def unsubscribe(self, subscriber_email: str, topic_id: str) -> Any:
        return await self._client.request(
            "POST",
            f"/api/v1/subscribers/{q(subscriber_email)}/topics/{q(topic_id)}/unsubscribe",
        )
