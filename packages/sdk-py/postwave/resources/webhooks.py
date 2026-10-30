from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.webhooks import (
    WebhookCreateResponse,
    WebhookDelivery,
    WebhookSubscription,
    WebhookSubscriptionInput,
)
from ..webhook import verify_signature as _verify_signature


def _body(payload: WebhookSubscriptionInput | dict[str, Any]) -> dict[str, Any]:
    return payload.model_dump(exclude_none=True) if isinstance(payload, WebhookSubscriptionInput) else payload


class WebhooksResource(SyncResource):
    def list(
        self, *, query: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/outbound-webhooks",
            query={"query": query, "limit": limit, "cursor": cursor},
        )

    def create(self, payload: WebhookSubscriptionInput | dict[str, Any]) -> WebhookCreateResponse:
        return WebhookCreateResponse.model_validate(
            self._client.request("POST", "/api/v1/outbound-webhooks", body=_body(payload))
        )

    def update(self, webhook_id: str, patch: dict[str, Any]) -> WebhookSubscription:
        return WebhookSubscription.model_validate(
            self._client.request("PATCH", f"/api/v1/outbound-webhooks/{q(webhook_id)}", body=patch)
        )

    def delete(self, webhook_id: str, *, soft: bool = False) -> None:
        self._client.request(
            "DELETE",
            f"/api/v1/outbound-webhooks/{q(webhook_id)}",
            query={"soft": 1 if soft else None},
        )

    def test(self, webhook_id: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/outbound-webhooks/{q(webhook_id)}/test")

    def deliveries(
        self, webhook_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        out = self._client.request(
            "GET",
            f"/api/v1/outbound-webhooks/{q(webhook_id)}/deliveries",
            query={"limit": limit, "cursor": cursor},
        )
        out["deliveries"] = [WebhookDelivery.model_validate(item) for item in out.get("deliveries", [])]
        return out

    def replay(self, delivery_id: str, *, idempotency_key: str | None = None) -> dict[str, Any]:
        path = f"/api/v1/outbound-webhooks/deliveries/{q(delivery_id)}/replay"
        if idempotency_key is None:
            return self._client.request("POST", path)
        return self._client.request("POST", path, idempotency_key=idempotency_key)

    def rotate_secret(self, webhook_id: str, *, grace_minutes: int = 1440) -> WebhookCreateResponse:
        return WebhookCreateResponse.model_validate(
            self._client.request(
                "POST",
                f"/api/v1/outbound-webhooks/{q(webhook_id)}/rotate-secret",
                query={"grace_minutes": grace_minutes},
            )
        )

    @staticmethod
    def verify_signature(
        raw_body: bytes | str,
        header: str | None,
        secret: str,
        *,
        now: float | None = None,
        tolerance_seconds: int = 300,
    ) -> bool:
        return _verify_signature(
            raw_body,
            header,
            secret,
            now=now,
            tolerance_seconds=tolerance_seconds,
        )


class AsyncWebhooksResource(AsyncResource):
    async def list(
        self, *, query: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/outbound-webhooks",
            query={"query": query, "limit": limit, "cursor": cursor},
        )

    async def create(self, payload: WebhookSubscriptionInput | dict[str, Any]) -> WebhookCreateResponse:
        return WebhookCreateResponse.model_validate(
            await self._client.request("POST", "/api/v1/outbound-webhooks", body=_body(payload))
        )

    async def update(self, webhook_id: str, patch: dict[str, Any]) -> WebhookSubscription:
        return WebhookSubscription.model_validate(
            await self._client.request("PATCH", f"/api/v1/outbound-webhooks/{q(webhook_id)}", body=patch)
        )

    async def delete(self, webhook_id: str, *, soft: bool = False) -> None:
        await self._client.request(
            "DELETE",
            f"/api/v1/outbound-webhooks/{q(webhook_id)}",
            query={"soft": 1 if soft else None},
        )

    async def test(self, webhook_id: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/outbound-webhooks/{q(webhook_id)}/test")

    async def deliveries(
        self, webhook_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        out = await self._client.request(
            "GET",
            f"/api/v1/outbound-webhooks/{q(webhook_id)}/deliveries",
            query={"limit": limit, "cursor": cursor},
        )
        out["deliveries"] = [WebhookDelivery.model_validate(item) for item in out.get("deliveries", [])]
        return out

    async def replay(self, delivery_id: str, *, idempotency_key: str | None = None) -> dict[str, Any]:
        path = f"/api/v1/outbound-webhooks/deliveries/{q(delivery_id)}/replay"
        if idempotency_key is None:
            return await self._client.request("POST", path)
        return await self._client.request("POST", path, idempotency_key=idempotency_key)

    async def rotate_secret(self, webhook_id: str, *, grace_minutes: int = 1440) -> WebhookCreateResponse:
        return WebhookCreateResponse.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/outbound-webhooks/{q(webhook_id)}/rotate-secret",
                query={"grace_minutes": grace_minutes},
            )
        )

    @staticmethod
    def verify_signature(
        raw_body: bytes | str,
        header: str | None,
        secret: str,
        *,
        now: float | None = None,
        tolerance_seconds: int = 300,
    ) -> bool:
        return _verify_signature(
            raw_body,
            header,
            secret,
            now=now,
            tolerance_seconds=tolerance_seconds,
        )
