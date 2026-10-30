from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class ReferralsResource(SyncResource):
    def create_program(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/referral-programs", body=payload)

    def current_program(self) -> Any:
        return self._client.request("GET", "/api/v1/referral-programs/current")

    def subscriber_referral(self, subscriber_id: str) -> Any:
        return self._client.request("GET", f"/api/v1/subscribers/{q(subscriber_id)}/referral")


class AsyncReferralsResource(AsyncResource):
    async def create_program(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/referral-programs", body=payload)

    async def current_program(self) -> Any:
        return await self._client.request("GET", "/api/v1/referral-programs/current")

    async def subscriber_referral(self, subscriber_id: str) -> Any:
        return await self._client.request("GET", f"/api/v1/subscribers/{q(subscriber_id)}/referral")
