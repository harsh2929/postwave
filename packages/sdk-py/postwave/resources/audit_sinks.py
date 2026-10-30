from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q


class AuditSinksResource(SyncResource):
    def list(self) -> Any:
        return self._client.request("GET", "/api/v1/audit-sinks")

    def create(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/audit-sinks", body=payload)

    def patch(self, sink_id: str, patch: dict[str, Any]) -> Any:
        return self._client.request("PATCH", f"/api/v1/audit-sinks/{q(sink_id)}", body=patch)

    def delete(self, sink_id: str) -> Any:
        return self._client.request("DELETE", f"/api/v1/audit-sinks/{q(sink_id)}")

    def test(self, payload: dict[str, Any]) -> Any:
        return self._client.request("POST", "/api/v1/audit-sinks/test", body=payload)

    def test_existing(self, sink_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/audit-sinks/{q(sink_id)}/test")

    def dlq_list(self) -> Any:
        return self._client.request("GET", "/api/v1/audit-sinks/dlq")

    def dlq_replay(self, entry_id: int) -> Any:
        return self._client.request("POST", f"/api/v1/audit-sinks/dlq/{q(entry_id)}/replay")

    def circuit_reset(self, sink_id: str) -> Any:
        return self._client.request("POST", f"/api/v1/audit-sinks/{q(sink_id)}/circuit/reset")


class AsyncAuditSinksResource(AsyncResource):
    async def list(self) -> Any:
        return await self._client.request("GET", "/api/v1/audit-sinks")

    async def create(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/audit-sinks", body=payload)

    async def patch(self, sink_id: str, patch: dict[str, Any]) -> Any:
        return await self._client.request("PATCH", f"/api/v1/audit-sinks/{q(sink_id)}", body=patch)

    async def delete(self, sink_id: str) -> Any:
        return await self._client.request("DELETE", f"/api/v1/audit-sinks/{q(sink_id)}")

    async def test(self, payload: dict[str, Any]) -> Any:
        return await self._client.request("POST", "/api/v1/audit-sinks/test", body=payload)

    async def test_existing(self, sink_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/audit-sinks/{q(sink_id)}/test")

    async def dlq_list(self) -> Any:
        return await self._client.request("GET", "/api/v1/audit-sinks/dlq")

    async def dlq_replay(self, entry_id: int) -> Any:
        return await self._client.request("POST", f"/api/v1/audit-sinks/dlq/{q(entry_id)}/replay")

    async def circuit_reset(self, sink_id: str) -> Any:
        return await self._client.request("POST", f"/api/v1/audit-sinks/{q(sink_id)}/circuit/reset")
