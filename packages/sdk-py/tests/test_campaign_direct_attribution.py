"""Focused transport and decoder coverage for F04 campaign evidence."""

from __future__ import annotations

from copy import deepcopy

import httpx
import pytest
from pydantic import ValidationError

from postwave import (
    AsyncPostwave,
    CampaignDirectAttributionEvidencePage as ExportedEvidencePage,
    Moosewave,
)
from postwave.types import CampaignDirectAttributionEvidencePage


CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111"
EVIDENCE_ID = "22222222-2222-4222-8222-222222222222"


def evidence_page() -> dict:
    return {
        "campaign_id": CAMPAIGN_ID,
        "summary": {
            "code_allocations": 6,
            "code_redemptions": 1,
            "code_linked_outcomes": 0,
            "no_click_redemptions": 0,
            "with_click_redemptions": 0,
            "click_evidence_unavailable": 1,
            "vanity_visits": 0,
            "vanity_linked_outcomes": 0,
        },
        "items": [
            {
                "kind": "code_allocation",
                "evidence_id": EVIDENCE_ID,
                "occurred_at": "2026-08-30T12:00:00Z",
                "status": "redeemed",
                "expires_at": None,
                "redeemed_at": "2026-08-30T12:05:00Z",
                "redemption_id": 41,
                "conversion_id": None,
                "amount_cents": None,
                "currency": "",
                "attributed_via": "code_redemption",
                "attribution_scope": "campaign_assignment",
                "linked_without_recorded_assignment_click": None,
                "readership_proven": False,
            }
        ],
        "page_info": {"limit": 17, "offset": 4, "total": 6, "has_more": True},
    }


def test_list_direct_attribution_is_one_encoded_read_and_preserves_null() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=evidence_page())

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(
        api_key="pw_test",
        tenant_id="tenant",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    result = client.campaigns.list_direct_attribution_evidence(
        "campaign/a b", limit=17, offset=4
    )

    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].content == b""
    assert str(requests[0].url) == (
        "http://localhost:8080/api/v1/campaigns/campaign%2Fa%20b/"
        "direct-attribution-evidence?limit=17&offset=4"
    )
    assert result.items[0].linked_without_recorded_assignment_click is None
    assert result.items[0].readership_proven is False
    assert result.model_dump() == evidence_page()
    assert ExportedEvidencePage is CampaignDirectAttributionEvidencePage


@pytest.mark.asyncio
async def test_async_list_direct_attribution_uses_same_single_get() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=evidence_page())

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncPostwave(
        api_key="pw_test",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    result = await client.campaigns.list_direct_attribution_evidence(
        CAMPAIGN_ID, limit=17, offset=4
    )
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert result.items[0].linked_without_recorded_assignment_click is None
    await http.aclose()


def test_decoder_rejects_identity_code_fields_and_readership_claims() -> None:
    identity_leak = evidence_page()
    identity_leak["items"][0]["recipient_email"] = "person@example.com"
    with pytest.raises(ValidationError, match="recipient_email"):
        CampaignDirectAttributionEvidencePage.model_validate(identity_leak)

    readership_claim = deepcopy(evidence_page())
    readership_claim["items"][0]["readership_proven"] = True
    with pytest.raises(ValidationError, match="readership_proven"):
        CampaignDirectAttributionEvidencePage.model_validate(readership_claim)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("campaign_id",), "not-a-uuid"),
        (("items", 0, "evidence_id"), "not-a-uuid"),
        (("items", 0, "status"), "   "),
        (("items", 0, "occurred_at"), "2026-08-30"),
        (("items", 0, "occurred_at"), "2026-02-30T12:00:00Z"),
        (("items", 0, "occurred_at"), "2026-08-30T12:00:00+24:00"),
        (("items", 0, "occurred_at"), "2026-08-30T24:00:00Z"),
        (("items", 0, "expires_at"), "tomorrow"),
        (("summary", "code_allocations"), 2**63),
        (("summary", "code_allocations"), -1),
        (("summary", "code_allocations"), None),
        (("items", 0, "conversion_id"), 0),
        (("items", 0, "amount_cents"), -(2**63) - 1),
        (("items", 0, "linked_without_recorded_assignment_click"), 0),
        (("items", 0, "currency"), None),
        (("items", 0, "readership_proven"), 0),
        (("items",), None),
    ],
)
def test_decoder_rejects_hostile_formats(path: tuple, value: object) -> None:
    payload = evidence_page()
    target = payload
    for segment in path[:-1]:
        target = target[segment]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        CampaignDirectAttributionEvidencePage.model_validate(payload)


def test_decoder_rejects_mismatched_provenance() -> None:
    payload = evidence_page()
    payload["items"][0]["attribution_scope"] = "campaign"
    with pytest.raises(ValidationError, match="provenance"):
        CampaignDirectAttributionEvidencePage.model_validate(payload)


def test_decoder_rejects_removed_aggregates_and_dishonest_currency() -> None:
    aggregate = evidence_page()
    aggregate["summary"]["code_revenue_cents"] = -25
    with pytest.raises(ValidationError, match="code_revenue_cents"):
        CampaignDirectAttributionEvidencePage.model_validate(aggregate)

    for currency in ("usd", "US", "USDD"):
        payload = evidence_page()
        payload["items"][0]["currency"] = currency
        with pytest.raises(ValidationError, match="currency"):
            CampaignDirectAttributionEvidencePage.model_validate(payload)

    unspecified = evidence_page()
    unspecified["items"][0]["amount_cents"] = 125
    decoded = CampaignDirectAttributionEvidencePage.model_validate(unspecified)
    assert decoded.items[0].amount_cents == 125
    assert decoded.items[0].currency == ""

    non_monetary_with_currency = evidence_page()
    non_monetary_with_currency["items"][0]["currency"] = "USD"
    decoded = CampaignDirectAttributionEvidencePage.model_validate(
        non_monetary_with_currency
    )
    assert decoded.items[0].amount_cents is None
    assert decoded.items[0].currency == "USD"


def test_decoder_requires_every_closed_field() -> None:
    payload = evidence_page()
    del payload["items"][0]["expires_at"]
    with pytest.raises(ValidationError, match="expires_at"):
        CampaignDirectAttributionEvidencePage.model_validate(payload)


def test_decoder_rejects_contradictory_authoritative_receipts() -> None:
    mutations = (
        {"code_redemptions": 7},
        {"code_linked_outcomes": 7},
        {"no_click_redemptions": 1},
        {"vanity_visits": 1, "vanity_linked_outcomes": 2},
    )
    for mutation in mutations:
        payload = evidence_page()
        payload["summary"].update(mutation)
        with pytest.raises(ValidationError, match="inconsistent"):
            CampaignDirectAttributionEvidencePage.model_validate(payload)

    payload = evidence_page()
    payload["page_info"].update({"total": 7, "has_more": True})
    with pytest.raises(ValidationError, match="total"):
        CampaignDirectAttributionEvidencePage.model_validate(payload)


@pytest.mark.parametrize(
    ("limit", "offset"),
    [(0, 0), (101, 0), (25, -1), (25, 10_001), (True, 0)],
)
def test_pagination_bounds_fail_before_transport(limit: int, offset: int) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    client = Moosewave(
        api_key="pw_test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    with pytest.raises(ValueError, match="campaign direct-attribution evidence"):
        client.campaigns.list_direct_attribution_evidence(
            CAMPAIGN_ID, limit=limit, offset=offset
        )
    assert calls == 0
