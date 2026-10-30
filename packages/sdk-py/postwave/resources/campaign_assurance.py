"""Campaign Assurance receipts, decisions, and stored-patch applications."""

from __future__ import annotations

import re
from typing import Any, TypeVar, cast
from urllib.parse import quote

from pydantic import BaseModel

from ..types.assurance import (
    CampaignAssuranceAppealInput,
    CampaignAssuranceApplyFindingInput,
    CampaignAssuranceApplyFindingResult,
    CampaignAssuranceEnvelope,
    CampaignAssuranceEvidence,
    CampaignAssuranceLatest,
    CampaignAssuranceManifest,
    CampaignAssuranceOverride,
    CampaignAssuranceProgressSnapshot,
    CampaignAssuranceRun,
    CampaignAssuranceRunDetail,
    CampaignAssuranceStartRun,
    CreateCampaignAssuranceRunInput,
    FactContractV1,
    SetFactContractResult,
)
from ._base import AsyncResource, SyncResource


def _segment(value: str) -> str:
    return quote(value, safe="")


def _body(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    return value


def _apply_body(
    value: CampaignAssuranceApplyFindingInput | dict[str, Any],
) -> dict[str, Any]:
    body = _body(value)
    if not isinstance(body, dict):
        raise ValueError("Campaign Assurance apply payload must be an object")
    # Project the one-field public contract so an untyped dict cannot smuggle
    # caller-authored patch instructions into the request.
    return {"request_id": body.get("request_id")}


def _fact_contract_body(value: FactContractV1 | dict[str, Any]) -> dict[str, Any]:
    body = _body(value)
    if not isinstance(body, dict):
        raise ValueError("Fact Contract payload must be an object")
    if not body:
        return {}
    return FactContractV1.model_validate(body).model_dump(
        mode="json", by_alias=True, exclude_none=True
    )


_OBSERVED_SURFACE = re.compile(r"^[A-Za-z0-9._:-]+$")


def _create_run_body(
    value: CreateCampaignAssuranceRunInput | dict[str, Any],
) -> dict[str, Any]:
    body = _body(value)
    if not isinstance(body, dict):
        raise ValueError("Campaign Assurance run payload must be an object")
    if "observed_surfaces" in body and not body.get("include_seed_test"):
        raise ValueError("observed_surfaces require include_seed_test=true")
    surfaces = body.get("observed_surfaces", [])
    if not isinstance(surfaces, list) or len(surfaces) > 32:
        raise ValueError("observed_surfaces must contain at most 32 identifiers")
    if any(
        not isinstance(surface, str)
        or len(surface.encode("utf-8")) > 128
        or _OBSERVED_SURFACE.fullmatch(surface) is None
        for surface in surfaces
    ) or len(set(surfaces)) != len(surfaces):
        raise ValueError(
            "observed_surfaces must be unique stable 1-128 byte identifiers"
        )
    return body


def _idempotency_kwargs(value: str | None) -> dict[str, str]:
    # Omitting the argument preserves the client's AUTO behavior: one UUID is
    # minted per logical call and reused across transport retries.
    if value is None:
        return {}
    if (
        not value
        or len(value.encode("utf-8")) > 255
        or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value)
    ):
        raise ValueError(
            "idempotency_key must be 1-255 UTF-8 bytes without control characters"
        )
    return {"idempotency_key": value}


def _if_match(value: str) -> str:
    if (
        value != value.strip()
        or len(value.encode("utf-8")) < 3
        or len(value.encode("utf-8")) > 512
        or value == "*"
        or value.startswith("W/")
        or "," in value
        or not value.startswith('"')
        or not value.endswith('"')
        or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value)
    ):
        raise ValueError(
            "if_match must be the exact strong campaign ETag returned by the API"
        )
    return value


T = TypeVar("T", bound=BaseModel)


def _envelope(value: Any, model: type[T]) -> CampaignAssuranceEnvelope[T]:
    envelope = CampaignAssuranceEnvelope[Any].model_validate(value)
    envelope.data = model.model_validate(envelope.data)
    return cast(CampaignAssuranceEnvelope[T], envelope)


