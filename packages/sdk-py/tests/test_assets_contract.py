"""Public Assets SDK request-shape contract for sync and async clients."""

from __future__ import annotations

import json
import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


def test_sync_asset_lifecycle_uses_exact_routes_and_fields() -> None:
    seen: list[tuple[str, str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), req.read()))
        if req.url.path.endswith("/usage"):
            return httpx.Response(200, json={"usage": []})
        if req.method == "DELETE":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, json={"asset": {"id": "asset-1"}, "usage": []})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    pw = Moosewave(api_key="test", http_client=http, retries=0, base_url="http://localhost:8080")

    pw.assets.get("asset/1")
    pw.assets.update("asset/1", "Logo")
    pw.assets.usage("asset/1")
    pw.assets.delete("asset/1", force=True)

    assert seen[0][0:2] == ("GET", "http://localhost:8080/api/v1/assets/asset%2F1")
    assert seen[1][0] == "PATCH"
    assert json.loads(seen[1][2]) == {"alt_text": "Logo"}
    assert seen[2][1].endswith("/api/v1/assets/asset%2F1/usage")
    assert seen[3][0] == "DELETE"
    assert seen[3][1].endswith("/api/v1/assets/asset%2F1?force=true")
    pw.close()


@pytest.mark.asyncio
async def test_async_asset_delete_preserves_reference_override() -> None:
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        return httpx.Response(200, json={"ok": True})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    pw = AsyncPostwave(api_key="test", http_client=http, retries=0, base_url="http://localhost:8080")
    await pw.assets.delete("asset-1", force=True)
    assert seen == ["http://localhost:8080/api/v1/assets/asset-1?force=true"]
    await pw.aclose()
