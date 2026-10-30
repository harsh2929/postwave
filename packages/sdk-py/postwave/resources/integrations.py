"""Unified integrations catalog and lifecycle facade."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


def path_segment(value: str, label: str = "integration slug") -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError(f"{label} is required")
    return quote(trimmed, safe="")


class IntegrationsResource(SyncResource):
    def catalog(self, **query: Any) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/catalog", query=query or None)

    def connections(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/connections")

    def coverage(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/coverage")

    def stacks(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/stacks")

    def readiness(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/readiness")

    def recipes(self, **query: Any) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/integrations/recipes", query=query or None)

    def recipe(self, recipe_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/integrations/recipes/{path_segment(recipe_id, 'recipe id')}")

    def apply_recipe(self, recipe_id: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/recipes/{path_segment(recipe_id, 'recipe id')}/apply")

    def detail(self, slug: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}")

    def contract(self, slug: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}/contract")

    def health(self, slug: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}/health")

    def start_connect(self, slug: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/connect/start")

    def finish_connect(self, slug: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/connect/callback")

    def sync(self, slug: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/sync")

    def backfill(self, slug: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/backfill")

    def pause(self, slug: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/pause")

    def disconnect(self, slug: str) -> dict[str, Any]:
        return self._client.request("DELETE", f"/api/v1/integrations/{path_segment(slug)}")


class AsyncIntegrationsResource(AsyncResource):
    async def catalog(self, **query: Any) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/catalog", query=query or None)

    async def connections(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/connections")

    async def coverage(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/coverage")

    async def stacks(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/stacks")

    async def readiness(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/readiness")

    async def recipes(self, **query: Any) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/integrations/recipes", query=query or None)

    async def recipe(self, recipe_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/integrations/recipes/{path_segment(recipe_id, 'recipe id')}")

    async def apply_recipe(self, recipe_id: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/recipes/{path_segment(recipe_id, 'recipe id')}/apply")

    async def detail(self, slug: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}")

    async def contract(self, slug: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}/contract")

    async def health(self, slug: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/integrations/{path_segment(slug)}/health")

    async def start_connect(self, slug: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/connect/start")

    async def finish_connect(self, slug: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/connect/callback")

    async def sync(self, slug: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/sync")

    async def backfill(self, slug: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/backfill")

    async def pause(self, slug: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/integrations/{path_segment(slug)}/pause")

    async def disconnect(self, slug: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/integrations/{path_segment(slug)}")
