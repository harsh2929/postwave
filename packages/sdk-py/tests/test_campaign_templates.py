"""Request-contract tests for the visual campaign-template resource."""

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


def _request_record(req: httpx.Request) -> dict[str, object]:
    return {
        "method": req.method,
        "path": req.url.raw_path.decode().split("?", 1)[0],
        "params": dict(req.url.params),
        "body": json.loads(req.content.decode()) if req.content else None,
        "if_match": req.headers.get("If-Match"),
        "idempotency_key": req.headers.get("Idempotency-Key"),
    }


def test_visual_templates_are_separate_and_search_serializes_filters():
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(_request_record(req))
        return httpx.Response(
            200,
            json={"items": [], "total": 0, "page": 2, "per_page": 25},
        )

    pw = _client(handler)
    filters = {
        "q": "editorial ai",
        "goal": "newsletter",
        "source": "reallygoodemails",
        "tags": ["weekly", "data"],
        "cursor": "eyJ2IjoxLCJwIjoyfQ",
        "per_page": 25,
    }

    result = pw.campaign_templates.search(filters)

    assert pw.campaign_templates is not pw.templates
    assert seen["method"] == "GET"
    assert seen["path"] == "/api/v1/campaign-templates/search"
    assert seen["params"] == {
        "q": "editorial ai",
        "goal": "newsletter",
        "source": "reallygoodemails",
        "tags": "weekly,data",
        "cursor": "eyJ2IjoxLCJwIjoyfQ",
        "per_page": "25",
    }
    assert filters["tags"] == ["weekly", "data"]
    assert result["page"] == 2


def test_sync_design_recovery_list_is_bounded_and_cursor_preserving():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(_request_record(req))
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "design_1",
                        "mode": "generate",
                        "status": "ready",
                        "current_revision": 2,
                        "attempt_count": 1,
                        "capabilities": {
                            "can_refine": True,
                            "can_retry": False,
                            "can_save": True,
                            "can_create_campaign": True,
                            "can_archive": True,
                        },
                        "recommended_action": (
                            "review_campaign_template_design"
                        ),
                        "expires_at": "2026-08-06T00:00:00Z",
                        "created_at": "2026-07-30T00:00:00Z",
                        "updated_at": "2026-07-30T00:01:00Z",
                    }
                ],
                "next_cursor": "actor-bound-next",
            },
        )

    pw = _client(handler)
    page = pw.campaign_templates.list_designs(
        limit=50, cursor="actor-bound-current"
    )

    assert seen[0]["method"] == "GET"
    assert seen[0]["path"] == "/api/v1/campaign-template-designs"
    assert seen[0]["params"] == {
        "limit": "50",
        "cursor": "actor-bound-current",
    }
    assert page["items"][0]["recommended_action"] == (
        "review_campaign_template_design"
    )
    assert page["next_cursor"] == "actor-bound-next"

    for invalid_limit in (0, 51, 1.5, True):
        with pytest.raises(ValueError, match="integer between 1 and 50"):
            pw.campaign_templates.list_designs(limit=invalid_limit)  # type: ignore[arg-type]
    for invalid_cursor in (
        " actor-bound-current",
        "actor-bound-current ",
        "😀" * 257,
        "x" * 1025,
    ):
        with pytest.raises(ValueError, match="at most 1024 UTF-8 bytes"):
            pw.campaign_templates.list_designs(cursor=invalid_cursor)

    pw.campaign_templates.list_designs(limit=1, cursor="x" * 1024)
    assert len(seen) == 2


