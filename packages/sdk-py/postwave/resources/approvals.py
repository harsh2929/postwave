from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class ApprovalsResource(SyncResource):
    def list(self, **query: Any) -> Any:
        return self._client.request("GET", "/api/v1/approvals", query=query or None)

    def decide(self, approval_id: str, decision: str, **fields: Any) -> Any:
        return self._client.request(
            "POST",
            f"/api/v1/approvals/{q(approval_id)}/decision",
            body={"decision": decision, **fields},
        )


class AsyncApprovalsResource(AsyncResource):
    async def list(self, **query: Any) -> Any:
        return await self._client.request("GET", "/api/v1/approvals", query=query or None)

    async def decide(self, approval_id: str, decision: str, **fields: Any) -> Any:
        return await self._client.request(
            "POST",
            f"/api/v1/approvals/{q(approval_id)}/decision",
            body={"decision": decision, **fields},
        )
