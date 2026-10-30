"""Audience sync lifecycle resource."""

from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from .integrations import path_segment


class AudienceSyncsResource(SyncResource):
    def list(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/audience-syncs")

    def get(self, sync_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/audience-syncs", body=payload)

    def update(self, sync_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}",
            body=payload,
        )

    def delete(self, sync_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}")

    def run(self, sync_id: str) -> dict[str, Any]:
        return self._client.request("POST", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}/run")

    def runs(self, sync_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}/runs")


class AsyncAudienceSyncsResource(AsyncResource):
    async def list(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/audience-syncs")

    async def get(self, sync_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}")

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/audience-syncs", body=payload)

    async def update(self, sync_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}",
            body=payload,
        )

    async def delete(self, sync_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}")

    async def run(self, sync_id: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}/run")

    async def runs(self, sync_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/audience-syncs/{path_segment(sync_id, 'audience sync id')}/runs")
