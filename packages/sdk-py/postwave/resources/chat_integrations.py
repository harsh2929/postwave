"""Slack, Discord, and Teams incoming-webhook integrations."""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from ._base import AsyncResource, SyncResource

ChatIntegrationProvider = Literal["slack", "discord", "teams"]


class ChatIntegrationChannelResource(SyncResource):
    def __init__(self, client: Any, provider: ChatIntegrationProvider) -> None:
        super().__init__(client)
        self.provider = provider
        self._base_path = f"/api/v1/integrations/{provider}"

    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", self._base_path)

    def create(self, *, url: str, events: list[str], channel_hint: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "events": events}
        if channel_hint:
            body["channel_hint"] = channel_hint
        return self._client.request("POST", self._base_path, body=body)

    def update(self, integration_id: str, **patch: Any) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"{self._base_path}/{quote(integration_id, safe='')}",
            body=patch,
        )

    def delete(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"{self._base_path}/{quote(integration_id, safe='')}",
        )


class ChatIntegrationsResource:
    def __init__(self, client: Any) -> None:
        self.slack = ChatIntegrationChannelResource(client, "slack")
        self.discord = ChatIntegrationChannelResource(client, "discord")
        self.teams = ChatIntegrationChannelResource(client, "teams")

    def for_provider(self, provider: ChatIntegrationProvider) -> ChatIntegrationChannelResource:
        return getattr(self, provider)


class AsyncChatIntegrationChannelResource(AsyncResource):
    def __init__(self, client: Any, provider: ChatIntegrationProvider) -> None:
        super().__init__(client)
        self.provider = provider
        self._base_path = f"/api/v1/integrations/{provider}"

    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", self._base_path)

    async def create(self, *, url: str, events: list[str], channel_hint: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "events": events}
        if channel_hint:
            body["channel_hint"] = channel_hint
        return await self._client.request("POST", self._base_path, body=body)

    async def update(self, integration_id: str, **patch: Any) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"{self._base_path}/{quote(integration_id, safe='')}",
            body=patch,
        )

    async def delete(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"{self._base_path}/{quote(integration_id, safe='')}",
        )


class AsyncChatIntegrationsResource:
    def __init__(self, client: Any) -> None:
        self.slack = AsyncChatIntegrationChannelResource(client, "slack")
        self.discord = AsyncChatIntegrationChannelResource(client, "discord")
        self.teams = AsyncChatIntegrationChannelResource(client, "teams")

    def for_provider(self, provider: ChatIntegrationProvider) -> AsyncChatIntegrationChannelResource:
        return getattr(self, provider)
