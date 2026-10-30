from __future__ import annotations

import httpx
import pytest

from postwave import (
    AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
    AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
    AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
    AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
    AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
    AgencyReleaseHeldError,
    AsyncPostwave,
    ParseError,
    Moosewave,
    decode_agency_branding,
    decode_agency_children_page,
)

CHILD = {
    "id": "11111111-1111-4111-8111-111111111111",
    "slug": "child-one",
    "name": "Child One",
    "tier": "studio",
    "parent_tenant_id": "22222222-2222-4222-8222-222222222222",
    "billing_mode": "self",
    "reseller_markup_bps": 0,
    "whitelabel_enabled": False,
    "created_at": "2026-09-12T08:00:00Z",
    "updated_at": "2026-09-12T08:00:01Z",
}
BRANDING = {
    "whitelabel_enabled": False,
    "brand_name": "",
    "custom_domain": "",
    "logo_url": "",
    "primary_color": "",
    "support_email": "",
    "legal_entity": "",
    "updated_at": "2026-09-12T08:00:01Z",
    "etag": '"agency-branding:22222222-2222-4222-8222-222222222222:v0"',
}


def test_only_two_agency_reads_perform_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/children"):
            return httpx.Response(
                200,
                json={
                    "children": [CHILD],
                    "count": 1,
                    "has_more": True,
                    "next_cursor": "next_1",
                },
            )
        return httpx.Response(200, json=BRANDING)

    client = Moosewave(
        api_key="pw_agency",
        tenant_id="parent",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    )

    assert client.agency.list_children(limit=25, cursor="prior_1")["count"] == 1
    assert client.agency.get_branding() == BRANDING
    assert [(request.method, str(request.url)) for request in seen] == [
        (
            "GET",
            "https://api.moosewave.com/api/v1/agency/children?limit=25&cursor=prior_1",
        ),
        ("GET", "https://api.moosewave.com/api/v1/agency/branding"),
    ]


def test_five_held_agency_capabilities_are_typed_and_request_free() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise AssertionError("release-held Agency operation reached transport")

    client = Moosewave(
        api_key="pw_agency",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )
    calls = [
        (
            lambda: client.agency.create_child({"slug": "child", "name": "Child"}),
            AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
        ),
        (lambda: client.agency.unlink_child(CHILD["id"]), AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE),
        (
            lambda: client.agency.update_branding({"brand_name": "Brand"}),
            AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
        ),
        (
            lambda: client.agency.set_billing_mode(
                {"target_tenant_id": CHILD["id"], "mode": "self", "reason": "review"},
            ),
            AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
        ),
        (lambda: client.agency.invoice_preview(), AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE),
    ]

    for call, code in calls:
        with pytest.raises(AgencyReleaseHeldError) as caught:
            call()
        assert caught.value.status == 503
        assert caught.value.code == code
        assert caught.value.retryable is False
        assert caught.value.committed is False
    assert seen == []


@pytest.mark.asyncio
async def test_async_held_agency_capability_is_request_free() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise AssertionError("release-held Agency operation reached transport")

    client = AsyncPostwave(
        api_key="pw_agency",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(AgencyReleaseHeldError) as caught:
        await client.agency.invoice_preview()
    assert caught.value.code == AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE
    assert seen == []
    await client.aclose()


def test_agency_pagination_and_envelopes_fail_closed() -> None:
    client = Moosewave(api_key="pw_agency")
    for limit in (0, 201, 1.5, True):
        with pytest.raises(ValueError):
            client.agency.list_children(limit=limit)  # type: ignore[arg-type]
    for cursor in ("", "with space", "x" * 513):
        with pytest.raises(ValueError):
            client.agency.list_children(cursor=cursor)

    with pytest.raises(ParseError):
        decode_agency_children_page(
            {"children": [CHILD], "count": 2, "has_more": False},
        )
    with pytest.raises(ParseError):
        decode_agency_children_page(
            {"children": [], "count": 0, "has_more": False, "next_cursor": "wrong"},
        )
    with pytest.raises(ParseError):
        decode_agency_branding({**BRANDING, "secret": "leak"})
    decode_agency_children_page(
        {"children": [{**CHILD, "slug": "a" * 63}], "count": 1, "has_more": False},
    )
    with pytest.raises(ParseError):
        decode_agency_children_page(
            {"children": [{**CHILD, "slug": "a" * 64}], "count": 1, "has_more": False},
        )
    for host in ("127.0.0.1", "127.1", "0177.0.0.1", "0x7f.0.0.1"):
        with pytest.raises(ParseError):
            decode_agency_branding({**BRANDING, "custom_domain": host})
        with pytest.raises(ParseError):
            decode_agency_branding({**BRANDING, "logo_url": f"https://{host}/logo.svg"})


def test_agency_requested_page_bound_is_enforced() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        second = {**CHILD, "id": "33333333-3333-4333-8333-333333333333"}
        return httpx.Response(
            200,
            json={"children": [CHILD, second], "count": 2, "has_more": False},
        )

    client = Moosewave(
        api_key="pw_agency",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    with pytest.raises(ParseError):
        client.agency.list_children(limit=1)