def _run_path(campaign_id: str, run_id: str) -> str:
    return (
        f"/api/v1/campaigns/{_segment(campaign_id)}"
        f"/assurance-runs/{_segment(run_id)}"
    )


def _finding_path(campaign_id: str, run_id: str, finding_id: str) -> str:
    return f"{_run_path(campaign_id, run_id)}/findings/{_segment(finding_id)}"


class CampaignAssuranceResource(SyncResource):
    """Tenant-scoped assurance API.

    Reads require ``read:campaigns``. Creation/cancellation require
    ``write:campaigns``. Applying a stored patch also requires an editor and
    an exact strong campaign ETag. Appeals require ``write:campaigns`` plus
    ``send:transactional`` and a tenant-bound owner/admin actor.
    """

    def set_fact_contract(
        self,
        campaign_id: str,
        payload: FactContractV1 | dict[str, Any],
        *,
        if_match: str,
        idempotency_key: str | None = None,
    ) -> SetFactContractResult:
        """Replace the complete mutable Fact Contract and return its next ETag."""
        response_etag = ""

        def capture(headers: Any) -> None:
            nonlocal response_etag
            response_etag = headers.get("etag", "")

        campaign = self._client.request(
            "PUT",
            f"/api/v1/campaigns/{_segment(campaign_id)}/fact-contract",
            body=_fact_contract_body(payload),
            headers={"If-Match": _if_match(if_match)},
            on_response_headers=capture,
            **_idempotency_kwargs(idempotency_key),
        )
        try:
            next_etag = _if_match(response_etag)
        except ValueError as error:
            raise ValueError(
                "set_fact_contract response did not include a valid strong campaign ETag"
            ) from error
        if not isinstance(campaign, dict):
            raise ValueError("set_fact_contract response campaign must be an object")
        return SetFactContractResult(campaign=campaign, etag=next_etag)

    def create_run(
        self,
        campaign_id: str,
        payload: CreateCampaignAssuranceRunInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceStartRun]:
        value = self._client.request(
            "POST",
            f"/api/v1/campaigns/{_segment(campaign_id)}/assurance-runs",
            body=_create_run_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceStartRun)

    def get_latest(
        self, campaign_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceLatest]:
        value = self._client.request(
            "GET", f"/api/v1/campaigns/{_segment(campaign_id)}/assurance"
        )
        return _envelope(value, CampaignAssuranceLatest)

    def get_run(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceRunDetail]:
        return _envelope(
            self._client.request("GET", _run_path(campaign_id, run_id)),
            CampaignAssuranceRunDetail,
        )

    def get_manifest(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceManifest]:
        return _envelope(
            self._client.request("GET", f"{_run_path(campaign_id, run_id)}/manifest"),
            CampaignAssuranceManifest,
        )

    def get_evidence(
        self,
        campaign_id: str,
        run_id: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceEvidence]:
        value = self._client.request(
            "GET",
            f"{_run_path(campaign_id, run_id)}/evidence",
            query={"limit": limit, "offset": offset},
        )
        return _envelope(value, CampaignAssuranceEvidence)

    def get_events(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceProgressSnapshot]:
        """Return the aggregate snapshot; durable event history is unavailable."""
        return _envelope(
            self._client.request("GET", f"{_run_path(campaign_id, run_id)}/events"),
            CampaignAssuranceProgressSnapshot,
        )

    def appeal_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceAppealInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceOverride]:
        value = self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/appeals",
            body=_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceOverride)

    def override_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceAppealInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceOverride]:
        """Compatibility spelling for the same governed decision contract."""
        value = self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/overrides",
            body=_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceOverride)

    def apply_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceApplyFindingInput | dict[str, Any],
        *,
        if_match: str,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceApplyFindingResult]:
        """Apply only the stored deterministic patch as a new revision."""
        value = self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/apply",
            body=_apply_body(payload),
            headers={"If-Match": _if_match(if_match)},
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceApplyFindingResult)

    def cancel_run(
        self,
        campaign_id: str,
        run_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceRun]:
        value = self._client.request(
            "POST",
            f"{_run_path(campaign_id, run_id)}/cancel",
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceRun)


