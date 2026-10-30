"""Native managed integration family resources."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlencode

from ..errors import ServerError
from ._base import AsyncResource, SyncResource
from .integrations import path_segment


SUPPORT_INTEGRATION_RUNTIME_HELD_CODE = "support_integration_runtime_held"
_SUPPORT_INTEGRATION_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_SUPPORT_INTEGRATION_UNSAFE_CURSOR = re.compile(
    r"[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]"
)


def _support_integration_runtime_held() -> ServerError:
    return ServerError(
        "Support-provider connection configuration, synchronization, ingestion, lifecycle mutations, and run history are release-held while Helpdesk privacy governance is incomplete.",
        status=503,
        code=SUPPORT_INTEGRATION_RUNTIME_HELD_CODE,
    )


def _support_integration_read_id(value: str) -> str:
    if _SUPPORT_INTEGRATION_UUID.fullmatch(value) is None:
        raise ValueError("support integration id must be a lowercase canonical UUID")
    return value


def _support_integration_list_query(
    limit: int | None,
    cursor: str | None,
) -> dict[str, Any] | None:
    if limit is not None and (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > 100
    ):
        raise ValueError("support integration limit must be from 1 through 100")
    if cursor is not None and (
        not isinstance(cursor, str)
        or not cursor
        or cursor != cursor.strip()
        or len(cursor) > 4096
        or _SUPPORT_INTEGRATION_UNSAFE_CURSOR.search(cursor) is not None
    ):
        raise ValueError("support integration cursor is invalid")
    query: dict[str, Any] = {}
    if limit is not None:
        query["limit"] = limit
    if cursor is not None:
        query["cursor"] = cursor
    return query or None


def _oauth_query_value(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    return value


_CRM_OAUTH_PROVIDERS = {
    "pipedrive",
    "hubspot",
    "salesforce",
    "zoho",
    "dynamics365",
    "keap",
    "gohighlevel",
}


def _crm_oauth_provider_path(provider: str) -> str:
    value = provider.strip().lower()
    if value not in _CRM_OAUTH_PROVIDERS:
        raise ValueError(f"Unsupported CRM OAuth provider: {provider}")
    return path_segment(value, "CRM OAuth provider")


class NativeIntegrationFamilyResource(SyncResource):
    def __init__(self, client: Any, *, providers_path: str, integrations_path: str, supports_ingest: bool = False) -> None:
        super().__init__(client)
        self._providers_path = providers_path
        self._integrations_path = integrations_path
        self._supports_ingest = supports_ingest

    def providers(self) -> dict[str, Any]:
        return self._client.request("GET", self._providers_path)

    def list(self) -> dict[str, Any]:
        return self._client.request("GET", self._integrations_path)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", self._integrations_path, body=payload)

    def get(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}",
        )

    def sync(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/sync",
            body=payload or {},
        )

    def backfill(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/backfill",
            body=payload or {},
        )

    def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._supports_ingest:
            raise ValueError("native integration family does not support ingest")
        return self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/ingest",
            body=payload,
        )

    def pause(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/pause",
        )

    def disconnect(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}",
        )

    def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/runs",
            query={"limit": limit},
        )


class AsyncNativeIntegrationFamilyResource(AsyncResource):
    def __init__(self, client: Any, *, providers_path: str, integrations_path: str, supports_ingest: bool = False) -> None:
        super().__init__(client)
        self._providers_path = providers_path
        self._integrations_path = integrations_path
        self._supports_ingest = supports_ingest

    async def providers(self) -> dict[str, Any]:
        return await self._client.request("GET", self._providers_path)

    async def list(self) -> dict[str, Any]:
        return await self._client.request("GET", self._integrations_path)

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", self._integrations_path, body=payload)

    async def get(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}",
        )

    async def sync(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/sync",
            body=payload or {},
        )

    async def backfill(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/backfill",
            body=payload or {},
        )

    async def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._supports_ingest:
            raise ValueError("native integration family does not support ingest")
        return await self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/ingest",
            body=payload,
        )

    async def pause(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/pause",
        )

    async def disconnect(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}",
        )

    async def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"{self._integrations_path}/{path_segment(integration_id, 'native integration id')}/runs",
            query={"limit": limit},
        )


class MarketingNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Native marketing integrations, including Klaviyo cleanup acknowledgement."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/marketing-integrations/providers",
            integrations_path="/api/v1/marketing-integrations",
            supports_ingest=False,
        )

    def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/marketing-integrations/{path_segment(integration_id, 'native marketing integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class CRMNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Native CRM integrations using credential refs, canonical rows, and provider-managed pullers when configured."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/crm/providers",
            integrations_path="/api/v1/crm/integrations",
            supports_ingest=False,
        )

    def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("native integration family does not support ingest")

    def oauth_availability(self, provider: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/crm/{_crm_oauth_provider_path(provider)}/oauth/availability",
        )

    def oauth_start_url(self, provider: str, query: dict[str, Any] | None = None) -> str:
        path = f"/api/v1/crm/{_crm_oauth_provider_path(provider)}/oauth/start"
        params = {
            key: _oauth_query_value(value)
            for key, value in (query or {}).items()
            if value is not None and value != ""
        }
        if not params:
            return path
        return f"{path}?{urlencode(params)}"


class SupportNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Catalog/list/detail reads only; runtime effects and run history are held."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/support-integrations/providers",
            integrations_path="/api/v1/support-integrations",
            supports_ingest=True,
        )

    def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            self._integrations_path,
            query=_support_integration_list_query(limit, cursor),
        )

    def get(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"{self._integrations_path}/{_support_integration_read_id(integration_id)}",
        )

    def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        del integration_id, limit
        raise _support_integration_runtime_held()

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        del payload
        raise _support_integration_runtime_held()

    def sync(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    def backfill(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    def pause(self, integration_id: str) -> dict[str, Any]:
        del integration_id
        raise _support_integration_runtime_held()

    def disconnect(self, integration_id: str) -> dict[str, Any]:
        del integration_id
        raise _support_integration_runtime_held()


class ReviewNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Native review integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/review-integrations/providers",
            integrations_path="/api/v1/review-integrations",
            supports_ingest=True,
        )

    def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/review-integrations/{path_segment(integration_id, 'native review integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class LoyaltyNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Native loyalty integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/loyalty-integrations/providers",
            integrations_path="/api/v1/loyalty-integrations",
            supports_ingest=True,
        )

    def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/loyalty-integrations/{path_segment(integration_id, 'native loyalty integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class SubscriptionNativeIntegrationsResource(NativeIntegrationFamilyResource):
    """Native subscription integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/subscription-integrations/providers",
            integrations_path="/api/v1/subscription-integrations",
            supports_ingest=True,
        )

    def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/subscription-integrations/{path_segment(integration_id, 'native subscription integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class AsyncCRMNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async native CRM integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/crm/providers",
            integrations_path="/api/v1/crm/integrations",
            supports_ingest=False,
        )

    async def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("native integration family does not support ingest")

    async def oauth_availability(self, provider: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/crm/{_crm_oauth_provider_path(provider)}/oauth/availability",
        )

    def oauth_start_url(self, provider: str, query: dict[str, Any] | None = None) -> str:
        path = f"/api/v1/crm/{_crm_oauth_provider_path(provider)}/oauth/start"
        params = {
            key: _oauth_query_value(value)
            for key, value in (query or {}).items()
            if value is not None and value != ""
        }
        if not params:
            return path
        return f"{path}?{urlencode(params)}"


class AsyncMarketingNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async native marketing integrations, including Klaviyo cleanup acknowledgement."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/marketing-integrations/providers",
            integrations_path="/api/v1/marketing-integrations",
            supports_ingest=False,
        )

    async def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/marketing-integrations/{path_segment(integration_id, 'native marketing integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class AsyncSupportNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async catalog/list/detail reads; runtime effects and run history are held."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/support-integrations/providers",
            integrations_path="/api/v1/support-integrations",
            supports_ingest=True,
        )

    async def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            self._integrations_path,
            query=_support_integration_list_query(limit, cursor),
        )

    async def get(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"{self._integrations_path}/{_support_integration_read_id(integration_id)}",
        )

    async def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        del integration_id, limit
        raise _support_integration_runtime_held()

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        del payload
        raise _support_integration_runtime_held()

    async def sync(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    async def backfill(
        self,
        integration_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    async def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        del integration_id, payload
        raise _support_integration_runtime_held()

    async def pause(self, integration_id: str) -> dict[str, Any]:
        del integration_id
        raise _support_integration_runtime_held()

    async def disconnect(self, integration_id: str) -> dict[str, Any]:
        del integration_id
        raise _support_integration_runtime_held()


class AsyncReviewNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async native review integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/review-integrations/providers",
            integrations_path="/api/v1/review-integrations",
            supports_ingest=True,
        )

    async def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/review-integrations/{path_segment(integration_id, 'native review integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class AsyncLoyaltyNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async native loyalty integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/loyalty-integrations/providers",
            integrations_path="/api/v1/loyalty-integrations",
            supports_ingest=True,
        )

    async def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/loyalty-integrations/{path_segment(integration_id, 'native loyalty integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class AsyncSubscriptionNativeIntegrationsResource(AsyncNativeIntegrationFamilyResource):
    """Async native subscription integrations using canonical rows or configured provider-managed pullers."""

    def __init__(self, client: Any) -> None:
        super().__init__(
            client,
            providers_path="/api/v1/subscription-integrations/providers",
            integrations_path="/api/v1/subscription-integrations",
            supports_ingest=True,
        )

    async def acknowledge_provider_cleanup(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/subscription-integrations/{path_segment(integration_id, 'native subscription integration id')}/provider-cleanup/acknowledge",
            body=payload,
        )


class AnalyticsNativeIntegrationsResource(SyncResource):
    """Native analytics/CDP ingest resource using canonical Moosewave row shapes."""

    _base_path = "/api/v1/analytics-integrations"

    def providers(self) -> dict[str, Any]:
        return self._client.request("GET", f"{self._base_path}/providers")

    def list(self) -> dict[str, Any]:
        return self._client.request("GET", self._base_path)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create with provider/name/settings/credentials_ref, not generic config/credentials."""

        return self._client.request("POST", self._base_path, body=payload)

    def get(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}",
        )

    def sync(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Import canonical profiles/events/cursor payloads."""

        return self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/sync",
            body=payload or {},
        )

    def backfill(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/backfill",
            body=payload or {},
        )

    def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Ingest one canonical analytics event, not a raw provider webhook body."""

        return self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/ingest",
            body=payload,
        )

    def pause(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/pause",
        )

    def disconnect(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}",
        )

    def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/runs",
            query={"limit": limit},
        )


class AsyncAnalyticsNativeIntegrationsResource(AsyncResource):
    """Async native analytics/CDP ingest resource using canonical Moosewave row shapes."""

    _base_path = "/api/v1/analytics-integrations"

    async def providers(self) -> dict[str, Any]:
        return await self._client.request("GET", f"{self._base_path}/providers")

    async def list(self) -> dict[str, Any]:
        return await self._client.request("GET", self._base_path)

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", self._base_path, body=payload)

    async def get(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}",
        )

    async def sync(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/sync",
            body=payload or {},
        )

    async def backfill(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/backfill",
            body=payload or {},
        )

    async def ingest(self, integration_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/ingest",
            body=payload,
        )

    async def pause(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/pause",
        )

    async def disconnect(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}",
        )

    async def runs(self, integration_id: str, limit: int = 25) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"{self._base_path}/{path_segment(integration_id, 'native analytics integration id')}/runs",
            query={"limit": limit},
        )


class CommerceNativeIntegrationsResource(SyncResource):
    def providers(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/commerce/providers")

    def list(self) -> list[dict[str, Any]]:
        return self._client.request("GET", "/api/v1/commerce/integrations")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/commerce/integrations", body=payload)

    def get(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}",
        )

    def sync(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/sync",
            body=payload or {},
        )

    def backfill(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/backfill",
            body=payload or {},
        )

    def pause(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/pause",
        )

    def disconnect(self, integration_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}",
        )


class AsyncCommerceNativeIntegrationsResource(AsyncResource):
    async def providers(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/commerce/providers")

    async def list(self) -> list[dict[str, Any]]:
        return await self._client.request("GET", "/api/v1/commerce/integrations")

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/commerce/integrations", body=payload)

    async def get(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}",
        )

    async def sync(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/sync",
            body=payload or {},
        )

    async def backfill(self, integration_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/backfill",
            body=payload or {},
        )

    async def pause(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}/pause",
        )

    async def disconnect(self, integration_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/commerce/integrations/{path_segment(integration_id, 'commerce integration id')}",
        )


class WarehouseNativeIntegrationsResource(SyncResource):
    def providers(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/warehouse/providers")

    def list(self, status: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/warehouse/connections",
            query={"status": status} if status else None,
        )

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/warehouse/connections", body=payload)

    def get(self, connection_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}",
        )

    def health(self, connection_id: str, *, provider_check: bool = False) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/health",
            query={"provider_check": provider_check} if provider_check else None,
        )

    def sync(self, connection_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = {**(payload or {}), "run_mode": (payload or {}).get("run_mode", "manual")}
        return self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            body=body,
        )

    def backfill(self, connection_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = {**(payload or {}), "run_mode": (payload or {}).get("run_mode", "backfill")}
        return self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            body=body,
        )

    def pause(self, connection_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/pause",
        )

    def disconnect(self, connection_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}",
        )

    def acknowledge_provider_cleanup(self, connection_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/provider-cleanup/acknowledge",
            body=payload,
        )

    def runs(self, connection_id: str, limit: int = 25) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            query={"limit": limit},
        )


class AsyncWarehouseNativeIntegrationsResource(AsyncResource):
    async def providers(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/warehouse/providers")

    async def list(self, status: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/warehouse/connections",
            query={"status": status} if status else None,
        )

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/warehouse/connections", body=payload)

    async def get(self, connection_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}",
        )

    async def health(self, connection_id: str, *, provider_check: bool = False) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/health",
            query={"provider_check": provider_check} if provider_check else None,
        )

    async def sync(self, connection_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = {**(payload or {}), "run_mode": (payload or {}).get("run_mode", "manual")}
        return await self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            body=body,
        )

    async def backfill(self, connection_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = {**(payload or {}), "run_mode": (payload or {}).get("run_mode", "backfill")}
        return await self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            body=body,
        )

    async def pause(self, connection_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/pause",
        )

    async def disconnect(self, connection_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}",
        )

    async def acknowledge_provider_cleanup(self, connection_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/provider-cleanup/acknowledge",
            body=payload,
        )

    async def runs(self, connection_id: str, limit: int = 25) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/warehouse/connections/{path_segment(connection_id, 'native warehouse connection id')}/runs",
            query={"limit": limit},
        )


class NativeIntegrationsResource:
    def __init__(self, client: Any) -> None:
        self.commerce = CommerceNativeIntegrationsResource(client)
        self.crm = CRMNativeIntegrationsResource(client)
        self.lead = NativeIntegrationFamilyResource(
            client,
            providers_path="/api/v1/lead-integrations/providers",
            integrations_path="/api/v1/lead-integrations",
            supports_ingest=True,
        )
        self.reviews = ReviewNativeIntegrationsResource(client)
        self.loyalty = LoyaltyNativeIntegrationsResource(client)
        self.subscriptions = SubscriptionNativeIntegrationsResource(client)
        self.support = SupportNativeIntegrationsResource(client)
        self.analytics = AnalyticsNativeIntegrationsResource(client)
        self.marketing = MarketingNativeIntegrationsResource(client)
        self.warehouse = WarehouseNativeIntegrationsResource(client)


class AsyncNativeIntegrationsResource:
    def __init__(self, client: Any) -> None:
        self.commerce = AsyncCommerceNativeIntegrationsResource(client)
        self.crm = AsyncCRMNativeIntegrationsResource(client)
        self.lead = AsyncNativeIntegrationFamilyResource(
            client,
            providers_path="/api/v1/lead-integrations/providers",
            integrations_path="/api/v1/lead-integrations",
            supports_ingest=True,
        )
        self.reviews = AsyncReviewNativeIntegrationsResource(client)
        self.loyalty = AsyncLoyaltyNativeIntegrationsResource(client)
        self.subscriptions = AsyncSubscriptionNativeIntegrationsResource(client)
        self.support = AsyncSupportNativeIntegrationsResource(client)
        self.analytics = AsyncAnalyticsNativeIntegrationsResource(client)
        self.marketing = AsyncMarketingNativeIntegrationsResource(client)
        self.warehouse = AsyncWarehouseNativeIntegrationsResource(client)
