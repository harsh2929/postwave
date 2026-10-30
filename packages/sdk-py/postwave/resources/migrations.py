from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.common import SourcePlatform
from ..types.migrations import (
    AdapterCapabilities,
    AutomationRebuildItem,
    DiscoveryReport,
    MigrationJob,
    OAuthStartResponse,
    PilotAcceptanceReport,
    RollbackRehearsalReport,
    RollbackProgress,
    RollbackStartResponse,
    ShadowCheckResponse,
    ShadowMonitorResponse,
    SourceEventMonitorResponse,
    SourceEventRecord,
    VerificationReport,
)


def _models(payload: Any, model: Any) -> Any:
    if isinstance(payload, list):
        return [model.model_validate(p) for p in payload]
    return model.model_validate(payload)


_MIGRATION_SOURCES = {
    "mailchimp",
    "klaviyo",
    "customerio",
    "constant-contact",
    "aweber",
    "drip",
    "campaign-monitor",
    "omnisend",
    "loops",
    "flodesk",
    "bento",
    "activecampaign",
    "hubspot",
    "convertkit",
    "brevo",
    "substack",
    "beehiiv",
    "mailerlite",
    "sendy",
    "csv",
}


def source_path(source: SourcePlatform) -> str:
    if source not in _MIGRATION_SOURCES:
        raise ValueError(f"Unsupported migration source: {source}")
    return q(source)


def upload_path(upload_id: str) -> str:
    if not upload_id.strip():
        raise ValueError("Migration upload ID is required")
    return q(upload_id.strip())


def _migration_run_body(
    source: SourcePlatform,
    job_id: str,
    selected_audience_ids: Sequence[str] | None,
    *,
    require_mailchimp_scope: bool,
) -> dict[str, Any]:
    if require_mailchimp_scope and source == "mailchimp" and not selected_audience_ids:
        raise ValueError("Mailchimp dry-run and commit require at least one selected audience ID")
    body: dict[str, Any] = {"job_id": job_id}
    if selected_audience_ids is not None:
        audience_ids = [audience_id.strip() for audience_id in selected_audience_ids]
        if any(not audience_id for audience_id in audience_ids):
            raise ValueError("Mailchimp audience IDs must not be empty")
        body["selected_audience_ids"] = audience_ids
    return body


