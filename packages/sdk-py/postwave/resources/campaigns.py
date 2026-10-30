from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..types.direct_attribution import CampaignDirectAttributionEvidencePage
from ._base import AsyncResource, SyncResource


def _sandbox_headers(sandbox: bool) -> dict[str, str] | None:
    return {"X-Postwave-Sandbox": "true"} if sandbox else None


def _direct_attribution_query(limit: int, offset: int) -> dict[str, int]:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError(
            "campaign direct-attribution evidence limit must be an integer from 1 to 100"
        )
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or not 0 <= offset <= 10_000
    ):
        raise ValueError(
            "campaign direct-attribution evidence offset must be an integer from 0 to 10000"
        )
    return {"limit": limit, "offset": offset}


def _direct_attribution_path(campaign_id: str) -> str:
    if not isinstance(campaign_id, str) or not campaign_id.strip():
        raise ValueError("campaign direct-attribution evidence campaign ID is required")
    return (
        f"/api/v1/campaigns/{quote(campaign_id, safe='')}"
        "/direct-attribution-evidence"
    )


class CampaignsResource(SyncResource):
    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", "/api/v1/campaigns")

    def get(self, campaign_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/campaigns/{quote(campaign_id, safe='')}")

    def list_direct_attribution_evidence(
        self,
        campaign_id: str,
        *,
        limit: int = 25,
        offset: int = 0,
    ) -> CampaignDirectAttributionEvidencePage:
        """Return exactly one bounded, read-only campaign evidence page."""
        value = self._client.request(
            "GET",
            _direct_attribution_path(campaign_id),
            query=_direct_attribution_query(limit, offset),
        )
        return CampaignDirectAttributionEvidencePage.model_validate(value)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/campaigns", body=payload)

    def update(self, campaign_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}",
            body=patch,
        )

    def delete(self, campaign_id: str) -> None:
        self._client.request("DELETE", f"/api/v1/campaigns/{quote(campaign_id, safe='')}")

    def queue(self, campaign_id: str, *, sandbox: bool = False) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/queue",
            headers=_sandbox_headers(sandbox),
        )

    def send(self, campaign_id: str, *, sandbox: bool = False) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/send",
            headers=_sandbox_headers(sandbox),
        )

    def pause(self, campaign_id: str) -> dict[str, Any]:
        """Pause a ``sending`` or ``scheduled`` campaign.

        Returns the updated campaign. The server rejects (409) campaigns that
        are not in a pausable state.
        """
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/pause",
        )

    def resume(self, campaign_id: str) -> dict[str, Any]:
        """Resume a ``paused`` campaign, returning it to ``sending``.

        Returns 423 (Locked) when the tenant's email kill switch is engaged.
        """
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/resume",
        )

    def cancel(self, campaign_id: str) -> dict[str, Any]:
        """Cancel a ``draft``, ``scheduled``, ``sending``, or ``paused`` campaign.

        Transitions it to ``cancelled`` and returns the updated campaign.
        """
        return self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/cancel",
        )

    def send_test(
        self,
        *,
        to_email: str,
        campaign_id: str | None = None,
        subject: str | None = None,
        body_html: str | None = None,
        body_mjml: str | None = None,
    ) -> dict[str, Any]:
        if not campaign_id and not body_html:
            raise ValueError("send_test requires campaign_id or body_html")
        path = (
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/test-send"
            if campaign_id
            else "/api/v1/campaigns/test-send"
        )
        return self._client.request(
            "POST",
            path,
            body={
                "to_email": to_email,
                "subject": subject,
                "body_html": body_html,
                "body_mjml": body_mjml,
            },
        )


class AsyncCampaignsResource(AsyncResource):
    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", "/api/v1/campaigns")

    async def get(self, campaign_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/campaigns/{quote(campaign_id, safe='')}")

    async def list_direct_attribution_evidence(
        self,
        campaign_id: str,
        *,
        limit: int = 25,
        offset: int = 0,
    ) -> CampaignDirectAttributionEvidencePage:
        """Return exactly one bounded, read-only campaign evidence page."""
        value = await self._client.request(
            "GET",
            _direct_attribution_path(campaign_id),
            query=_direct_attribution_query(limit, offset),
        )
        return CampaignDirectAttributionEvidencePage.model_validate(value)

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/campaigns", body=payload)

    async def update(self, campaign_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}",
            body=patch,
        )

    async def delete(self, campaign_id: str) -> None:
        await self._client.request("DELETE", f"/api/v1/campaigns/{quote(campaign_id, safe='')}")

    async def queue(self, campaign_id: str, *, sandbox: bool = False) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/queue",
            headers=_sandbox_headers(sandbox),
        )

    async def send(self, campaign_id: str, *, sandbox: bool = False) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/send",
            headers=_sandbox_headers(sandbox),
        )

    async def pause(self, campaign_id: str) -> dict[str, Any]:
        """Pause a ``sending`` or ``scheduled`` campaign.

        Returns the updated campaign. The server rejects (409) campaigns that
        are not in a pausable state.
        """
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/pause",
        )

    async def resume(self, campaign_id: str) -> dict[str, Any]:
        """Resume a ``paused`` campaign, returning it to ``sending``.

        Returns 423 (Locked) when the tenant's email kill switch is engaged.
        """
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/resume",
        )

    async def cancel(self, campaign_id: str) -> dict[str, Any]:
        """Cancel a ``draft``, ``scheduled``, ``sending``, or ``paused`` campaign.

        Transitions it to ``cancelled`` and returns the updated campaign.
        """
        return await self._client.request(
            "POST",
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/cancel",
        )

    async def send_test(
        self,
        *,
        to_email: str,
        campaign_id: str | None = None,
        subject: str | None = None,
        body_html: str | None = None,
        body_mjml: str | None = None,
    ) -> dict[str, Any]:
        if not campaign_id and not body_html:
            raise ValueError("send_test requires campaign_id or body_html")
        path = (
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}/test-send"
            if campaign_id
            else "/api/v1/campaigns/test-send"
        )
        return await self._client.request(
            "POST",
            path,
            body={
                "to_email": to_email,
                "subject": subject,
                "body_html": body_html,
                "body_mjml": body_mjml,
            },
        )
