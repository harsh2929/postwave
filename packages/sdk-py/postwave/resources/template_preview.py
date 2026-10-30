from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class TemplatePreviewResource(SyncResource):
    def preview(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/templates/preview", body=payload)


class AsyncTemplatePreviewResource(AsyncResource):
    async def preview(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/templates/preview", body=payload)
