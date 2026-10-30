"""First-party mobile push installation lifecycle.

The API never returns an Expo token. Registration, status, and authenticated
revocation use the per-installation possession key; possession revocation is
also available after the dashboard session has ended.
"""

from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class MobilePushResource(SyncResource):
    def register(self, input: dict[str, Any]) -> Any:
        return self._client.request(
            "POST", "/api/v1/mobile/push/devices", body=input
        )

    def status(self, device_key: str) -> Any:
        return self._client.request(
            "POST",
            "/api/v1/mobile/push/devices/status",
            body={"device_key": device_key},
        )

    def revoke(self, device_key: str) -> Any:
        return self._client.request(
            "POST",
            "/api/v1/mobile/push/devices/revoke",
            body={"device_key": device_key},
        )

    def revoke_possession(self, device_key: str) -> Any:
        return self._client.request(
            "POST",
            "/api/public/mobile/push/revoke",
            body={"device_key": device_key},
        )


class AsyncMobilePushResource(AsyncResource):
    async def register(self, input: dict[str, Any]) -> Any:
        return await self._client.request(
            "POST", "/api/v1/mobile/push/devices", body=input
        )

    async def status(self, device_key: str) -> Any:
        return await self._client.request(
            "POST",
            "/api/v1/mobile/push/devices/status",
            body={"device_key": device_key},
        )

    async def revoke(self, device_key: str) -> Any:
        return await self._client.request(
            "POST",
            "/api/v1/mobile/push/devices/revoke",
            body={"device_key": device_key},
        )

    async def revoke_possession(self, device_key: str) -> Any:
        return await self._client.request(
            "POST",
            "/api/public/mobile/push/revoke",
            body={"device_key": device_key},
        )
