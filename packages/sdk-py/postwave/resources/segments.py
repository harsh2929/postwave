from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource

Segment = dict[str, Any]
SegmentListPage = dict[str, Any]
SegmentNode = dict[str, Any]
CompileFromTextResponse = dict[str, Any]


class SegmentsResource(SyncResource):
    def list(self, *, cursor: str | None = None) -> SegmentListPage:
        return self._client.request("GET", "/api/v1/segments", query={"cursor": cursor})

    def get(self, segment_id: str) -> Segment:
        return self._client.request("GET", f"/api/v1/segments/{quote(segment_id, safe='')}")

    def create(self, payload: dict[str, Any]) -> Segment:
        return self._client.request("POST", "/api/v1/segments", body=payload)

    def update(self, segment_id: str, payload: dict[str, Any]) -> Segment:
        return self._client.request(
            "PATCH",
            f"/api/v1/segments/{quote(segment_id, safe='')}",
            body=payload,
        )

    def delete(self, segment_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/segments/{quote(segment_id, safe='')}")

    def compile_from_natural_language(self, text: str) -> CompileFromTextResponse:
        return self._client.request(
            "POST",
            "/api/v1/segments/compile-from-text",
            body={"text": text},
        )


class AsyncSegmentsResource(AsyncResource):
    async def list(self, *, cursor: str | None = None) -> SegmentListPage:
        return await self._client.request("GET", "/api/v1/segments", query={"cursor": cursor})

    async def get(self, segment_id: str) -> Segment:
        return await self._client.request("GET", f"/api/v1/segments/{quote(segment_id, safe='')}")

    async def create(self, payload: dict[str, Any]) -> Segment:
        return await self._client.request("POST", "/api/v1/segments", body=payload)

    async def update(self, segment_id: str, payload: dict[str, Any]) -> Segment:
        return await self._client.request(
            "PATCH",
            f"/api/v1/segments/{quote(segment_id, safe='')}",
            body=payload,
        )

    async def delete(self, segment_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/segments/{quote(segment_id, safe='')}")

    async def compile_from_natural_language(self, text: str) -> CompileFromTextResponse:
        return await self._client.request(
            "POST",
            "/api/v1/segments/compile-from-text",
            body={"text": text},
        )
