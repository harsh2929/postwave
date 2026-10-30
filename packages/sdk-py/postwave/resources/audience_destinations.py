"""Ad audience destination lifecycle resource."""

from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from .integrations import path_segment


class AudienceDestinationsResource(SyncResource):
    def providers(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/audience-destinations/providers")

    def list(self, provider: str | None = None) -> dict[str, Any]:
        query = {"provider": provider} if provider else None
        return self._client.request("GET", "/api/v1/audience-destinations", query=query)

    def get(self, destination_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
        )

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/audience-destinations", body=payload)

    def update(self, destination_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
            body=payload,
        )

    def disconnect(self, destination_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
        )

    def readiness(self, provider: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/audience-destinations/{path_segment(provider, 'audience destination provider')}/readiness",
            body={"config": config or {}},
        )

    def preview(self, destination_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/preview",
        )

    def sync(self, destination_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/sync",
            body={},
        )

    def jobs(self, destination_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/jobs",
        )

    def job_diagnostics(self, destination_id: str, job_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/jobs/{path_segment(job_id, 'audience destination job id')}/diagnostics",
        )


class AsyncAudienceDestinationsResource(AsyncResource):
    async def providers(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/audience-destinations/providers")

    async def list(self, provider: str | None = None) -> dict[str, Any]:
        query = {"provider": provider} if provider else None
        return await self._client.request("GET", "/api/v1/audience-destinations", query=query)

    async def get(self, destination_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
        )

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/audience-destinations", body=payload)

    async def update(self, destination_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
            body=payload,
        )

    async def disconnect(self, destination_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}",
        )

    async def readiness(self, provider: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/audience-destinations/{path_segment(provider, 'audience destination provider')}/readiness",
            body={"config": config or {}},
        )

    async def preview(self, destination_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/preview",
        )

    async def sync(self, destination_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/sync",
            body={},
        )

    async def jobs(self, destination_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/jobs",
        )

    async def job_diagnostics(self, destination_id: str, job_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audience-destinations/{path_segment(destination_id, 'audience destination id')}/jobs/{path_segment(job_id, 'audience destination job id')}/diagnostics",
        )
