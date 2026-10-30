"""Audiences resource — first-party lookalike audiences (SUB-033).

Distinct from ``subscribers.lookalike*`` (SUB-068), which target the
``/api/v1/subscribers/lookalike`` endpoints.

    POST   /api/v1/audiences/lookalike              generate -> LookalikeModel
    GET    /api/v1/audiences/lookalike/{id}          get      -> LookalikeModel
    GET    /api/v1/audiences/lookalike/{id}/members  members  -> LookalikeMemberPage
    DELETE /api/v1/audiences/lookalike/{id}          discard  -> 204
"""

from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from .integrations import path_segment


class AudiencesResource(SyncResource):
    def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Generate a lookalike audience from a seed segment.

        ``payload`` keys: ``seed_segment_id`` (required), ``name``,
        ``size`` (100-10000, default 1000), ``confidence_threshold``.
        """
        return self._client.request("POST", "/api/v1/audiences/lookalike", body=payload)

    def get(self, lookalike_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}",
        )

    def members(
        self,
        lookalike_id: str,
        page: int | None = None,
        per_page: int | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}/members",
            query={"page": page, "per_page": per_page},
        )

    def discard(self, lookalike_id: str) -> Any:
        return self._client.request(
            "DELETE",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}",
        )


class AsyncAudiencesResource(AsyncResource):
    async def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/audiences/lookalike", body=payload)

    async def get(self, lookalike_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}",
        )

    async def members(
        self,
        lookalike_id: str,
        page: int | None = None,
        per_page: int | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}/members",
            query={"page": page, "per_page": per_page},
        )

    async def discard(self, lookalike_id: str) -> Any:
        return await self._client.request(
            "DELETE",
            f"/api/v1/audiences/lookalike/{path_segment(lookalike_id, 'lookalike audience id')}",
        )
