from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.common import Subscriber, SubscriberPage


class SubscribersResource(SyncResource):
    def transform_rules(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/profile-transform-rules")

    def upsert_transform_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/profile-transform-rules", body=payload)

    def delete_transform_rule(self, rule_id: str) -> dict[str, Any]:
        if not rule_id.strip():
            raise ValueError("Profile transform rule ID is required")
        return self._client.request("DELETE", f"/api/v1/profile-transform-rules/{q(rule_id.strip())}")

    def list(self, list_id: int | None = None, page: int = 1, per_page: int = 50) -> SubscriberPage:
        return SubscriberPage.model_validate(
            self._client.request("GET", "/api/v1/subscribers", query={"list_id": list_id, "page": page, "per_page": per_page})
        )

    def get(self, sub_id: str) -> Subscriber:
        return Subscriber.model_validate(self._client.request("GET", f"/api/v1/subscribers/{q(sub_id)}"))

    def create(self, payload: dict[str, Any]) -> Subscriber:
        return Subscriber.model_validate(self._client.request("POST", "/api/v1/subscribers", body=payload))

    def update(self, sub_id: str, patch: dict[str, Any]) -> Subscriber:
        return Subscriber.model_validate(self._client.request("PATCH", f"/api/v1/subscribers/{q(sub_id)}", body=patch))

    def delete(self, sub_id: str) -> None:
        self._client.request("DELETE", f"/api/v1/subscribers/{q(sub_id)}")

    def search(self, q: str) -> SubscriberPage:
        return SubscriberPage.model_validate(self._client.request("GET", "/api/v1/subscribers/search", query={"q": q}))

    def suppress(self, sub_id: str) -> None:
        self._client.request("POST", f"/api/v1/subscribers/{q(sub_id)}/suppress")

    def inferred_trait(self, sub_id: str, trait: str) -> dict[str, Any]:
        """Inferred trait (gender|age_group|interests) for a subscriber."""
        return self._client.request("GET", f"/api/v1/subscribers/{q(sub_id)}/traits/inferred_{trait}")

    def lookalike_list(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/subscribers/lookalike")

    def lookalike_generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/subscribers/lookalike", body=payload)

    def lookalike_get(self, lookalike_id: str, page: int = 1, per_page: int = 50) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/subscribers/lookalike/{q(lookalike_id)}", query={"page": page, "per_page": per_page})


class AsyncSubscribersResource(AsyncResource):
    async def transform_rules(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/profile-transform-rules")

    async def upsert_transform_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/profile-transform-rules", body=payload)

    async def delete_transform_rule(self, rule_id: str) -> dict[str, Any]:
        if not rule_id.strip():
            raise ValueError("Profile transform rule ID is required")
        return await self._client.request("DELETE", f"/api/v1/profile-transform-rules/{q(rule_id.strip())}")

    async def list(self, list_id: int | None = None, page: int = 1, per_page: int = 50) -> SubscriberPage:
        return SubscriberPage.model_validate(
            await self._client.request(
                "GET", "/api/v1/subscribers",
                query={"list_id": list_id, "page": page, "per_page": per_page},
            )
        )

    async def get(self, sub_id: str) -> Subscriber:
        return Subscriber.model_validate(await self._client.request("GET", f"/api/v1/subscribers/{q(sub_id)}"))

    async def create(self, payload: dict[str, Any]) -> Subscriber:
        return Subscriber.model_validate(await self._client.request("POST", "/api/v1/subscribers", body=payload))

    async def update(self, sub_id: str, patch: dict[str, Any]) -> Subscriber:
        return Subscriber.model_validate(await self._client.request("PATCH", f"/api/v1/subscribers/{q(sub_id)}", body=patch))

    async def delete(self, sub_id: str) -> None:
        await self._client.request("DELETE", f"/api/v1/subscribers/{q(sub_id)}")

    async def search(self, q: str) -> SubscriberPage:
        return SubscriberPage.model_validate(await self._client.request("GET", "/api/v1/subscribers/search", query={"q": q}))

    async def suppress(self, sub_id: str) -> None:
        await self._client.request("POST", f"/api/v1/subscribers/{q(sub_id)}/suppress")

    async def inferred_trait(self, sub_id: str, trait: str) -> dict[str, Any]:
        """Inferred trait (gender|age_group|interests) for a subscriber."""
        return await self._client.request("GET", f"/api/v1/subscribers/{q(sub_id)}/traits/inferred_{trait}")

    async def lookalike_list(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/subscribers/lookalike")

    async def lookalike_generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/subscribers/lookalike", body=payload)

    async def lookalike_get(self, lookalike_id: str, page: int = 1, per_page: int = 50) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/subscribers/lookalike/{q(lookalike_id)}", query={"page": page, "per_page": per_page})
