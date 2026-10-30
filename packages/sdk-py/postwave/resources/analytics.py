"""analytics.py — campaign reports + tenant dashboard rollups."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class AnalyticsResource(SyncResource):
    def campaign_report(self, campaign_id: str) -> dict[str, Any]:
        """Per-campaign aggregate report."""
        return self._client.request("GET", f"/api/v1/campaigns/{quote(campaign_id, safe='')}/report")

    def dashboard_stats(self) -> dict[str, Any]:
        """Tenant-level rollups (30-day windows + total subscribers)."""
        return self._client.request("GET", "/api/v1/dashboard/stats")

    def engagement_classification_summary(
        self,
        *,
        campaign_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        """Event-level human/machine/unknown summary with exact provenance."""
        return self._client.request(
            "GET",
            "/api/v1/analytics/engagement-classification/summary",
            query={"campaign_id": campaign_id, "since": since, "until": until},
        )

    def human_engaged_reach(
        self,
        *,
        campaign_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        """Recipient-level human-engaged reach floor plus unknown-only band."""
        return self._client.request(
            "GET",
            "/api/v1/analytics/human-engaged-reach",
            query={"campaign_id": campaign_id, "since": since, "until": until},
        )

    def export_human_engaged_reach_evidence(
        self,
        *,
        campaign_id: str,
        since: str,
        until: str,
    ) -> dict[str, Any]:
        """Fixed-window evidence artifact with embedded SHA-256 metadata."""
        return self._client.request(
            "GET",
            "/api/v1/analytics/human-engaged-reach/export",
            query={"campaign_id": campaign_id, "since": since, "until": until},
            headers={
                "Accept": "application/vnd.postwave.human-engaged-reach-evidence+json"
            },
        )


class AsyncAnalyticsResource(AsyncResource):
    async def campaign_report(self, campaign_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/campaigns/{quote(campaign_id, safe='')}/report")

    async def dashboard_stats(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/dashboard/stats")

    async def engagement_classification_summary(
        self,
        *,
        campaign_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/analytics/engagement-classification/summary",
            query={"campaign_id": campaign_id, "since": since, "until": until},
        )

    async def human_engaged_reach(
        self,
        *,
        campaign_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/analytics/human-engaged-reach",
            query={"campaign_id": campaign_id, "since": since, "until": until},
        )

    async def export_human_engaged_reach_evidence(
        self,
        *,
        campaign_id: str,
        since: str,
        until: str,
    ) -> dict[str, Any]:
        """Fixed-window evidence artifact with embedded SHA-256 metadata."""
        return await self._client.request(
            "GET",
            "/api/v1/analytics/human-engaged-reach/export",
            query={"campaign_id": campaign_id, "since": since, "until": until},
            headers={
                "Accept": "application/vnd.postwave.human-engaged-reach-evidence+json"
            },
        )
