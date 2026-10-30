"""Small helpers for resource modules without bespoke pydantic models."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


def q(value: Any) -> str:
    return quote(str(value), safe="")


class SyncCRUDResource(SyncResource):
    path: str

    def list(self, **query: Any) -> Any:
        return self._client.request("GET", self.path, query=query or None)

    def get(self, resource_id: str) -> Any:
        return self._client.request("GET", f"{self.path}/{q(resource_id)}")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", self.path, body=payload)

    def update(self, resource_id: str, patch: dict[str, Any]) -> Any:
        return self._client.request("PATCH", f"{self.path}/{q(resource_id)}", body=patch)

    def delete(self, resource_id: str) -> Any:
        return self._client.request("DELETE", f"{self.path}/{q(resource_id)}")


class AsyncCRUDResource(AsyncResource):
    path: str

    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", self.path, query=query or None)

    async def get(self, resource_id: str) -> Any:
        return await self._client.request("GET", f"{self.path}/{q(resource_id)}")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", self.path, body=payload)

    async def update(self, resource_id: str, patch: dict[str, Any]) -> Any:
        return await self._client.request("PATCH", f"{self.path}/{q(resource_id)}", body=patch)

    async def delete(self, resource_id: str) -> Any:
        return await self._client.request("DELETE", f"{self.path}/{q(resource_id)}")
