"""Optimistic-concurrency request contract for async sequence mutations."""

from __future__ import annotations

import httpx
import pytest

from postwave import AsyncPostwave


@pytest.mark.asyncio
async def test_async_sequence_mutations_send_canonical_strong_etags() -> None:
    seen: list[tuple[str, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.headers.get("if-match")))
        if req.method == "PATCH":
            return httpx.Response(
                200,
                json={
                    "id": "seq_1",
                    "tenant_id": "acme",
                    "template_id": "",
                    "name": "After",
                    "status": "draft",
                    "version": 12,
                    "emails": [],
                },
            )
        return httpx.Response(204)

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="http://localhost:8080",
    )
    pw = AsyncPostwave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )

    updated = await pw.sequences.update(
        "seq_1", {"name": "After"}, expected_version=11
    )
    assert updated.version == 12
    assert await pw.sequences.delete("seq_1", expected_version=12) is None
    assert seen == [("PATCH", '"11"'), ("DELETE", '"12"')]
    await pw.aclose()
