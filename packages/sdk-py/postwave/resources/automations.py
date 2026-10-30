from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.automations import AutomationExecution, AutomationTriggerInput


class AutomationsResource(SyncResource):
    def trigger(self, payload: AutomationTriggerInput | dict) -> dict[str, str]:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, AutomationTriggerInput) else payload
        return self._client.request("POST", "/api/v1/automations/trigger", body=body)

    def list_executions(self, automation_id: str) -> list[AutomationExecution]:
        r = self._client.request("GET", f"/api/v1/automations/{q(automation_id)}/executions")
        return [AutomationExecution.model_validate(p) for p in (r or {}).get("executions", [])]

    def pause(self, automation_id: str) -> dict[str, str]:
        return self._client.request("POST", f"/api/v1/automations/{q(automation_id)}/pause")

    def resume(self, automation_id: str) -> dict[str, str]:
        return self._client.request("POST", f"/api/v1/automations/{q(automation_id)}/resume")


class AsyncAutomationsResource(AsyncResource):
    async def trigger(self, payload: AutomationTriggerInput | dict) -> dict[str, str]:
        body = payload.model_dump(exclude_none=True) if isinstance(payload, AutomationTriggerInput) else payload
        return await self._client.request("POST", "/api/v1/automations/trigger", body=body)

    async def list_executions(self, automation_id: str) -> list[AutomationExecution]:
        r = await self._client.request("GET", f"/api/v1/automations/{q(automation_id)}/executions")
        return [AutomationExecution.model_validate(p) for p in (r or {}).get("executions", [])]

    async def pause(self, automation_id: str) -> dict[str, str]:
        return await self._client.request("POST", f"/api/v1/automations/{q(automation_id)}/pause")

    async def resume(self, automation_id: str) -> dict[str, str]:
        return await self._client.request("POST", f"/api/v1/automations/{q(automation_id)}/resume")
