"""Developer Marketplace OAuth runtime."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class DeveloperMarketplaceResource(SyncResource):
    def catalog(self) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/developer-marketplace/catalog")

    def validate_app(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/apps/validate",
            body=body,
        )

    def list_apps(self, status: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/apps",
            query={"status": status},
        )

    def create_app(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/apps",
            body=body,
        )

    def get_app(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}",
        )

    def update_app(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PATCH",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}",
            body=body,
        )

    def submit_app_review(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/submit-review",
        )

    def monitoring(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/monitoring",
        )

    def list_oauth_clients(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients",
        )

    def create_oauth_client(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients",
            body=body,
        )

    def revoke_oauth_client(self, app_id: str, client_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients/{quote(client_id, safe='')}",
        )

    def list_test_accounts(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/test-accounts",
        )

    def create_test_account(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/test-accounts",
            body=body,
        )

    def list_listings(self, category: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/listings",
            query={"category": category},
        )

    def upsert_listing(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PUT",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/listing",
            body=body,
        )

    def submit_listing_review(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/listing/submit-review",
        )

    def list_installations(self, status: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/installations",
            query={"status": status},
        )

    def install_app(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/installations",
            body=body,
        )

    def revoke_installation(self, installation_id: str) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/developer-marketplace/installations/{quote(installation_id, safe='')}",
        )

    def list_webhook_subscriptions(self, app_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/webhook-subscriptions",
        )

    def create_webhook_subscription(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/webhook-subscriptions",
            body=body,
        )

    def list_partner_profiles(self, profile_type: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/partner-profiles",
            query={"profile_type": profile_type},
        )

    def upsert_partner_profile(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "PUT",
            "/api/v1/developer-marketplace/partner-profile",
            body=body,
        )

    def submit_partner_profile_review(self) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/partner-profile/submit-review",
        )

    def review_queue(
        self,
        review_secret: str,
        *,
        kind: str | None = None,
        state: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/review/queue",
            query={"kind": kind, "state": state, "limit": limit},
            headers=_review_headers(review_secret),
        )

    def review_app_decision(
        self,
        app_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/apps/{quote(app_id, safe='')}/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    def review_listing_decision(
        self,
        app_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/apps/{quote(app_id, safe='')}/listing/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    def review_partner_profile_decision(
        self,
        tenant_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/partner-profiles/{quote(tenant_id, safe='')}/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    def authorize(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/authorize",
            body=body,
        )

    def token(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/token",
            body=body,
            idempotency_key=None,
        )

    def revoke(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/revoke",
            body=body,
            idempotency_key=None,
        )

    def list_audit_logs(self, app_id: str | None = None) -> dict[str, Any]:
        return self._client.request(
            "GET",
            "/api/v1/developer-marketplace/audit-logs",
            query={"app_id": app_id},
        )


class AsyncDeveloperMarketplaceResource(AsyncResource):
    async def catalog(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/developer-marketplace/catalog")

    async def validate_app(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/apps/validate",
            body=body,
        )

    async def list_apps(self, status: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/apps",
            query={"status": status},
        )

    async def create_app(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/apps",
            body=body,
        )

    async def get_app(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}",
        )

    async def update_app(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PATCH",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}",
            body=body,
        )

    async def submit_app_review(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/submit-review",
        )

    async def monitoring(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/monitoring",
        )

    async def list_oauth_clients(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients",
        )

    async def create_oauth_client(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients",
            body=body,
        )

    async def revoke_oauth_client(self, app_id: str, client_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/oauth-clients/{quote(client_id, safe='')}",
        )

    async def list_test_accounts(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/test-accounts",
        )

    async def create_test_account(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/test-accounts",
            body=body,
        )

    async def list_listings(self, category: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/listings",
            query={"category": category},
        )

    async def upsert_listing(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PUT",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/listing",
            body=body,
        )

    async def submit_listing_review(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/listing/submit-review",
        )

    async def list_installations(self, status: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/installations",
            query={"status": status},
        )

    async def install_app(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/installations",
            body=body,
        )

    async def revoke_installation(self, installation_id: str) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/developer-marketplace/installations/{quote(installation_id, safe='')}",
        )

    async def list_webhook_subscriptions(self, app_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/webhook-subscriptions",
        )

    async def create_webhook_subscription(self, app_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/apps/{quote(app_id, safe='')}/webhook-subscriptions",
            body=body,
        )

    async def list_partner_profiles(self, profile_type: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/partner-profiles",
            query={"profile_type": profile_type},
        )

    async def upsert_partner_profile(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "PUT",
            "/api/v1/developer-marketplace/partner-profile",
            body=body,
        )

    async def submit_partner_profile_review(self) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/partner-profile/submit-review",
        )

    async def review_queue(
        self,
        review_secret: str,
        *,
        kind: str | None = None,
        state: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/review/queue",
            query={"kind": kind, "state": state, "limit": limit},
            headers=_review_headers(review_secret),
        )

    async def review_app_decision(
        self,
        app_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/apps/{quote(app_id, safe='')}/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    async def review_listing_decision(
        self,
        app_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/apps/{quote(app_id, safe='')}/listing/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    async def review_partner_profile_decision(
        self,
        tenant_id: str,
        body: dict[str, Any],
        review_secret: str,
    ) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            f"/api/v1/developer-marketplace/review/partner-profiles/{quote(tenant_id, safe='')}/decision",
            body=body,
            headers=_review_headers(review_secret),
        )

    async def authorize(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/authorize",
            body=body,
        )

    async def token(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/token",
            body=body,
            idempotency_key=None,
        )

    async def revoke(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/developer-marketplace/oauth/revoke",
            body=body,
            idempotency_key=None,
        )

    async def list_audit_logs(self, app_id: str | None = None) -> dict[str, Any]:
        return await self._client.request(
            "GET",
            "/api/v1/developer-marketplace/audit-logs",
            query={"app_id": app_id},
        )


def _review_headers(review_secret: str) -> dict[str, str]:
    return {"X-Postwave-Review-Secret": review_secret}
