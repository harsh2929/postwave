from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.deliverability import (
    CampaignReport, Diagnosis, PredictInput, PredictResponse, RenderInput, RenderResponse,
)


class InboxRealityResource(SyncResource):
    def get_campaign_report(self, campaign_id: str) -> CampaignReport:
        return CampaignReport.model_validate(self._client.request("GET", f"/api/v1/inbox-reality/campaigns/{q(campaign_id)}"))

    def predict(self, payload: PredictInput | dict) -> PredictResponse:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, PredictInput) else payload
        return PredictResponse.model_validate(self._client.request("POST", "/api/v1/predict", body=body))

    def diagnose(self, campaign_id: str, signals: dict[str, Any] | None = None) -> Diagnosis:
        return Diagnosis.model_validate(self._client.request("POST", f"/api/v1/diagnose/{q(campaign_id)}", body=signals or {}))

    def render(self, payload: RenderInput | dict) -> RenderResponse:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, RenderInput) else payload
        return RenderResponse.model_validate(self._client.request("POST", "/api/v1/render", body=body))


class AsyncInboxRealityResource(AsyncResource):
    async def get_campaign_report(self, campaign_id: str) -> CampaignReport:
        return CampaignReport.model_validate(await self._client.request("GET", f"/api/v1/inbox-reality/campaigns/{q(campaign_id)}"))

    async def predict(self, payload: PredictInput | dict) -> PredictResponse:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, PredictInput) else payload
        return PredictResponse.model_validate(await self._client.request("POST", "/api/v1/predict", body=body))

    async def diagnose(self, campaign_id: str, signals: dict[str, Any] | None = None) -> Diagnosis:
        return Diagnosis.model_validate(await self._client.request("POST", f"/api/v1/diagnose/{q(campaign_id)}", body=signals or {}))

    async def render(self, payload: RenderInput | dict) -> RenderResponse:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, RenderInput) else payload
        return RenderResponse.model_validate(await self._client.request("POST", "/api/v1/render", body=body))
