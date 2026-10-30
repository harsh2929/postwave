"""Request-shape tests for the canonical Tags SDK contract."""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


def _client(handler) -> Moosewave:
    http = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="http://localhost:8080",
    )
    return Moosewave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def _async_client(handler) -> AsyncPostwave:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="http://localhost:8080",
    )
    return AsyncPostwave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def test_tags_shape_filters_full_create_and_conditional_update():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "method": req.method,
                "url": str(req.url),
                "body": json.loads(req.content.decode()) if req.content else None,
                "if_match": req.headers.get("if-match"),
            }
        )
        return httpx.Response(200, json={"id": "tag/1", "etag": '"tag-7"'})

    pw = _client(handler)
    pw.tags.list(query="vip customer", group_id="group/1", include_archived=True)
    pw.tags.create(
        "VIP",
        color="#112233",
        description="High-value customers",
        group_id="group_1",
        pii=True,
    )
    pw.tags.update(
        "tag/1",
        {"color": "", "group_id": "", "pii": False},
        etag='"tag-7"',
    )

    assert seen == [
        {
            "method": "GET",
            "url": "http://localhost:8080/api/v1/tags?query=vip%20customer&group_id=group%2F1&include_archived=true",
            "body": None,
            "if_match": None,
        },
        {
            "method": "POST",
            "url": "http://localhost:8080/api/v1/tags",
            "body": {
                "name": "VIP",
                "pii": True,
                "color": "#112233",
                "description": "High-value customers",
                "group_id": "group_1",
            },
            "if_match": None,
        },
        {
            "method": "PATCH",
            "url": "http://localhost:8080/api/v1/tags/tag%2F1",
            "body": {"color": "", "group_id": "", "pii": False},
            "if_match": '"tag-7"',
        },
    ]


def test_tags_update_requires_etag_before_request():
    pw = _client(lambda _req: pytest.fail("request should not be sent"))

    with pytest.raises(TypeError, match="etag"):
        pw.tags.update("tag_1", {"name": "VIP"})  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_async_tags_preserve_conditional_write_contract():
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(
            method=req.method,
            url=str(req.url),
            body=json.loads(req.content.decode()),
            if_match=req.headers.get("if-match"),
        )
        return httpx.Response(200, json={"id": "tag_1", "etag": '"tag-8"'})

    pw = _async_client(handler)
    await pw.tags.update("tag_1", {"name": "Priority"}, etag='"tag-7"')

    assert seen == {
        "method": "PATCH",
        "url": "http://localhost:8080/api/v1/tags/tag_1",
        "body": {"name": "Priority"},
        "if_match": '"tag-7"',
    }
    await pw.aclose()