class AsyncCampaignAssuranceResource(AsyncResource):
    async def set_fact_contract(
        self,
        campaign_id: str,
        payload: FactContractV1 | dict[str, Any],
        *,
        if_match: str,
        idempotency_key: str | None = None,
    ) -> SetFactContractResult:
        response_etag = ""

        def capture(headers: Any) -> None:
            nonlocal response_etag
            response_etag = headers.get("etag", "")

        campaign = await self._client.request(
            "PUT",
            f"/api/v1/campaigns/{_segment(campaign_id)}/fact-contract",
            body=_fact_contract_body(payload),
            headers={"If-Match": _if_match(if_match)},
            on_response_headers=capture,
            **_idempotency_kwargs(idempotency_key),
        )
        try:
            next_etag = _if_match(response_etag)
        except ValueError as error:
            raise ValueError(
                "set_fact_contract response did not include a valid strong campaign ETag"
            ) from error
        if not isinstance(campaign, dict):
            raise ValueError("set_fact_contract response campaign must be an object")
        return SetFactContractResult(campaign=campaign, etag=next_etag)

    async def create_run(
        self,
        campaign_id: str,
        payload: CreateCampaignAssuranceRunInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceStartRun]:
        value = await self._client.request(
            "POST",
            f"/api/v1/campaigns/{_segment(campaign_id)}/assurance-runs",
            body=_create_run_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceStartRun)

    async def get_latest(
        self, campaign_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceLatest]:
        value = await self._client.request(
            "GET", f"/api/v1/campaigns/{_segment(campaign_id)}/assurance"
        )
        return _envelope(value, CampaignAssuranceLatest)

    async def get_run(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceRunDetail]:
        return _envelope(
            await self._client.request("GET", _run_path(campaign_id, run_id)),
            CampaignAssuranceRunDetail,
        )

    async def get_manifest(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceManifest]:
        return _envelope(
            await self._client.request(
                "GET", f"{_run_path(campaign_id, run_id)}/manifest"
            ),
            CampaignAssuranceManifest,
        )

    async def get_evidence(
        self,
        campaign_id: str,
        run_id: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceEvidence]:
        value = await self._client.request(
            "GET",
            f"{_run_path(campaign_id, run_id)}/evidence",
            query={"limit": limit, "offset": offset},
        )
        return _envelope(value, CampaignAssuranceEvidence)

    async def get_events(
        self, campaign_id: str, run_id: str
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceProgressSnapshot]:
        """Return the aggregate snapshot; durable event history is unavailable."""
        return _envelope(
            await self._client.request(
                "GET", f"{_run_path(campaign_id, run_id)}/events"
            ),
            CampaignAssuranceProgressSnapshot,
        )

    async def appeal_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceAppealInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceOverride]:
        value = await self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/appeals",
            body=_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceOverride)

    async def override_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceAppealInput | dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceOverride]:
        value = await self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/overrides",
            body=_body(payload),
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceOverride)

    async def apply_finding(
        self,
        campaign_id: str,
        run_id: str,
        finding_id: str,
        payload: CampaignAssuranceApplyFindingInput | dict[str, Any],
        *,
        if_match: str,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceApplyFindingResult]:
        """Apply only the stored deterministic patch as a new revision."""
        value = await self._client.request(
            "POST",
            f"{_finding_path(campaign_id, run_id, finding_id)}/apply",
            body=_apply_body(payload),
            headers={"If-Match": _if_match(if_match)},
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceApplyFindingResult)

    async def cancel_run(
        self,
        campaign_id: str,
        run_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> CampaignAssuranceEnvelope[CampaignAssuranceRun]:
        value = await self._client.request(
            "POST",
            f"{_run_path(campaign_id, run_id)}/cancel",
            **_idempotency_kwargs(idempotency_key),
        )
        return _envelope(value, CampaignAssuranceRun)
