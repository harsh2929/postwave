from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class InboundRoutesResource(SyncResource):
    def list(self) -> Any:
        return self._client.request("GET", "/api/v1/inbound-routes")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/inbound-routes", body=payload)

    def patch(self, route_id: str, patch: dict[str, Any]) -> Any:
        return self._client.request("PATCH", f"/api/v1/inbound-routes/{q(route_id)}", body=patch)

    def delete(self, route_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/inbound-routes/{q(route_id)}")


class AsyncInboundRoutesResource(AsyncResource):
    async def list(self) -> Any:
        return await self._client.request("GET", "/api/v1/inbound-routes")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/inbound-routes", body=payload)

    async def patch(self, route_id: str, patch: dict[str, Any]) -> Any:
        return await self._client.request("PATCH", f"/api/v1/inbound-routes/{q(route_id)}", body=patch)

    async def delete(self, route_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/inbound-routes/{q(route_id)}")
