from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class InboundWebhooksResource(SyncResource):
    def list(
        self, *, query: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/inbound-webhooks",
            query={"query": query, "limit": limit, "cursor": cursor},
        )

    def create(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/inbound-webhooks", body=payload or {})

    def get(self, webhook_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/inbound-webhooks/{q(webhook_id)}")

    def update(self, webhook_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("PATCH", f"/api/v1/inbound-webhooks/{q(webhook_id)}", body=patch)

    def rotate(self, webhook_id: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/inbound-webhooks/{q(webhook_id)}/rotate")

    def delete(self, webhook_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/inbound-webhooks/{q(webhook_id)}")

    def events(
        self, webhook_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/events",
            query={"limit": limit, "cursor": cursor},
        )

    def replay(
        self, webhook_id: str, event_id: int | str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        path = f"/api/v1/inbound-webhooks/{q(webhook_id)}/events/{q(str(event_id))}/replay"
        if idempotency_key is None:
            return self._client.request("POST", path)
        return self._client.request("POST", path, idempotency_key=idempotency_key)

    def triggers(self, webhook_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers")

    def create_trigger(self, webhook_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST", f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers", body=payload
        )

    def update_trigger(
        self, webhook_id: str, trigger_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers/{q(trigger_id)}",
            body=patch,
        )

    def delete_trigger(self, webhook_id: str, trigger_id: str) -> Any:
        return self._client.request(
            "DELETE",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers/{q(trigger_id)}",
        )

    def preview_transform(self, transform_jq: str, body: Any) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/inbound-webhooks/transform/preview",
            body={"transform_jq": transform_jq, "body": body},
        )


class AsyncInboundWebhooksResource(AsyncResource):
    async def list(
        self, *, query: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/inbound-webhooks",
            query={"query": query, "limit": limit, "cursor": cursor},
        )

    async def create(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/inbound-webhooks", body=payload or {})

    async def get(self, webhook_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/inbound-webhooks/{q(webhook_id)}")

    async def update(self, webhook_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PATCH", f"/api/v1/inbound-webhooks/{q(webhook_id)}", body=patch
        )

    async def rotate(self, webhook_id: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/inbound-webhooks/{q(webhook_id)}/rotate")

    async def delete(self, webhook_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/inbound-webhooks/{q(webhook_id)}")

    async def events(
        self, webhook_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/events",
            query={"limit": limit, "cursor": cursor},
        )

    async def replay(
        self, webhook_id: str, event_id: int | str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        path = f"/api/v1/inbound-webhooks/{q(webhook_id)}/events/{q(str(event_id))}/replay"
        if idempotency_key is None:
            return await self._client.request("POST", path)
        return await self._client.request("POST", path, idempotency_key=idempotency_key)

    async def triggers(self, webhook_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET", f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers"
        )

    async def create_trigger(self, webhook_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST", f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers", body=payload
        )

    async def update_trigger(
        self, webhook_id: str, trigger_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers/{q(trigger_id)}",
            body=patch,
        )

    async def delete_trigger(self, webhook_id: str, trigger_id: str) -> Any:
        return await self._client.request(
            "DELETE",
            f"/api/v1/inbound-webhooks/{q(webhook_id)}/triggers/{q(trigger_id)}",
        )

    async def preview_transform(self, transform_jq: str, body: Any) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/inbound-webhooks/transform/preview",
            body={"transform_jq": transform_jq, "body": body},
        )