class MigrationsResource(SyncResource):
    def upload_status(self, source: SourcePlatform, upload_id: str) -> dict[str, Any]:
        return self._client.request(
            "GET", f"/api/v1/migrations/{source_path(source)}/uploads/{upload_path(upload_id)}"
        )

    def start(self, source: SourcePlatform, job_id: str | None = None) -> OAuthStartResponse:
        """Begin OAuth, optionally reconnecting an existing non-running job."""
        query = None
        if job_id is not None:
            job_id = job_id.strip()
            if not job_id:
                raise ValueError("Migration job ID is required for OAuth reconnect")
            query = {"job_id": job_id}
        r = self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/oauth/start",
            query=query,
        )
        return OAuthStartResponse.model_validate(r)

    def callback(self, source: SourcePlatform, code: str, state: str) -> dict[str, str]:
        return self._client.request(
            "GET", f"/api/v1/migrations/{source_path(source)}/oauth/callback",
            query={"code": code, "state": state},
        )

    def credentials(
        self,
        source: SourcePlatform,
        api_key: str | None = None,
        account_id: str | None = None,
        extra: dict[str, str] | None = None,
        *,
        access_token: str | None = None,
        refresh_token: str | None = None,
    ) -> dict[str, str]:
        """Create a credential-based migration job.

        For ActiveCampaign, pass the API token as ``api_key`` and the account
        API URL from Settings -> Developer as ``account_id`` or
        ``extra={"api_url": "https://account.api-us1.com/api/3"}``.
        For HubSpot, pass the private app token as ``api_key`` and optionally
        pass the hub ID as ``account_id`` or ``extra={"hub_id": "12345"}``.
        For Beehiiv, pass the API key and optionally select the publication via
        ``account_id`` or ``extra={"publication_id": "pub_..."}``. Selection
        is required when the key can access more than one publication.
        For Klaviyo, pass a private API key as ``api_key`` or a caller-managed
        bearer credential as ``access_token`` with an optional
        ``refresh_token``. This raw credential handoff is separate from managed
        native-integration OAuth. An unrolled-back tenant/account lineage must
        refresh and run deltas on its original job; a second same-account job is
        rejected.
        For Customer.io, pass an App API key (not a Track API site key), set
        ``extra={"region": "us" | "eu"}``, and pass the numeric workspace ID
        as ``account_id`` when the key exposes multiple workspaces. Reuse the
        same unrolled-back region/workspace job lineage for refreshes and
        deltas.
        """
        body: dict[str, Any] = {}
        if api_key is not None:
            body["api_key"] = api_key
        if access_token is not None:
            body["access_token"] = access_token
        if refresh_token is not None:
            body["refresh_token"] = refresh_token
        if account_id is not None:
            body["account_id"] = account_id
        if extra is not None:
            body["extra"] = extra
        return self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/credentials", body=body)

    def discover(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> DiscoveryReport:
        r = self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/discover",
            body=_migration_run_body(
                source, job_id, selected_audience_ids, require_mailchimp_scope=False
            ),
        )
        return DiscoveryReport.model_validate(r)

    def dry_run(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> dict[str, str]:
        return self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/dry-run",
            body=_migration_run_body(
                source, job_id, selected_audience_ids, require_mailchimp_scope=True
            ),
        )

    def commit(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> dict[str, str]:
        return self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/commit",
            body=_migration_run_body(
                source, job_id, selected_audience_ids, require_mailchimp_scope=True
            ),
        )

    def delta_import(self, source: SourcePlatform, job_id: str) -> dict[str, str]:
        return self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/delta-import", body={"job_id": job_id})

    def shadow_check(self, source: SourcePlatform, job_id: str) -> ShadowCheckResponse:
        return ShadowCheckResponse.model_validate(
            self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/shadow-check", body={"job_id": job_id})
        )

    def start_shadow_monitor(
        self,
        source: SourcePlatform,
        job_id: str,
        interval_seconds: int = 3600,
    ) -> ShadowMonitorResponse:
        return ShadowMonitorResponse.model_validate(
            self._client.request(
                "POST",
                f"/api/v1/migrations/sources/{source_path(source)}/shadow-monitor",
                body={"job_id": job_id, "interval_seconds": interval_seconds},
            )
        )

    def shadow_monitor(self, job_id: str) -> ShadowMonitorResponse:
        return ShadowMonitorResponse.model_validate(
            self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/shadow-monitor")
        )

    def stop_shadow_monitor(self, job_id: str) -> dict[str, Any]:
        return self._client.request("DELETE", f"/api/v1/migrations/{q(job_id)}/shadow-monitor")

    def start_source_events(
        self,
        source: SourcePlatform,
        job_id: str,
        interval_seconds: int = 3600,
    ) -> SourceEventMonitorResponse:
        return SourceEventMonitorResponse.model_validate(
            self._client.request(
                "POST",
                f"/api/v1/migrations/sources/{source_path(source)}/source-events",
                body={"job_id": job_id, "interval_seconds": interval_seconds},
            )
        )

    def source_events(self, job_id: str) -> SourceEventMonitorResponse:
        return SourceEventMonitorResponse.model_validate(
            self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/source-events")
        )

    def stop_source_events(self, job_id: str, post_pilot_cleanup: bool = False) -> dict[str, Any]:
        return self._client.request(
            "DELETE",
            f"/api/v1/migrations/{q(job_id)}/source-events",
            query={"post_pilot_cleanup": "1"} if post_pilot_cleanup else None,
        )

    def update_source_event_review(
        self,
        job_id: str,
        event_id: str,
        payload: dict[str, Any],
    ) -> SourceEventRecord:
        """Record 1-50 non-secret evidence references, or reopen the review."""
        return SourceEventRecord.model_validate(
            self._client.request(
                "PATCH",
                f"/api/v1/migrations/{q(job_id)}/source-events/{q(event_id)}/review",
                body=payload,
            )
        )

    def get(self, job_id: str) -> MigrationJob:
        return MigrationJob.model_validate(self._client.request("GET", f"/api/v1/migrations/{q(job_id)}"))

    def refresh_source_session(self, job_id: str, payload: dict[str, Any]) -> MigrationJob:
        return MigrationJob.model_validate(
            self._client.request("POST", f"/api/v1/migrations/{q(job_id)}/source-session", body=payload)
        )

    def cancel(self, job_id: str) -> dict[str, Any]:
        return self._client.request("DELETE", f"/api/v1/migrations/{q(job_id)}")

    def list(self) -> list[MigrationJob]:
        return _models(self._client.request("GET", "/api/v1/migrations"), MigrationJob)

    def verification(self, job_id: str) -> VerificationReport:
        return VerificationReport.model_validate(self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/verification"))

    def pilot_acceptance(self, job_id: str) -> PilotAcceptanceReport:
        return PilotAcceptanceReport.model_validate(
            self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/pilot-acceptance")
        )

    def record_cutover_evidence(self, job_id: str, payload: dict[str, Any]) -> PilotAcceptanceReport:
        return PilotAcceptanceReport.model_validate(
            self._client.request("PATCH", f"/api/v1/migrations/{q(job_id)}/cutover-evidence", body=payload)
        )

    def rollback_rehearsal(self, job_id: str) -> RollbackRehearsalReport:
        return RollbackRehearsalReport.model_validate(
            self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/rollback-rehearsal")
        )

    def automation_rebuilds(self, job_id: str) -> list[AutomationRebuildItem]:
        r = self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/automation-rebuilds")
        return _models(r.get("items", r), AutomationRebuildItem)

    def update_automation_rebuild(self, job_id: str, item: dict[str, Any] | AutomationRebuildItem) -> AutomationRebuildItem:
        payload = item.model_dump(exclude_none=True) if isinstance(item, AutomationRebuildItem) else item
        return AutomationRebuildItem.model_validate(
            self._client.request("PATCH", f"/api/v1/migrations/{q(job_id)}/automation-rebuilds", body=payload)
        )

    def rollback(self, job_id: str) -> RollbackStartResponse:
        """Start an eligible rollback; use ``rollback_status`` to poll it."""
        return RollbackStartResponse.model_validate(
            self._client.request("POST", f"/api/v1/migrations/{q(job_id)}/rollback")
        )

    def rollback_status(self, job_id: str) -> RollbackProgress:
        return RollbackProgress.model_validate(self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/rollback-status"))

    def list_sources(self) -> list[AdapterCapabilities]:
        return _models(self._client.request("GET", "/api/v1/migrations/sources"), AdapterCapabilities)

    def capabilities(self) -> list[AdapterCapabilities]:
        return _models(self._client.request("GET", "/api/v1/migrations/capabilities"), AdapterCapabilities)


class AsyncMigrationsResource(AsyncResource):
    async def upload_status(self, source: SourcePlatform, upload_id: str) -> dict[str, Any]:
        return await self._client.request(
            "GET", f"/api/v1/migrations/{source_path(source)}/uploads/{upload_path(upload_id)}"
        )

    async def start(
        self,
        source: SourcePlatform,
        job_id: str | None = None,
    ) -> OAuthStartResponse:
        """Begin OAuth, optionally reconnecting an existing non-running job."""
        query = None
        if job_id is not None:
            job_id = job_id.strip()
            if not job_id:
                raise ValueError("Migration job ID is required for OAuth reconnect")
            query = {"job_id": job_id}
        return OAuthStartResponse.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/migrations/{source_path(source)}/oauth/start",
                query=query,
            )
        )

    async def callback(self, source: SourcePlatform, code: str, state: str) -> dict[str, str]:
        return await self._client.request(
            "GET", f"/api/v1/migrations/{source_path(source)}/oauth/callback",
            query={"code": code, "state": state},
        )

    async def credentials(
        self,
        source: SourcePlatform,
        api_key: str | None = None,
        account_id: str | None = None,
        extra: dict[str, str] | None = None,
        *,
        access_token: str | None = None,
        refresh_token: str | None = None,
    ) -> dict[str, str]:
        """Create a credential-based migration job.

        For ActiveCampaign, pass the API token as ``api_key`` and the account
        API URL from Settings -> Developer as ``account_id`` or
        ``extra={"api_url": "https://account.api-us1.com/api/3"}``.
        For HubSpot, pass the private app token as ``api_key`` and optionally
        pass the hub ID as ``account_id`` or ``extra={"hub_id": "12345"}``.
        For Beehiiv, pass the API key and optionally select the publication via
        ``account_id`` or ``extra={"publication_id": "pub_..."}``. Selection
        is required when the key can access more than one publication.
        For Klaviyo, pass a private API key as ``api_key`` or a caller-managed
        bearer credential as ``access_token`` with an optional
        ``refresh_token``. This raw credential handoff is separate from managed
        native-integration OAuth. An unrolled-back tenant/account lineage must
        refresh and run deltas on its original job; a second same-account job is
        rejected.
        For Customer.io, pass an App API key (not a Track API site key), set
        ``extra={"region": "us" | "eu"}``, and pass the numeric workspace ID
        as ``account_id`` when the key exposes multiple workspaces. Reuse the
        same unrolled-back region/workspace job lineage for refreshes and
        deltas.
        """
        body: dict[str, Any] = {}
        if api_key is not None:
            body["api_key"] = api_key
        if access_token is not None:
            body["access_token"] = access_token
        if refresh_token is not None:
            body["refresh_token"] = refresh_token
        if account_id is not None:
            body["account_id"] = account_id
        if extra is not None:
            body["extra"] = extra
        return await self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/credentials", body=body)

    async def discover(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> DiscoveryReport:
        return DiscoveryReport.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/migrations/{source_path(source)}/discover",
                body=_migration_run_body(
                    source, job_id, selected_audience_ids, require_mailchimp_scope=False
                ),
            )
        )

    async def dry_run(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> dict[str, str]:
        return await self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/dry-run",
            body=_migration_run_body(
                source, job_id, selected_audience_ids, require_mailchimp_scope=True
            ),
        )

    async def commit(
        self,
        source: SourcePlatform,
        job_id: str,
        selected_audience_ids: Sequence[str] | None = None,
    ) -> dict[str, str]:
        return await self._client.request(
            "POST",
            f"/api/v1/migrations/{source_path(source)}/commit",
            body=_migration_run_body(
                source, job_id, selected_audience_ids, require_mailchimp_scope=True
            ),
        )

    async def delta_import(self, source: SourcePlatform, job_id: str) -> dict[str, str]:
        return await self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/delta-import", body={"job_id": job_id})

    async def shadow_check(self, source: SourcePlatform, job_id: str) -> ShadowCheckResponse:
        return ShadowCheckResponse.model_validate(
            await self._client.request("POST", f"/api/v1/migrations/{source_path(source)}/shadow-check", body={"job_id": job_id})
        )

    async def start_shadow_monitor(
        self,
        source: SourcePlatform,
        job_id: str,
        interval_seconds: int = 3600,
    ) -> ShadowMonitorResponse:
        return ShadowMonitorResponse.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/migrations/sources/{source_path(source)}/shadow-monitor",
                body={"job_id": job_id, "interval_seconds": interval_seconds},
            )
        )

    async def shadow_monitor(self, job_id: str) -> ShadowMonitorResponse:
        return ShadowMonitorResponse.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/shadow-monitor")
        )

    async def stop_shadow_monitor(self, job_id: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/migrations/{q(job_id)}/shadow-monitor")

    async def start_source_events(
        self,
        source: SourcePlatform,
        job_id: str,
        interval_seconds: int = 3600,
    ) -> SourceEventMonitorResponse:
        return SourceEventMonitorResponse.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/migrations/sources/{source_path(source)}/source-events",
                body={"job_id": job_id, "interval_seconds": interval_seconds},
            )
        )

    async def source_events(self, job_id: str) -> SourceEventMonitorResponse:
        return SourceEventMonitorResponse.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/source-events")
        )

    async def stop_source_events(self, job_id: str, post_pilot_cleanup: bool = False) -> dict[str, Any]:
        return await self._client.request(
            "DELETE",
            f"/api/v1/migrations/{q(job_id)}/source-events",
            query={"post_pilot_cleanup": "1"} if post_pilot_cleanup else None,
        )

    async def update_source_event_review(
        self,
        job_id: str,
        event_id: str,
        payload: dict[str, Any],
    ) -> SourceEventRecord:
        """Record 1-50 non-secret evidence references, or reopen the review."""
        return SourceEventRecord.model_validate(
            await self._client.request(
                "PATCH",
                f"/api/v1/migrations/{q(job_id)}/source-events/{q(event_id)}/review",
                body=payload,
            )
        )

    async def get(self, job_id: str) -> MigrationJob:
        return MigrationJob.model_validate(await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}"))

    async def refresh_source_session(self, job_id: str, payload: dict[str, Any]) -> MigrationJob:
        return MigrationJob.model_validate(
            await self._client.request("POST", f"/api/v1/migrations/{q(job_id)}/source-session", body=payload)
        )

    async def cancel(self, job_id: str) -> dict[str, Any]:
        return await self._client.request("DELETE", f"/api/v1/migrations/{q(job_id)}")

    async def list(self) -> list[MigrationJob]:
        return _models(await self._client.request("GET", "/api/v1/migrations"), MigrationJob)

    async def verification(self, job_id: str) -> VerificationReport:
        return VerificationReport.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/verification")
        )

    async def pilot_acceptance(self, job_id: str) -> PilotAcceptanceReport:
        return PilotAcceptanceReport.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/pilot-acceptance")
        )

    async def record_cutover_evidence(self, job_id: str, payload: dict[str, Any]) -> PilotAcceptanceReport:
        return PilotAcceptanceReport.model_validate(
            await self._client.request("PATCH", f"/api/v1/migrations/{q(job_id)}/cutover-evidence", body=payload)
        )

    async def rollback_rehearsal(self, job_id: str) -> RollbackRehearsalReport:
        return RollbackRehearsalReport.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/rollback-rehearsal")
        )

    async def automation_rebuilds(self, job_id: str) -> list[AutomationRebuildItem]:
        r = await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/automation-rebuilds")
        return _models(r.get("items", r), AutomationRebuildItem)

    async def update_automation_rebuild(self, job_id: str, item: dict[str, Any] | AutomationRebuildItem) -> AutomationRebuildItem:
        payload = item.model_dump(exclude_none=True) if isinstance(item, AutomationRebuildItem) else item
        return AutomationRebuildItem.model_validate(
            await self._client.request("PATCH", f"/api/v1/migrations/{q(job_id)}/automation-rebuilds", body=payload)
        )

    async def rollback(self, job_id: str) -> RollbackStartResponse:
        """Start an eligible rollback; use ``rollback_status`` to poll it."""
        return RollbackStartResponse.model_validate(
            await self._client.request("POST", f"/api/v1/migrations/{q(job_id)}/rollback")
        )

    async def rollback_status(self, job_id: str) -> RollbackProgress:
        return RollbackProgress.model_validate(
            await self._client.request("GET", f"/api/v1/migrations/{q(job_id)}/rollback-status")
        )

    async def list_sources(self) -> list[AdapterCapabilities]:
        return _models(await self._client.request("GET", "/api/v1/migrations/sources"), AdapterCapabilities)

    async def capabilities(self) -> list[AdapterCapabilities]:
        return _models(await self._client.request("GET", "/api/v1/migrations/capabilities"), AdapterCapabilities)
