from __future__ import annotations

from urllib.parse import quote

from ._base import AsyncResource, SyncResource
from ..types.voice import Template, TemplateCategory


class TemplatesResource(SyncResource):
    def list(self, category: TemplateCategory | None = None) -> list[Template]:
        rows = self._client.request("GET", "/api/v1/voice/templates", query={"category": category})
        return [Template.model_validate(p) for p in rows]

    def get(self, id_or_slug: str) -> Template:
        return Template.model_validate(
            self._client.request("GET", f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}")
        )

    def create(self, t: Template | dict) -> Template:
        body = t.model_dump(exclude_none=True) if isinstance(t, Template) else t
        return Template.model_validate(self._client.request("POST", "/api/v1/voice/templates", body=body))

    def update(self, id_or_slug: str, payload: Template | dict) -> Template:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, Template) else payload
        return Template.model_validate(
            self._client.request(
                "PATCH",
                f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}",
                body=body,
            )
        )

    def delete(self, id_or_slug: str) -> None:
        self._client.request("DELETE", f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}")
        return None


class AsyncTemplatesResource(AsyncResource):
    async def list(self, category: TemplateCategory | None = None) -> list[Template]:
        rows = await self._client.request("GET", "/api/v1/voice/templates", query={"category": category})
        return [Template.model_validate(p) for p in rows]

    async def get(self, id_or_slug: str) -> Template:
        return Template.model_validate(
            await self._client.request("GET", f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}")
        )

    async def create(self, t: Template | dict) -> Template:
        body = t.model_dump(exclude_none=True) if isinstance(t, Template) else t
        return Template.model_validate(await self._client.request("POST", "/api/v1/voice/templates", body=body))

    async def update(self, id_or_slug: str, payload: Template | dict) -> Template:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, Template) else payload
        return Template.model_validate(
            await self._client.request(
                "PATCH",
                f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}",
                body=body,
            )
        )

    async def delete(self, id_or_slug: str) -> None:
        await self._client.request("DELETE", f"/api/v1/voice/templates/{quote(id_or_slug, safe='')}")
        return None
