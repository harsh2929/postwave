"""slack_integrations.py — Slack incoming-webhook integrations.

URL is envelope-encrypted server-side; reads return only channel hint
+ delivery status. Pass it once on create(); to rotate, update().
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class SlackIntegrationsResource(SyncResource):
    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", "/api/v1/integrations/slack")

    def create(self, *, url: str, events: list[str], channel_hint: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "events": events}
        if channel_hint:
            body["channel_hint"] = channel_hint
        return self._client.request("POST", "/api/v1/integrations/slack", body=body)

    def update(self, integ_id: str, **patch: Any) -> dict[str, Any]:
        return self._client.request("PATCH", f"/api/v1/integrations/slack/{quote(integ_id, safe='')}", body=patch)

    def delete(self, integ_id: str) -> dict[str, Any]:
        return self._client.request("DELETE", f"/api/v1/integrations/slack/{quote(integ_id, safe='')}")


class AsyncSlackIntegrationsResource(AsyncResource):
    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", "/api/v1/integrations/slack")

    async def create(self, *, url: str, events: list[str], channel_hint: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "events": events}
        if channel_hint:
            body["channel_hint"] = channel_hint
        return await self._client.request("POST", "/api/v1/integrations/slack", body=body)

    async def update(self, integ_id: str, **patch: Any) -> dict[str, Any]:
        return await self._client.request("PATCH", f"/api/v1/integrations/slack/{quote(integ_id, safe='')}", body=patch)

    async def delete(self, integ_id: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/integrations/slack/{quote(integ_id, safe='')}")
