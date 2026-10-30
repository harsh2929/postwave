from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class ScimResource(SyncResource):
    def list_tokens(self) -> Any:
        return self._client.request("GET", "/api/v1/scim/tokens")

    def create_token(self, payload: dict[str, Any] | None = None) -> Any:
        return self._client.request("POST", "/api/v1/scim/tokens", body=payload or {})

    def revoke_token(self, token_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/scim/tokens/{q(token_id)}")

    def list_role_mappings(self) -> Any:
        return self._client.request("GET", "/api/v1/scim/role-mappings")

    def upsert_role_mapping(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/scim/role-mappings", body=payload)

    def delete_role_mapping(self, mapping_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/scim/role-mappings/{q(mapping_id)}")


class AsyncScimResource(AsyncResource):
    async def list_tokens(self) -> Any:
        return await self._client.request("GET", "/api/v1/scim/tokens")

    async def create_token(self, payload: dict[str, Any] | None = None) -> Any:
        return await self._client.request("POST", "/api/v1/scim/tokens", body=payload or {})

    async def revoke_token(self, token_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/scim/tokens/{q(token_id)}")

    async def list_role_mappings(self) -> Any:
        return await self._client.request("GET", "/api/v1/scim/role-mappings")

    async def upsert_role_mapping(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/scim/role-mappings", body=payload)

    async def delete_role_mapping(self, mapping_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/scim/role-mappings/{q(mapping_id)}")
