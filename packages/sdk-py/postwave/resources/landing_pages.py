"""landing_pages.py — admin CRUD for the landing-pages library."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class LandingPagesResource(SyncResource):
    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", "/api/v1/landing-pages")

    def get(self, page_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/landing-pages/{quote(page_id, safe='')}")

    def create(self, *, slug: str, name: str, **fields: Any) -> dict[str, Any]:
        body = {"slug": slug, "name": name, **fields}
        return self._client.request("POST", "/api/v1/landing-pages", body=body)

    def update(self, page_id: str, **patch: Any) -> dict[str, Any]:
        return self._client.request("PATCH", f"/api/v1/landing-pages/{quote(page_id, safe='')}", body=patch)

    def archive(self, page_id: str) -> dict[str, Any]:
        """Soft-archive (status -> 'archived'). Hard delete is not exposed."""
        return self._client.request("DELETE", f"/api/v1/landing-pages/{quote(page_id, safe='')}")


class AsyncLandingPagesResource(AsyncResource):
    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", "/api/v1/landing-pages")

    async def get(self, page_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/landing-pages/{quote(page_id, safe='')}")

    async def create(self, *, slug: str, name: str, **fields: Any) -> dict[str, Any]:
        body = {"slug": slug, "name": name, **fields}
        return await self._client.request("POST", "/api/v1/landing-pages", body=body)

    async def update(self, page_id: str, **patch: Any) -> dict[str, Any]:
        return await self._client.request("PATCH", f"/api/v1/landing-pages/{quote(page_id, safe='')}", body=patch)

    async def archive(self, page_id: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/landing-pages/{quote(page_id, safe='')}")
