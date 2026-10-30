from __future__ import annotations

from datetime import datetime
import re
from typing import Any, TypedDict, cast
from urllib.parse import urlsplit
from uuid import UUID

from ..errors import AgencyReleaseHeldError, ParseError
from ._base import AsyncResource, SyncResource

AGENCY_CHILD_CREATE_RELEASE_HELD_CODE = "agency_child_create_release_hold"
AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE = "agency_child_unlink_release_hold"
AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE = "agency_branding_update_release_hold"
AGENCY_BILLING_MODE_RELEASE_HELD_CODE = "agency_billing_mode_release_hold"
AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE = "agency_invoice_preview_release_hold"

_CURSOR = re.compile(r"^[A-Za-z0-9_-]{1,512}$")
_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_ETAG = re.compile(
    r'^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-'
    r'[0-9a-f]{4}-[0-9a-f]{12}:v(?:0|[1-9][0-9]*)"$',
)
_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$",
)
_UNSAFE_DISPLAY = re.compile(
    r"[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]",
)
_HEX_COLOR = re.compile(r"^(?:|#[0-9A-Fa-f]{6})$")
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_IPV4_NUMBER_LABEL = re.compile(r"^(?:0x[0-9a-f]+|[0-9]+)$")
_RESERVED_HOST_SUFFIXES = (
    "localhost",
    "local",
    "internal",
    "lan",
    "home",
    "home.arpa",
    "arpa",
    "onion",
    "test",
    "invalid",
    "example",
)
_CHILD_KEYS = {
    "id",
    "slug",
    "name",
    "tier",
    "parent_tenant_id",
    "billing_mode",
    "reseller_markup_bps",
    "whitelabel_enabled",
    "created_at",
    "updated_at",
}
_PAGE_KEYS = {"children", "count", "has_more", "next_cursor"}
_BRANDING_KEYS = {
    "whitelabel_enabled",
    "brand_name",
    "custom_domain",
    "logo_url",
    "primary_color",
    "support_email",
    "legal_entity",
    "updated_at",
    "etag",
}


class AgencyChild(TypedDict):
    id: str
    slug: str
    name: str
    tier: str
    parent_tenant_id: str
    billing_mode: str
    reseller_markup_bps: int
    whitelabel_enabled: bool
    created_at: str
    updated_at: str


class AgencyChildrenPageRequired(TypedDict):
    children: list[AgencyChild]
    count: int
    has_more: bool


class AgencyChildrenPage(AgencyChildrenPageRequired, total=False):
    next_cursor: str


class AgencyBranding(TypedDict):
    """Safe projection; legacy updated_at begins at the security-migration baseline."""

    whitelabel_enabled: bool
    brand_name: str
    custom_domain: str
    logo_url: str
    primary_color: str
    support_email: str
    legal_entity: str
    updated_at: str
    etag: str


def _held(code: str, message: str) -> AgencyReleaseHeldError:
    return AgencyReleaseHeldError(message, code=code)


def _children_query(limit: int | None, cursor: str | None) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if limit is not None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise ValueError("Agency roster limit must be an integer from 1 through 200")
        query["limit"] = limit
    if cursor is not None:
        if not isinstance(cursor, str) or _CURSOR.fullmatch(cursor) is None:
            raise ValueError(
                "Agency roster cursor must be an opaque base64url value of at most 512 characters",
            )
        query["cursor"] = cursor
    return query


def _timestamp(value: object) -> bool:
    if not isinstance(value, str) or _RFC3339.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _canonical_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _bounded_string(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and value.strip() == value
        and len(value) <= maximum
        and _UNSAFE_DISPLAY.search(value) is None
    )


def _public_hostname(value: object, *, allow_empty: bool = False) -> bool:
    if value == "":
        return allow_empty
    if (
        not isinstance(value, str)
        or len(value) > 253
        or value != value.lower()
        or re.search(r"[\s/\\:@%*?#\[\]]", value) is not None
    ):
        return False
    labels = value.split(".")
    if len(labels) < 2 or any(_DNS_LABEL.fullmatch(label) is None for label in labels):
        return False
    if len(labels) <= 4 and all(_IPV4_NUMBER_LABEL.fullmatch(label) for label in labels):
        return False
    return not any(value == suffix or value.endswith(f".{suffix}") for suffix in _RESERVED_HOST_SUFFIXES)


def _safe_logo_url(value: object) -> bool:
    if value == "":
        return True
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and port is None
        and parsed.query == ""
        and parsed.fragment == ""
        and _public_hostname(parsed.hostname)
        and re.search(r"\\|%00|%0a|%0d|%5c", parsed.path, re.IGNORECASE) is None
    )