def test_sync_lifecycle_uses_strong_etags_and_durable_design_routes():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(_request_record(req))
        return httpx.Response(200, json={"ok": True, "status": "ready"})

    pw = _client(handler)
    etag = '"campaign-template:tpl/a b:v2"'

    pw.campaign_templates.update(
        "tpl/a b", {"subject": "Next week"}, if_match=etag
    )
    pw.campaign_templates.archive("tpl/a b", if_match=etag)
    pw.campaign_templates.restore("tpl/a b", if_match=etag)
    pw.campaign_templates.delete("tpl/a b", if_match=etag)
    pw.campaign_templates.list_revisions(
        "tpl/a b", {"page": 2, "per_page": 25}
    )
    pw.campaign_templates.get_revision("tpl/a b", 3)
    pw.campaign_templates.adapt(
        "tpl/a b",
        {"instructions": "Use our blue brand"},
        idempotency_key="adapt-blue-v1",
    )
    pw.campaign_templates.generate(
        {"brief": "A concise AI digest"},
        idempotency_key="generate-ai-v1",
    )
    pw.campaign_templates.refine_design(
        "design/1",
        {"instructions": "Tighter cards", "base_revision": 1},
        idempotency_key="refine-design-1-v1",
    )
    pw.campaign_templates.retry_design(
        "design/1", idempotency_key="retry-design-1-v1"
    )
    pw.campaign_templates.save_design(
        "design/1",
        {"revision": 2, "output_hash": "a" * 64, "slug": "ai-weekly"},
        idempotency_key="save-design-1-v2",
    )
    pw.campaign_templates.create_campaign_from_design(
        "design/1",
        {"revision": 2, "output_hash": "a" * 64},
        idempotency_key="campaign-design-1-v2",
    )
    pw.campaign_templates.archive_design(
        "design/1", idempotency_key="archive-design-1"
    )

    assert [row["path"] for row in seen[:6]] == [
        "/api/v1/campaign-templates/tpl%2Fa%20b",
        "/api/v1/campaign-templates/tpl%2Fa%20b/archive",
        "/api/v1/campaign-templates/tpl%2Fa%20b/restore",
        "/api/v1/campaign-templates/tpl%2Fa%20b",
        "/api/v1/campaign-templates/tpl%2Fa%20b/revisions",
        "/api/v1/campaign-templates/tpl%2Fa%20b/revisions/3",
    ]
    assert all(row["if_match"] == etag for row in seen[:4])
    assert seen[6]["path"] == "/api/v1/campaign-template-designs"
    assert seen[6]["body"] == {
        "instructions": "Use our blue brand",
        "mode": "adapt",
        "source_template_id": "tpl/a b",
    }
    assert seen[6]["idempotency_key"] == "adapt-blue-v1"
    assert seen[7]["path"] == "/api/v1/campaign-template-designs"
    assert seen[7]["body"] == {
        "brief": "A concise AI digest",
        "mode": "generate",
    }
    assert seen[7]["idempotency_key"] == "generate-ai-v1"
    assert [row["path"] for row in seen[8:]] == [
        "/api/v1/campaign-template-designs/design%2F1/refine",
        "/api/v1/campaign-template-designs/design%2F1/retry",
        "/api/v1/campaign-template-designs/design%2F1/save",
        "/api/v1/campaign-template-designs/design%2F1/create-campaign",
        "/api/v1/campaign-template-designs/design%2F1/archive",
    ]
    assert [row["idempotency_key"] for row in seen[8:]] == [
        "refine-design-1-v1",
        "retry-design-1-v1",
        "save-design-1-v2",
        "campaign-design-1-v2",
        "archive-design-1",
    ]


