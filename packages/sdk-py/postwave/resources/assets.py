from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class AssetsResource(SyncResource):
    def upload(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/assets", body=payload)

    def create(self, payload: dict[str, Any]) -> Any:
        """Backward-compatible alias for :meth:`upload`."""
        return self.upload(payload)

    def list(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/assets", query=query or None)

    def get(self, asset_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/assets/{q(asset_id)}")

    def update(self, asset_id: str, alt_text: str | dict[str, Any]) -> Any:
        body = alt_text if isinstance(alt_text, dict) else {"alt_text": alt_text}
        return self._client.request(
            "PATCH", f"/api/v1/assets/{q(asset_id)}", body=body
        )

    def usage(self, asset_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/assets/{q(asset_id)}/usage")

    def delete(self, asset_id: str, *, force: bool = False) -> Any:
        return self._client.request(
            "DELETE", f"/api/v1/assets/{q(asset_id)}", query={"force": force}
        )


class AsyncAssetsResource(AsyncResource):
    async def upload(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/assets", body=payload)

    async def create(self, payload: dict[str, Any]) -> Any:
        """Backward-compatible alias for :meth:`upload`."""
        return await self.upload(payload)

    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/assets", query=query or None)

    async def get(self, asset_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/assets/{q(asset_id)}")

    async def update(self, asset_id: str, alt_text: str | dict[str, Any]) -> Any:
        body = alt_text if isinstance(alt_text, dict) else {"alt_text": alt_text}
        return await self._client.request(
            "PATCH", f"/api/v1/assets/{q(asset_id)}", body=body
        )

    async def usage(self, asset_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/assets/{q(asset_id)}/usage")

    async def delete(self, asset_id: str, *, force: bool = False) -> Any:
        return await self._client.request(
            "DELETE", f"/api/v1/assets/{q(asset_id)}", query={"force": force}
        )
