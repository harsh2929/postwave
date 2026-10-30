from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class CampaignsABResource(SyncResource):
    def list_variants(self, campaign_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/campaigns/{q(campaign_id)}/variants")

    def create_variant(self, campaign_id: str, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/variants", body=payload)

    def create_test(self, campaign_id: str, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/ab", body=payload)

    def update_settings(self, campaign_id: str, patch: dict[str, Any]) -> Any:
        return self._client.request("PATCH", f"/api/v1/campaigns/{q(campaign_id)}/ab/settings", body=patch)

    def evaluate(self, campaign_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/ab/evaluate")


class AsyncCampaignsABResource(AsyncResource):
    async def list_variants(self, campaign_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/campaigns/{q(campaign_id)}/variants")

    async def create_variant(self, campaign_id: str, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/variants", body=payload)

    async def create_test(self, campaign_id: str, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/ab", body=payload)

    async def update_settings(self, campaign_id: str, patch: dict[str, Any]) -> Any:
        return await self._client.request("PATCH", f"/api/v1/campaigns/{q(campaign_id)}/ab/settings", body=patch)

    async def evaluate(self, campaign_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/campaigns/{q(campaign_id)}/ab/evaluate")
