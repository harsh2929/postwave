from __future__ import annotations

import json

import httpx
import pytest
from pydantic import ValidationError

from postwave import AsyncPostwave, Moosewave


CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111"
REVISION_ID = "22222222-2222-4222-8222-222222222222"


def _definition() -> dict:
    return {
        "id": "33333333-3333-4333-8333-333333333333",
        "campaign_id": CAMPAIGN_ID,
        "poll_key": "venue:primary",
        "question": "Which venue?",
        "two_step_required": False,
        "options": [
            {"option_key": "north", "label": "North hall", "position": 0},
            {"option_key": "south", "label": "South hall", "position": 1},
        ],
        "created_at": "2026-08-13T00:00:00Z",
    }


def _tally() -> dict:
    definition = _definition()
    return {
        "poll_id": definition["id"],
        "poll_key": definition["poll_key"],
        "question": definition["question"],
        "options": [
            {"option_key": "north", "label": "North hall", "counted": 2},
            {"option_key": "south", "label": "South hall", "counted": 1},
        ],
        "machine_excluded": 4,
        "unclassified_excluded": 9,
        "voided_multi_option": 3,
        "previewed_only": 12,
    }


def _response(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/tally"):
        return httpx.Response(200, json=_tally())
    if request.method == "GET":
        return httpx.Response(
            200, json={"items": [_definition()], "next_cursor": "pwcp1.next"}
        )
    return httpx.Response(201, json=_definition())


def test_sync_campaign_poll_routes_auth_ast_only_body_and_exclusions() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = Moosewave(
        api_key="pw_campaign_polls",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )

    created = client.campaign_polls.materialize(
        CAMPAIGN_ID,
        {
            "content_revision_id": REVISION_ID,
            "poll_key": "venue:primary",
            "two_step_required": False,
            "closes_at": "2026-09-01T12:00:00Z",
        },
    )
    listed = client.campaign_polls.list(
        CAMPAIGN_ID, limit=25, cursor="pwcp1.a2lk.payload.signature"
    )
    tally = client.campaign_polls.tally(CAMPAIGN_ID, "venue:primary")

    base = f"/api/v1/campaigns/{CAMPAIGN_ID}/polls"
    assert [(request.method, request.url.path) for request in seen] == [
        ("POST", base),
        ("GET", base),
        ("GET", f"{base}/venue:primary/tally"),
    ]
    assert all(
        request.headers["Authorization"] == "Bearer pw_campaign_polls"
        for request in seen
    )
    assert json.loads(seen[0].content) == {
        "content_revision_id": REVISION_ID,
        "poll_key": "venue:primary",
        "two_step_required": False,
        "closes_at": "2026-09-01T12:00:00Z",
    }
    assert created.question == "Which venue?"
    assert len(listed.items) == 1
    assert listed.next_cursor == "pwcp1.next"
    assert dict(seen[1].url.params) == {
        "limit": "25",
        "cursor": "pwcp1.a2lk.payload.signature",
    }
    assert tally.unclassified_excluded == 9
    assert sum(option.counted for option in tally.options) == 3
    assert "tenant_id" not in tally.model_fields_set


@pytest.mark.asyncio
async def test_async_campaign_poll_routes() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = AsyncPostwave(
        api_key="pw_campaign_polls",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )

    await client.campaign_polls.materialize(
        CAMPAIGN_ID,
        {"content_revision_id": REVISION_ID, "poll_key": "venue:primary"},
    )
    await client.campaign_polls.list(CAMPAIGN_ID)
    tally = await client.campaign_polls.tally(CAMPAIGN_ID, "venue:primary")

    assert len(seen) == 3
    assert tally.unclassified_excluded == 9
    await http.aclose()


def test_campaign_poll_materialization_rejects_duplicate_meaning_before_transport() -> None:
    requests = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(500)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_campaign_polls", http_client=http, retries=0)

    with pytest.raises(ValidationError, match="extra_forbidden"):
        client.campaign_polls.materialize(
            CAMPAIGN_ID,
            {
                "content_revision_id": REVISION_ID,
                "poll_key": "venue",
                "question": "Caller-authored question",
                "options": [{"option_key": "forged", "label": "Forged"}],
            },
        )
    assert requests == 0


def test_campaign_poll_list_rejects_invalid_bounds_before_transport() -> None:
    requests = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(500)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_campaign_polls", http_client=http, retries=0)

    with pytest.raises(ValueError, match="integer from 1 to 100"):
        client.campaign_polls.list(CAMPAIGN_ID, limit=101)
    with pytest.raises(ValueError, match="opaque ASCII cursor"):
        client.campaign_polls.list(CAMPAIGN_ID, cursor="not a cursor")
    assert requests == 0
