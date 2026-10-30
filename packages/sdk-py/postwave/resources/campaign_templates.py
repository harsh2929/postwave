"""Visual campaign-template catalog, personal discovery, and durable design jobs.

This resource is deliberately separate from :mod:`templates`, which contains
voice/sequence templates rather than concrete HTML/MJML newsletter designs.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any
from urllib.parse import quote

from ..errors import TimeoutError as PostwaveTimeoutError
from ._base import AsyncResource, SyncResource


_STRONG_ETAG = re.compile(r'^"[^"\r\n]+"$')
_DISCOVERY_ETAG = re.compile(
    r'^"(campaign-template-collection|campaign-template-saved-search):'
    r'([^"\\\s,]+):v([1-9]\d*)"$'
)


def _segment(value: str) -> str:
    return quote(value, safe="")


def _search_query(params: dict[str, Any] | None) -> dict[str, Any]:
    """Copy search params and encode tag arrays like the TypeScript SDK."""
    query = dict(params or {})
    tags = query.get("tags")
    if isinstance(tags, (list, tuple)):
        query["tags"] = ",".join(str(tag) for tag in tags)
    return query


def _if_match(value: str) -> str:
    if not isinstance(value, str) or _STRONG_ETAG.fullmatch(value) is None:
        raise ValueError(
            "if_match must be the exact strong etag returned by the API"
        )
    return value


def _discovery_if_match(value: str, resource: str, resource_id: str) -> str:
    match = _DISCOVERY_ETAG.fullmatch(value) if isinstance(value, str) else None
    if (
        match is None
        or match.group(1) != resource
        or match.group(2) != resource_id
    ):
        raise ValueError(
            f"if_match must be the exact current {resource} etag returned by the API"
        )
    return value


def _idempotency_key(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > 255
        or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value)
    ):
        raise ValueError(
            "idempotency_key must be 1-255 UTF-8 bytes without control characters"
        )
    return value


def _revision(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("version must be a positive integer")
    return value


def _design_list_query(
    *, limit: int | None, cursor: str | None
) -> dict[str, Any]:
    if limit is not None and (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > 50
    ):
        raise ValueError(
            "design list limit must be an integer between 1 and 50"
        )
    if cursor is not None:
        if not isinstance(cursor, str):
            raise TypeError("design list cursor must be a string")
        if cursor != cursor.strip() or len(cursor.encode("utf-8")) > 1024:
            raise ValueError(
                "design list cursor must be unchanged and at most "
                "1024 UTF-8 bytes"
            )
    return {"limit": limit, "cursor": cursor}


class CampaignTemplatesResource(SyncResource):
    """Concrete visual templates and reference designs."""

    def list(self, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return self._client.request(
            "GET", "/api/v1/campaign-templates", query=_search_query(params)
        )

    def search(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/campaign-templates/search",
            query=_search_query(params),
        )

    def get(self, template_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET", f"/api/v1/campaign-templates/{_segment(template_id)}"
        )

    def favorite(self, template_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/favorite",
            body={},
        )

    def unfavorite(self, template_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/unfavorite",
            body={},
        )

    def compare(self, identifiers: list[str]) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/campaign-templates/compare",
            query={"templates": ",".join(identifiers)},
        )

    def record_view(self, template_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/view",
            body={},
        )

    def recent(self, *, limit: int | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET", "/api/v1/campaign-templates/recent", query={"limit": limit}
        )

    def clear_recent(self, template_id: str | None = None) -> dict[str, Any]:
        path = "/api/v1/campaign-templates/recent"
        if template_id is not None:
            path += f"/{_segment(template_id)}"
        return self._client.request("DELETE", path)

    def list_collections(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/campaign-template-collections")

    def get_collection(self, collection_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
        )

    def create_collection(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/campaign-template-collections",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def update_collection(
        self,
        collection_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
            body=patch,
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    def replace_collection_items(
        self,
        collection_id: str,
        template_ids: list[str],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "PUT",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}/items",
            body={"template_ids": template_ids},
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    def delete_collection(
        self, collection_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    def list_saved_searches(self) -> dict[str, Any]:
        return self._client.request(
            "GET", "/api/v1/campaign-template-saved-searches"
        )

    def get_saved_search(self, saved_search_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
        )

    def create_saved_search(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/campaign-template-saved-searches",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def update_saved_search(
        self,
        saved_search_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
            body=patch,
            headers={
                "If-Match": _discovery_if_match(
                    if_match,
                    "campaign-template-saved-search",
                    saved_search_id,
                )
            },
        )

    def delete_saved_search(
        self, saved_search_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
            headers={
                "If-Match": _discovery_if_match(
                    if_match,
                    "campaign-template-saved-search",
                    saved_search_id,
                )
            },
        )

    def saved_search_results(
        self,
        saved_search_id: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}/results",
            query=dict(params or {}),
        )

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST", "/api/v1/campaign-templates", body=payload
        )

    def update(
        self,
        template_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}",
            body=patch,
            headers={"If-Match": _if_match(if_match)},
        )

    def archive(self, template_id: str, *, if_match: str) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}/archive",
            headers={"If-Match": _if_match(if_match)},
        )

    def restore(self, template_id: str, *, if_match: str) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}/restore",
            headers={"If-Match": _if_match(if_match)},
        )

    def delete(self, template_id: str, *, if_match: str) -> dict[str, Any]:
        """Compatibility alias for recoverable archival; no hard delete occurs."""
        return self._client.request(
            "DELETE",
            f"/api/v1/campaign-templates/{_segment(template_id)}",
            headers={"If-Match": _if_match(if_match)},
        )

    def list_revisions(
        self, template_id: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-templates/{_segment(template_id)}/revisions",
            query=dict(params or {}),
        )

    def get_revision(self, template_id: str, version: int) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-templates/{_segment(template_id)}/revisions/{_revision(version)}",
        )

    def clone(
        self,
        template_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/clone",
            body=dict(payload or {}),
        )

    def adapt(
        self,
        template_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        body = dict(payload)
        body.update(mode="adapt", source_template_id=template_id)
        return self.create_design(body, idempotency_key=idempotency_key)

    def generate(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        body = dict(payload)
        body["mode"] = "generate"
        return self.create_design(body, idempotency_key=idempotency_key)

    def create_design(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/campaign-template-designs",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def list_designs(
        self, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        """Recover this exact authenticated actor's active design jobs."""
        return self._client.request(
            "GET",
            "/api/v1/campaign-template-designs",
            query=_design_list_query(limit=limit, cursor=cursor),
        )

    def get_design(self, design_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET", f"/api/v1/campaign-template-designs/{_segment(design_id)}"
        )

    def list_design_revisions(self, design_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/revisions",
        )

    def refine_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/refine",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def retry_design(
        self, design_id: str, *, idempotency_key: str
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/retry",
            body={},
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def save_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/save",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def create_campaign_from_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/create-campaign",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def archive_design(
        self, design_id: str, *, idempotency_key: str
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/archive",
            body={},
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def wait_for_design(
        self,
        design_id: str,
        *,
        interval_s: float = 1.0,
        timeout_s: float = 120.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            draft = self.get_design(design_id)
            if draft.get("status") not in ("queued", "generating"):
                return draft
            delay = max(interval_s, float(draft.get("retry_after_seconds") or 0))
            time.sleep(delay)
        raise PostwaveTimeoutError(
            f"campaign_templates.wait_for_design({design_id}): "
            f"timed out after {timeout_s}s"
        )

    def create_campaign(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a draft from a template; this never sends the campaign."""
        return self._client.request(
            "POST", "/api/v1/campaigns/from-template", body=payload
        )


class AsyncCampaignTemplatesResource(AsyncResource):
    """Async concrete visual templates and reference designs."""

    async def list(
        self, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        return await self._client.request(
            "GET", "/api/v1/campaign-templates", query=_search_query(params)
        )

    async def search(
        self, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/campaign-templates/search",
            query=_search_query(params),
        )

    async def get(self, template_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET", f"/api/v1/campaign-templates/{_segment(template_id)}"
        )

    async def favorite(self, template_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/favorite",
            body={},
        )

    async def unfavorite(self, template_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/unfavorite",
            body={},
        )

    async def compare(self, identifiers: list[str]) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/campaign-templates/compare",
            query={"templates": ",".join(identifiers)},
        )

    async def record_view(self, template_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/view",
            body={},
        )

    async def recent(self, *, limit: int | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET", "/api/v1/campaign-templates/recent", query={"limit": limit}
        )

    async def clear_recent(
        self, template_id: str | None = None
    ) -> dict[str, Any]:
        path = "/api/v1/campaign-templates/recent"
        if template_id is not None:
            path += f"/{_segment(template_id)}"
        return await self._client.request("DELETE", path)

    async def list_collections(self) -> dict[str, Any]:
        return await self._client.request(
            "GET", "/api/v1/campaign-template-collections"
        )

    async def get_collection(self, collection_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
        )

    async def create_collection(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/campaign-template-collections",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def update_collection(
        self,
        collection_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
            body=patch,
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    async def replace_collection_items(
        self,
        collection_id: str,
        template_ids: list[str],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "PUT",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}/items",
            body={"template_ids": template_ids},
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    async def delete_collection(
        self, collection_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/campaign-template-collections/{_segment(collection_id)}",
            headers={
                "If-Match": _discovery_if_match(
                    if_match, "campaign-template-collection", collection_id
                )
            },
        )

    async def list_saved_searches(self) -> dict[str, Any]:
        return await self._client.request(
            "GET", "/api/v1/campaign-template-saved-searches"
        )

    async def get_saved_search(self, saved_search_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
        )

    async def create_saved_search(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/campaign-template-saved-searches",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def update_saved_search(
        self,
        saved_search_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
            body=patch,
            headers={
                "If-Match": _discovery_if_match(
                    if_match,
                    "campaign-template-saved-search",
                    saved_search_id,
                )
            },
        )

    async def delete_saved_search(
        self, saved_search_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}",
            headers={
                "If-Match": _discovery_if_match(
                    if_match,
                    "campaign-template-saved-search",
                    saved_search_id,
                )
            },
        )

    async def saved_search_results(
        self,
        saved_search_id: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-template-saved-searches/{_segment(saved_search_id)}/results",
            query=dict(params or {}),
        )

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST", "/api/v1/campaign-templates", body=payload
        )

    async def update(
        self,
        template_id: str,
        patch: dict[str, Any],
        *,
        if_match: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}",
            body=patch,
            headers={"If-Match": _if_match(if_match)},
        )

    async def archive(
        self, template_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}/archive",
            headers={"If-Match": _if_match(if_match)},
        )

    async def restore(
        self, template_id: str, *, if_match: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaign-templates/{_segment(template_id)}/restore",
            headers={"If-Match": _if_match(if_match)},
        )

    async def delete(
        self, template_id: str, *, if_match: str
    ) -> dict[str, Any]:
        """Compatibility alias for recoverable archival; no hard delete occurs."""
        return await self._client.request(
            "DELETE",
            f"/api/v1/campaign-templates/{_segment(template_id)}",
            headers={"If-Match": _if_match(if_match)},
        )

    async def list_revisions(
        self, template_id: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-templates/{_segment(template_id)}/revisions",
            query=dict(params or {}),
        )

    async def get_revision(
        self, template_id: str, version: int
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-templates/{_segment(template_id)}/revisions/{_revision(version)}",
        )

    async def clone(
        self,
        template_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-templates/{_segment(template_id)}/clone",
            body=dict(payload or {}),
        )

    async def adapt(
        self,
        template_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        body = dict(payload)
        body.update(mode="adapt", source_template_id=template_id)
        return await self.create_design(body, idempotency_key=idempotency_key)

    async def generate(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        body = dict(payload)
        body["mode"] = "generate"
        return await self.create_design(body, idempotency_key=idempotency_key)

    async def create_design(
        self, payload: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/campaign-template-designs",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def list_designs(
        self, *, limit: int | None = None, cursor: str | None = None
    ) -> dict[str, Any]:
        """Recover this exact authenticated actor's active design jobs."""
        return await self._client.request(
            "GET",
            "/api/v1/campaign-template-designs",
            query=_design_list_query(limit=limit, cursor=cursor),
        )

    async def get_design(self, design_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET", f"/api/v1/campaign-template-designs/{_segment(design_id)}"
        )

    async def list_design_revisions(self, design_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/revisions",
        )

    async def refine_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/refine",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def retry_design(
        self, design_id: str, *, idempotency_key: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/retry",
            body={},
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def save_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/save",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def create_campaign_from_design(
        self,
        design_id: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/create-campaign",
            body=payload,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def archive_design(
        self, design_id: str, *, idempotency_key: str
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaign-template-designs/{_segment(design_id)}/archive",
            body={},
            idempotency_key=_idempotency_key(idempotency_key),
        )

    async def wait_for_design(
        self,
        design_id: str,
        *,
        interval_s: float = 1.0,
        timeout_s: float = 120.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            draft = await self.get_design(design_id)
            if draft.get("status") not in ("queued", "generating"):
                return draft
            delay = max(interval_s, float(draft.get("retry_after_seconds") or 0))
            await asyncio.sleep(delay)
        raise PostwaveTimeoutError(
            f"campaign_templates.wait_for_design({design_id}): "
            f"timed out after {timeout_s}s"
        )

    async def create_campaign(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST", "/api/v1/campaigns/from-template", body=payload
        )
