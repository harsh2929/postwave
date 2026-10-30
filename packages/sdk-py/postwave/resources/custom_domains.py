from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class CustomDomainsResource(SyncResource):
    def list(self) -> Any:
        return self._client.request("GET", "/api/v1/custom-domains")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/custom-domains", body=payload)

    def verify(self, domain_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/custom-domains/{q(domain_id)}/verify")

    def delete(self, domain_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/custom-domains/{q(domain_id)}")


class AsyncCustomDomainsResource(AsyncResource):
    async def list(self) -> Any:
        return await self._client.request("GET", "/api/v1/custom-domains")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/custom-domains", body=payload)

    async def verify(self, domain_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/custom-domains/{q(domain_id)}/verify")

    async def delete(self, domain_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/custom-domains/{q(domain_id)}")
