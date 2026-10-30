"""api_keys.py — first-class API-key admin: list, create, get, rotate, delete.

Mirrors packages/sdk-ts/src/resources/api-keys.ts. Rotate atomically
revokes the source + creates a new one inheriting label/scopes/budget;
the OLD plaintext stops working the instant the call returns.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class APIKeysResource(SyncResource):
    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", "/api/v1/api-keys")

    def get(self, key_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/api-keys/{quote(key_id, safe='')}")

    def create(self, *, label: str, scopes: list[str], allowed_ips: list[str] | None = None, **kwargs: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"label": label, "scopes": scopes}
        if allowed_ips:
            body["allowed_ips"] = allowed_ips
        body.update(kwargs)
        return self._client.request("POST", "/api/v1/api-keys", body=body)

    def rotate(self, key_id: str) -> dict[str, Any]:
        """Atomic revoke + create. Response carries plaintext exactly once
        + revoked_id of the just-revoked source key. There is NO grace
        period; the OLD plaintext stops working immediately."""
        return self._client.request("POST", f"/api/v1/api-keys/{quote(key_id, safe='')}/rotate")

    def delete(self, key_id: str) -> dict[str, Any]:
        return self._client.request("DELETE", f"/api/v1/api-keys/{quote(key_id, safe='')}")

    revoke = delete  # alias


class AsyncAPIKeysResource(AsyncResource):
    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", "/api/v1/api-keys")

    async def get(self, key_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/api-keys/{quote(key_id, safe='')}")

    async def create(self, *, label: str, scopes: list[str], allowed_ips: list[str] | None = None, **kwargs: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"label": label, "scopes": scopes}
        if allowed_ips:
            body["allowed_ips"] = allowed_ips
        body.update(kwargs)
        return await self._client.request("POST", "/api/v1/api-keys", body=body)

    async def rotate(self, key_id: str) -> dict[str, Any]:
        return await self._client.request("POST", f"/api/v1/api-keys/{quote(key_id, safe='')}/rotate")

    async def delete(self, key_id: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/api-keys/{quote(key_id, safe='')}")

    revoke = delete