def test_sync_personal_discovery_preserves_idempotency_and_etags():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(_request_record(req))
        return httpx.Response(200, json={"ok": True, "items": []})

    pw = _client(handler)
    collection_etag = '"campaign-template-collection:collection_1:v3"'
    saved_etag = '"campaign-template-saved-search:search_1:v2"'

    pw.campaign_templates.compare(["tpl_1", "weekly"])
    pw.campaign_templates.favorite("tpl_1")
    pw.campaign_templates.unfavorite("tpl_1")
    pw.campaign_templates.record_view("tpl_1")
    pw.campaign_templates.recent(limit=20)
    pw.campaign_templates.clear_recent("tpl_1")
    pw.campaign_templates.create_collection(
        {"name": "Editorial", "template_ids": ["tpl_1"]},
        idempotency_key="collection-create-v1",
    )
    pw.campaign_templates.update_collection(
        "collection_1", {"name": "Editorial picks"}, if_match=collection_etag
    )
    pw.campaign_templates.replace_collection_items(
        "collection_1", ["tpl_2", "tpl_1"], if_match=collection_etag
    )
    pw.campaign_templates.delete_collection(
        "collection_1", if_match=collection_etag
    )
    pw.campaign_templates.create_saved_search(
        {"name": "Favorites", "filters": {"favorited": True}},
        idempotency_key="saved-search-create-v1",
    )
    pw.campaign_templates.update_saved_search(
        "search_1", {"name": "Best favorites"}, if_match=saved_etag
    )
    pw.campaign_templates.saved_search_results(
        "search_1", {"cursor": "opaque", "per_page": 50}
    )
    pw.campaign_templates.delete_saved_search("search_1", if_match=saved_etag)

    assert seen[0]["params"] == {"templates": "tpl_1,weekly"}
    assert [row["path"] for row in seen[1:6]] == [
        "/api/v1/campaign-templates/tpl_1/favorite",
        "/api/v1/campaign-templates/tpl_1/unfavorite",
        "/api/v1/campaign-templates/tpl_1/view",
        "/api/v1/campaign-templates/recent",
        "/api/v1/campaign-templates/recent/tpl_1",
    ]
    assert seen[6]["idempotency_key"] == "collection-create-v1"
    assert all(row["if_match"] == collection_etag for row in seen[7:10])
    assert seen[10]["idempotency_key"] == "saved-search-create-v1"
    assert seen[11]["if_match"] == saved_etag
    assert seen[12]["params"] == {"cursor": "opaque", "per_page": "50"}
    assert seen[13]["if_match"] == saved_etag


def test_campaign_template_header_inputs_fail_closed():
    pw = _client(lambda _req: httpx.Response(200, json={}))

    with pytest.raises(ValueError, match="exact strong etag"):
        pw.campaign_templates.update("tpl_1", {"subject": "x"}, if_match="*")
    with pytest.raises(ValueError, match="exact current"):
        pw.campaign_templates.delete_collection(
            "collection_1",
            if_match='"campaign-template-saved-search:collection_1:v1"',
        )
    with pytest.raises(ValueError, match="1-255"):
        pw.campaign_templates.generate(
            {"brief": "x"}, idempotency_key="bad\nkey"
        )
    with pytest.raises(ValueError, match="positive integer"):
        pw.campaign_templates.get_revision("tpl_1", 0)


@pytest.mark.asyncio
async def test_async_surface_uses_same_durable_routes_and_headers():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(_request_record(req))
        return httpx.Response(200, json={"ok": True, "status": "ready"})

    pw = _async_client(handler)
    etag = '"campaign-template:tpl_1:v4"'
    await pw.campaign_templates.update(
        "tpl_1", {"subject": "Async"}, if_match=etag
    )
    await pw.campaign_templates.generate(
        {"brief": "Founder digest"}, idempotency_key="async-generate-v1"
    )
    await pw.campaign_templates.create_collection(
        {"name": "Async picks"}, idempotency_key="async-collection-v1"
    )
    await pw.campaign_templates.list_design_revisions("design_1")

    assert seen[0]["if_match"] == etag
    assert seen[1]["path"] == "/api/v1/campaign-template-designs"
    assert seen[1]["idempotency_key"] == "async-generate-v1"
    assert seen[2]["path"] == "/api/v1/campaign-template-collections"
    assert seen[2]["idempotency_key"] == "async-collection-v1"
    assert (
        seen[3]["path"]
        == "/api/v1/campaign-template-designs/design_1/revisions"
    )
    await pw.aclose()


@pytest.mark.asyncio
async def test_async_design_recovery_list_uses_identical_bounds_and_route():
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(_request_record(req))
        return httpx.Response(200, json={"items": []})

    pw = _async_client(handler)
    page = await pw.campaign_templates.list_designs(
        limit=20, cursor="actor-bound-current"
    )

    assert page == {"items": []}
    assert seen[0]["path"] == "/api/v1/campaign-template-designs"
    assert seen[0]["params"] == {
        "limit": "20",
        "cursor": "actor-bound-current",
    }
    with pytest.raises(ValueError, match="integer between 1 and 50"):
        await pw.campaign_templates.list_designs(limit=0)
    with pytest.raises(ValueError, match="at most 1024 UTF-8 bytes"):
        await pw.campaign_templates.list_designs(cursor="x" * 1025)
    assert len(seen) == 1
    await pw.aclose()