def _child(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != _CHILD_KEYS:
        return False
    markup = value.get("reseller_markup_bps")
    return (
        _canonical_uuid(value.get("id"))
        and isinstance(value.get("slug"), str)
        and _SLUG.fullmatch(cast(str, value["slug"])) is not None
        and _bounded_string(value.get("name"), 120)
        and bool(value.get("name"))
        and value.get("tier") in {"studio", "sending", "pro"}
        and _canonical_uuid(value.get("parent_tenant_id"))
        and value.get("billing_mode") in {"self", "parent"}
        and isinstance(markup, int)
        and not isinstance(markup, bool)
        and 0 <= markup <= 100_000
        and isinstance(value.get("whitelabel_enabled"), bool)
        and _timestamp(value.get("created_at"))
        and _timestamp(value.get("updated_at"))
    )


def decode_agency_children_page(value: object) -> AgencyChildrenPage:
    if not isinstance(value, dict) or not set(value).issubset(_PAGE_KEYS):
        raise ParseError(
            "Agency child roster returned an invalid bounded response.",
            status=200,
            payload=value,
        )
    children = value.get("children")
    count = value.get("count")
    has_more = value.get("has_more")
    valid = (
        isinstance(children, list)
        and len(children) <= 200
        and all(_child(child) for child in children)
        and isinstance(count, int)
        and not isinstance(count, bool)
        and count == len(children)
        and isinstance(has_more, bool)
        and (
            isinstance(value.get("next_cursor"), str)
            and _CURSOR.fullmatch(cast(str, value["next_cursor"])) is not None
            if has_more
            else "next_cursor" not in value
        )
    )
    if not valid:
        raise ParseError(
            "Agency child roster returned an invalid bounded response.",
            status=200,
            payload=value,
        )
    return cast(AgencyChildrenPage, value)


def decode_agency_branding(value: object) -> AgencyBranding:
    if not isinstance(value, dict) or set(value) != _BRANDING_KEYS:
        raise ParseError(
            "Agency branding returned an invalid bounded response.",
            status=200,
            payload=value,
        )
    valid = (
        isinstance(value.get("whitelabel_enabled"), bool)
        and _bounded_string(value.get("brand_name"), 120)
        and _bounded_string(value.get("custom_domain"), 253)
        and _public_hostname(value.get("custom_domain"), allow_empty=True)
        and _bounded_string(value.get("logo_url"), 2048)
        and _safe_logo_url(value.get("logo_url"))
        and _bounded_string(value.get("primary_color"), 7)
        and _HEX_COLOR.fullmatch(cast(str, value["primary_color"])) is not None
        and _bounded_string(value.get("support_email"), 254)
        and _bounded_string(value.get("legal_entity"), 200)
        and _timestamp(value.get("updated_at"))
        and isinstance(value.get("etag"), str)
        and _ETAG.fullmatch(cast(str, value["etag"])) is not None
    )
    if not valid:
        raise ParseError(
            "Agency branding returned an invalid bounded response.",
            status=200,
            payload=value,
        )
    return cast(AgencyBranding, value)


class AgencyResource(SyncResource):
    """Admin-only surface with two reads and five fail-closed capabilities."""

    def list_children(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> AgencyChildrenPage:
        payload = self._client.request(
            "GET",
            "/api/v1/agency/children",
            query=_children_query(limit, cursor),
        )
        page = decode_agency_children_page(payload)
        if len(page["children"]) > (limit if limit is not None else 100):
            raise ParseError(
                "Agency child roster exceeded the requested page bound.",
                status=200,
                payload=payload,
            )
        return page

    def create_child(self, payload: dict[str, Any]) -> Any:
        del payload
        raise _held(
            AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
            "Agency child creation is release-held until ownership, invitation, regional bootstrap, and billing provisioning commit atomically; no tenant was created.",
        )

    def unlink_child(self, child_id: str) -> Any:
        del child_id
        raise _held(
            AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
            "Agency child unlink is release-held until independent ownership and active payer authority can be proven atomically; no relationship changed.",
        )

    def get_branding(self) -> AgencyBranding:
        return decode_agency_branding(
            self._client.request("GET", "/api/v1/agency/branding"),
        )

    def update_branding(self, patch: dict[str, Any]) -> Any:
        del patch
        raise _held(
            AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
            "Agency branding updates are release-held until publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding changed.",
        )

    def set_billing_mode(self, payload: dict[str, Any]) -> Any:
        del payload
        raise _held(
            AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
            "Agency billing-mode changes are release-held until payer authority and consolidated invoicing are durable; no billing state changed.",
        )

    def invoice_preview(self, days: int = 30) -> Any:
        del days
        raise _held(
            AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
            "Agency invoice preview is release-held until a fixed rated ledger, temporal cutoff, payer authority, and consolidated invoice processor exist; no estimate was generated.",
        )


class AsyncAgencyResource(AsyncResource):
    async def list_children(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> AgencyChildrenPage:
        payload = await self._client.request(
            "GET",
            "/api/v1/agency/children",
            query=_children_query(limit, cursor),
        )
        page = decode_agency_children_page(payload)
        if len(page["children"]) > (limit if limit is not None else 100):
            raise ParseError(
                "Agency child roster exceeded the requested page bound.",
                status=200,
                payload=payload,
            )
        return page

    async def create_child(self, payload: dict[str, Any]) -> Any:
        del payload
        raise _held(
            AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
            "Agency child creation is release-held until ownership, invitation, regional bootstrap, and billing provisioning commit atomically; no tenant was created.",
        )

    async def unlink_child(self, child_id: str) -> Any:
        del child_id
        raise _held(
            AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
            "Agency child unlink is release-held until independent ownership and active payer authority can be proven atomically; no relationship changed.",
        )

    async def get_branding(self) -> AgencyBranding:
        return decode_agency_branding(
            await self._client.request("GET", "/api/v1/agency/branding"),
        )

    async def update_branding(self, patch: dict[str, Any]) -> Any:
        del patch
        raise _held(
            AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
            "Agency branding updates are release-held until publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding changed.",
        )

    async def set_billing_mode(self, payload: dict[str, Any]) -> Any:
        del payload
        raise _held(
            AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
            "Agency billing-mode changes are release-held until payer authority and consolidated invoicing are durable; no billing state changed.",
        )

    async def invoice_preview(self, days: int = 30) -> Any:
        del days
        raise _held(
            AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
            "Agency invoice preview is release-held until a fixed rated ledger, temporal cutoff, payer authority, and consolidated invoice processor exist; no estimate was generated.",
        )
