from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ..types.sending import SendingState, WarmupState


class SendingResource(SyncResource):
    def get_state(self) -> SendingState:
        return SendingState.model_validate(self._client.request("GET", "/api/v1/sending/state"))

    def get_warmup(self) -> WarmupState:
        return WarmupState.model_validate(self._client.request("GET", "/api/v1/sending/warmup"))


class AsyncSendingResource(AsyncResource):
    async def get_state(self) -> SendingState:
        return SendingState.model_validate(await self._client.request("GET", "/api/v1/sending/state"))

    async def get_warmup(self) -> WarmupState:
        return WarmupState.model_validate(await self._client.request("GET", "/api/v1/sending/warmup"))
