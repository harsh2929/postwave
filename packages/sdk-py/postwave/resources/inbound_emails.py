from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class InboundEmailsResource(SyncResource):
    def list(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/inbound-emails", query=query or None)

    def endpoint(self) -> Any:
        return self._client.request("GET", "/api/v1/inbound-emails/endpoint")

    def rotate_endpoint(self) -> Any:
        return self._client.request("POST", "/api/v1/inbound-emails/endpoint/rotate")


class AsyncInboundEmailsResource(AsyncResource):
    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/inbound-emails", query=query or None)

    async def endpoint(self) -> Any:
        return await self._client.request("GET", "/api/v1/inbound-emails/endpoint")

    async def rotate_endpoint(self) -> Any:
        return await self._client.request("POST", "/api/v1/inbound-emails/endpoint/rotate")
