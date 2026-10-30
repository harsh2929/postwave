from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class TagsResource(SyncResource):
    def list(
        self,
        *,
        query: str | None = None,
        group_id: str | None = None,
        include_archived: bool = False,
    ) -> Any:
        return self._client.request(
            "GET",
            "/api/v1/tags",
            query={
                "query": query,
                "group_id": group_id,
                "include_archived": include_archived,
            },
        )

    def create(
        self,
        name: str,
        *,
        color: str | None = None,
        description: str | None = None,
        group_id: str | None = None,
        pii: bool = False,
    ) -> Any:
        body: dict[str, Any] = {"name": name, "pii": pii}
        if color is not None:
            body["color"] = color
        if description is not None:
            body["description"] = description
        if group_id is not None:
            body["group_id"] = group_id
        return self._client.request("POST", "/api/v1/tags", body=body)

    def update(self, tag_id: str, patch: dict[str, Any], *, etag: str) -> Any:
        return self._client.request(
            "PATCH",
            f"/api/v1/tags/{q(tag_id)}",
            body=patch,
            headers={"If-Match": etag},
        )

    def delete(self, tag_id: str) -> Any:
        """Compatibility call that always raises unsafe_mutation_disabled."""
        return self._client.request("DELETE", f"/api/v1/tags/{q(tag_id)}")


class AsyncTagsResource(AsyncResource):
    async def list(
        self,
        *,
        query: str | None = None,
        group_id: str | None = None,
        include_archived: bool = False,
    ) -> Any:
        return await self._client.request(
            "GET",
            "/api/v1/tags",
            query={
                "query": query,
                "group_id": group_id,
                "include_archived": include_archived,
            },
        )

    async def create(
        self,
        name: str,
        *,
        color: str | None = None,
        description: str | None = None,
        group_id: str | None = None,
        pii: bool = False,
    ) -> Any:
        body: dict[str, Any] = {"name": name, "pii": pii}
        if color is not None:
            body["color"] = color
        if description is not None:
            body["description"] = description
        if group_id is not None:
            body["group_id"] = group_id
        return await self._client.request("POST", "/api/v1/tags", body=body)

    async def update(self, tag_id: str, patch: dict[str, Any], *, etag: str) -> Any:
        return await self._client.request(
            "PATCH",
            f"/api/v1/tags/{q(tag_id)}",
            body=patch,
            headers={"If-Match": etag},
        )

    async def delete(self, tag_id: str) -> Any:
        """Compatibility call that always raises unsafe_mutation_disabled."""
        return await self._client.request("DELETE", f"/api/v1/tags/{q(tag_id)}")
