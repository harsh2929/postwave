from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource
from ..errors import PostwaveError, ServerError

SmsSetupStatus = dict[str, Any]
SmsComplianceStatus = dict[str, Any]
SmsPilotReadiness = dict[str, Any]
SmsSenderPilotCertification = dict[str, Any]
SmsList = dict[str, Any]
SmsSenderProfile = dict[str, Any]
SmsA2PRegistrationResult = dict[str, Any]
SmsCampaign = dict[str, Any]
SmsCampaignReport = dict[str, Any]
SmsBroadcastResult = dict[str, Any]
SmsSuppressionRow = dict[str, Any]
SmsSuppressionsPage = dict[str, Any]

SMS_EVIDENCE_READ_RELEASE_HELD_CODE = "sms_evidence_read_release_held"
SMS_A2P_REGISTRATION_RELEASE_HELD_CODE = "sms_a2p_registration_release_held"
SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE = (
    "sms_registration_evidence_authority_required"
)
SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE = "sms_campaign_dispatch_release_held"
SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE = "sms_campaign_schedule_release_held"
SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE = "sms_campaign_resume_release_held"
SMS_TEST_DISPATCH_RELEASE_HELD_CODE = "sms_test_dispatch_release_held"
_SMS_CONSENT_KEYS = {"action", "list_id", "phone_e164", "proof_text", "source"}
_SMS_NANP_E164 = re.compile(r"^\+1[2-9][0-9]{2}[2-9][0-9]{6}$")
_SMS_UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_SMS_CANONICAL_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_SMS_RFC3339 = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$"
)
_SMS_SUPPRESSION_CURSOR = re.compile(r"^v1\.[A-Za-z0-9_-]+$")
_SMS_SUPPRESSION_REASONS = frozenset(
    {"manual", "stop_keyword", "help_keyword", "carrier_block", "complaint", "quiet_hours", "expired"}
)
_SMS_SUPPRESSION_SOURCES = frozenset(
    {"twilio", "telnyx", "bandwidth", "manual", "api", "import"}
)
_SMS_SUPPRESSION_LOCK = "carrier_or_system_authority"
_SMS_SUPPRESSION_KEYS = {
    "id", "phone_e164", "reason", "source", "created_at", "reversible", "locked_reason"
}
_SMS_SUPPRESSION_PAGE_KEYS = {"tenantId", "items", "total", "nextCursor", "snapshotAt"}


def _suppression_contract_error() -> PostwaveError:
    return PostwaveError(
        "Invalid SMS suppression response.",
        status=502,
        code="invalid_sms_suppression_response",
    )


def _strict_sms_text(value: Any, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or value.strip() != value
        or any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value)
    ):
        raise _suppression_contract_error()
    return value


def _strict_sms_timestamp(value: Any) -> str:
    text = _strict_sms_text(value, 64)
    match = _SMS_RFC3339.fullmatch(text)
    if match is None:
        raise _suppression_contract_error()
    if int(match[1]) < 2000 or int(match[1]) >= 2100 or int(match[7] or 0) > 14 or (
        int(match[7] or 0) == 14 and int(match[8] or 0) != 0
    ) or int(match[8] or 0) > 59:
        raise _suppression_contract_error()
    try:
        # Python accepts at most microseconds; use the calendar portion to
        # validate RFC3339Nano without truncating the returned wire value.
        datetime.fromisoformat(f"{match[1]}-{match[2]}-{match[3]}T{match[4]}:{match[5]}:{match[6]}+00:00")
        normalized = re.sub(r"(\.\d{6})\d+", r"\1", text).replace("Z", "+00:00")
        instant = datetime.fromisoformat(normalized).astimezone(timezone.utc)
        if not (
            datetime(2000, 1, 1, tzinfo=timezone.utc)
            <= instant
            < datetime(2100, 1, 1, tzinfo=timezone.utc)
        ):
            raise ValueError("timestamp instant outside projection range")
    except ValueError as error:
        raise _suppression_contract_error() from error
    return text


def _decode_sms_suppression_row(value: Any) -> SmsSuppressionRow:
    if not isinstance(value, dict) or any(key not in _SMS_SUPPRESSION_KEYS for key in value):
        raise _suppression_contract_error()
    row_id = _strict_sms_text(value.get("id"), 36)
    phone = _strict_sms_text(value.get("phone_e164"), 16)
    reason = _strict_sms_text(value.get("reason"), 128)
    source = _strict_sms_text(value.get("source"), 128)
    created_at = _strict_sms_timestamp(value.get("created_at"))
    reversible = value.get("reversible")
    locked = value.get("locked_reason")
    if locked is not None:
        locked = _strict_sms_text(locked, 256)
    if (
        _SMS_UUID_V4.fullmatch(row_id) is None
        or _SMS_NANP_E164.fullmatch(phone) is None
        or reason not in _SMS_SUPPRESSION_REASONS
        or source not in _SMS_SUPPRESSION_SOURCES
        or not isinstance(reversible, bool)
        or reversible != (reason == "manual" and source == "manual")
        or (reversible and "locked_reason" in value)
        or (not reversible and locked != _SMS_SUPPRESSION_LOCK)
    ):
        raise _suppression_contract_error()
    return {
        "id": row_id,
        "phone_e164": phone,
        "reason": reason,
        "source": source,
        "created_at": created_at,
        "reversible": reversible,
        **({"locked_reason": locked} if locked is not None else {}),
    }


def _decode_sms_suppressions_page(
    value: Any,
    *,
    expected_tenant_id: str,
    expected_limit: int,
    expected_reason: str | None = None,
    expected_phone: str | None = None,
) -> SmsSuppressionsPage:
    if (
        not isinstance(value, dict)
        or any(key not in _SMS_SUPPRESSION_PAGE_KEYS for key in value)
        or not isinstance(value.get("items"), list)
        or len(value["items"]) > expected_limit
    ):
        raise _suppression_contract_error()
    tenant_id = _strict_sms_text(value.get("tenantId"), 36)
    if _SMS_CANONICAL_UUID.fullmatch(tenant_id) is None:
        raise _suppression_contract_error()
    if (
        _SMS_CANONICAL_UUID.fullmatch(expected_tenant_id) is None
        or tenant_id != expected_tenant_id
    ):
        raise _suppression_contract_error()
    total = value.get("total")
    if isinstance(total, bool) or not isinstance(total, int) or total < len(value["items"]):
        raise _suppression_contract_error()
    snapshot_at = _strict_sms_timestamp(value.get("snapshotAt"))
    next_cursor = value.get("nextCursor")
    if next_cursor is not None:
        next_cursor = _strict_sms_text(next_cursor, 4096)
        if _SMS_SUPPRESSION_CURSOR.fullmatch(next_cursor) is None:
            raise _suppression_contract_error()
    items = [_decode_sms_suppression_row(row) for row in value["items"]]
    seen_ids: set[str] = set()
    seen_phones: set[str] = set()
    prior: tuple[float, str] | None = None
    snapshot_time = datetime.fromisoformat(snapshot_at.replace("Z", "+00:00")).timestamp()
    for row in items:
        created_time = datetime.fromisoformat(
            re.sub(r"\.(\d{6})\d+", r".\1", row["created_at"]).replace("Z", "+00:00")
        ).timestamp()
        if (
            row["id"] in seen_ids
            or row["phone_e164"] in seen_phones
            or (expected_reason is not None and row["reason"] != expected_reason)
            or (expected_phone is not None and row["phone_e164"] != expected_phone)
            or created_time > snapshot_time
            or (prior is not None and (created_time > prior[0] or (created_time == prior[0] and row["id"] >= prior[1])))
        ):
            raise _suppression_contract_error()
        seen_ids.add(row["id"])
        seen_phones.add(row["phone_e164"])
        prior = (created_time, row["id"])
    if next_cursor is not None and (total <= len(items) or len(items) != expected_limit):
        raise _suppression_contract_error()
    if expected_phone is not None and (total > 1 or next_cursor is not None):
        raise _suppression_contract_error()
    return {
        "tenantId": tenant_id,
        "items": items,
        "total": total,
        "snapshotAt": snapshot_at,
        **({"nextCursor": next_cursor} if next_cursor is not None else {}),
    }


def _sms_suppression_list_input(
    *, reason: str | None, phone: str | None, cursor: str | None, limit: int
) -> dict[str, Any]:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 200:
        raise ValueError("SMS suppression limit must be an integer from 1 to 200")
    if reason is not None and reason not in _SMS_SUPPRESSION_REASONS:
        raise ValueError("SMS suppression reason is unsupported")
    if phone is not None and _SMS_NANP_E164.fullmatch(phone) is None:
        raise ValueError("SMS suppression phone must be canonical US/Canada E.164")
    if cursor is not None:
        try:
            _strict_sms_text(cursor, 4096)
        except PostwaveError as error:
            raise ValueError("SMS suppression cursor is invalid") from error
        if _SMS_SUPPRESSION_CURSOR.fullmatch(cursor) is None:
            raise ValueError("SMS suppression cursor is invalid")
    if phone is not None and cursor is not None:
        raise ValueError("Exact SMS suppression lookup cannot continue a cursor")
    return {
        "limit": limit,
        **({"reason": reason} if reason is not None else {}),
        **({"phone": phone} if phone is not None else {}),
        **({"cursor": cursor} if cursor is not None else {}),
    }


def _sms_evidence_read_release_held() -> ServerError:
    return ServerError(
        "Confidential SMS evidence reads are release-held until the audited bounded contract is available.",
        status=503,
        code=SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
    )


def _sms_operation_release_held(code: str, operation: str) -> ServerError:
    return ServerError(
        f"{operation} is release-held until its durable provider and reconciliation contract is available.",
        status=503,
        code=code,
    )


def _sms_consent_error(status: int, code: str, message: str) -> PostwaveError:
    return PostwaveError(message, status=status, code=code)


def _validated_sms_sender_input(payload: dict[str, Any]) -> dict[str, Any]:
    has_private_evidence = (
        "brand_registration_sid" in payload
        or "campaign_registration_sid" in payload
    )
    has_status = "registration_status" in payload
    status = payload.get("registration_status")
    if has_private_evidence or (
        has_status and status not in {"", "not_started", "draft"}
    ):
        raise PostwaveError(
            "Caller-supplied SMS registration evidence and provider-certified status are unavailable.",
            status=409,
            code=SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE,
        )
    return payload


def _validated_sms_campaign_draft_input(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("status") == "scheduled" or "scheduled_at" in payload:
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE, "SMS campaign scheduling"
        )
    return payload


def _validated_sms_consent_revocation(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise _sms_consent_error(
            400,
            "invalid_consent_request",
            "SMS consent input must be an operator revocation object.",
        )
    action = payload.get("action")
    if action == "granted":
        raise _sms_consent_error(
            409,
            "carrier_resubscribe_authority_required",
            "Only a verified provider START or UNSTOP event may restore SMS consent.",
        )
    if action != "revoked":
        raise _sms_consent_error(
            400,
            "invalid_consent_action",
            "The operator SMS consent endpoint accepts only action=revoked.",
        )
    if payload.get("source") != "manual" or any(
        key not in _SMS_CONSENT_KEYS for key in payload
    ):
        raise _sms_consent_error(
            400,
            "invalid_consent_request",
            "Operator SMS revocations require source=manual and no provider or subscriber evidence fields.",
        )
    phone = payload.get("phone_e164")
    if not isinstance(phone, str) or _SMS_NANP_E164.fullmatch(phone) is None:
        raise _sms_consent_error(
            400,
            "invalid_phone",
            "phone_e164 must be a canonical US/Canada number.",
        )
    reason = payload.get("proof_text")
    if not isinstance(reason, str):
        reason = ""
    reason = reason.strip()
    if (
        not reason
        or len(reason) > 500
        or any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in reason)
    ):
        raise _sms_consent_error(
            400,
            "consent_reason_required",
            "proof_text must contain a safe operator revocation reason of at most 500 Unicode code points.",
        )
    list_id = payload.get("list_id")
    if list_id is not None and (
        not isinstance(list_id, str) or _SMS_UUID_V4.fullmatch(list_id) is None
    ):
        raise _sms_consent_error(
            400,
            "invalid_list_id",
            "list_id must be a canonical lowercase UUIDv4.",
        )
    return {
        **({"list_id": list_id} if isinstance(list_id, str) else {}),
        "phone_e164": phone,
        "action": "revoked",
        "source": "manual",
        "proof_text": reason,
    }


def q(value: str) -> str:
    return quote(value, safe="")


class SmsResource(SyncResource):
    def setup(self) -> SmsSetupStatus:
        return self._client.request("GET", "/api/v1/sms/setup")

    def compliance(self) -> SmsComplianceStatus:
        return self._client.request("GET", "/api/v1/sms/compliance")

    def pilot_readiness(self) -> SmsPilotReadiness:
        return self._client.request("GET", "/api/v1/sms/pilot-readiness")

    def sender_pilot_certification(self, sender_id: str) -> SmsSenderPilotCertification:
        return self._client.request("GET", f"/api/v1/sms/senders/{q(sender_id)}/pilot-certification")

    def list_lists(self) -> dict[str, list[SmsList]]:
        return self._client.request("GET", "/api/v1/sms/lists")

    def create_list(self, payload: dict[str, Any]) -> SmsList:
        return self._client.request("POST", "/api/v1/sms/lists", body=payload)

    def list_senders(self) -> dict[str, list[SmsSenderProfile]]:
        return self._client.request("GET", "/api/v1/sms/senders")

    def upsert_sender(self, payload: dict[str, Any]) -> SmsSenderProfile:
        return self._client.request(
            "POST", "/api/v1/sms/senders", body=_validated_sms_sender_input(payload)
        )

    def pause_sender(self, sender_id: str, *, reason: str | None = None) -> SmsSenderProfile:
        return self._client.request("POST", f"/api/v1/sms/senders/{q(sender_id)}/pause", body={"reason": reason})

    def resume_sender(self, sender_id: str) -> SmsSenderProfile:
        return self._client.request("POST", f"/api/v1/sms/senders/{q(sender_id)}/resume", body={})

    def submit_brand_registration(self, sender_id: str, payload: dict[str, Any]) -> SmsA2PRegistrationResult:
        del sender_id, payload
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    def submit_campaign_registration(self, sender_id: str, payload: dict[str, Any]) -> SmsA2PRegistrationResult:
        del sender_id, payload
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    def poll_a2p_registration(self, sender_id: str) -> SmsA2PRegistrationResult:
        del sender_id
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    def record_consent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._client.request(
            "POST",
            "/api/v1/sms/consent",
            body=_validated_sms_consent_revocation(payload),
        )

    def list_suppressions(
        self,
        *,
        reason: str | None = None,
        phone: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        tenant_id: str | None = None,
    ) -> SmsSuppressionsPage:
        """Return one exact-admin response-cutoff page; continuation is explicit."""
        expected_tenant = tenant_id or (
            self._client.tenant_id
            if isinstance(self._client.tenant_id, str)
            and _SMS_CANONICAL_UUID.fullmatch(self._client.tenant_id)
            else None
        )
        if tenant_id is not None and _SMS_CANONICAL_UUID.fullmatch(tenant_id) is None:
            raise ValueError("SMS suppression tenant_id must be a canonical lowercase UUID")
        if expected_tenant is None:
            raise ValueError(
                "SMS suppression listing requires an expected canonical tenant UUID"
            )
        if phone is not None and cursor is not None:
            raise ValueError("Exact SMS suppression lookup cannot continue a cursor")
        if phone is not None and limit is not None:
            raise ValueError("Exact SMS suppression lookup does not accept a limit")
        effective_limit = 100 if limit is None else limit
        request = _sms_suppression_list_input(
            reason=reason, phone=phone, cursor=cursor, limit=effective_limit
        )
        raw = self._client.request(
            "POST" if phone is not None else "GET",
            "/api/v1/sms/suppressions/query" if phone is not None else "/api/v1/sms/suppressions",
            **(
                {
                    "body": {"phone": phone, **({"reason": reason} if reason is not None else {})},
                    "idempotency_key": None,
                }
                if phone is not None
                else {"query": request}
            ),
        )
        return _decode_sms_suppressions_page(
            raw,
            expected_tenant_id=expected_tenant,
            expected_limit=1 if phone is not None else effective_limit,
            expected_reason=reason,
            expected_phone=phone,
        )

    def add_suppression(self, *, phone: str, reason: str = "manual") -> SmsSuppressionRow:
        if _SMS_NANP_E164.fullmatch(phone) is None or reason != "manual":
            raise ValueError(
                "SMS suppression add requires canonical US/Canada E.164 and reason=manual"
            )
        row = _decode_sms_suppression_row(
            self._client.request(
                "POST", "/api/v1/sms/suppressions", body={"phone": phone, "reason": "manual"}
            )
        )
        if row["phone_e164"] != phone or not row["reversible"]:
            raise _suppression_contract_error()
        return row

    def remove_suppression(
        self, suppression_id: str, *, tenant_id: str | None = None
    ) -> dict[str, Any]:
        if _SMS_UUID_V4.fullmatch(suppression_id) is None:
            raise ValueError("SMS suppression id must be a canonical lowercase UUIDv4")
        expected_tenant = tenant_id or (
            self._client.tenant_id
            if isinstance(self._client.tenant_id, str)
            and _SMS_CANONICAL_UUID.fullmatch(self._client.tenant_id)
            else None
        )
        if expected_tenant is None or _SMS_CANONICAL_UUID.fullmatch(expected_tenant) is None:
            raise ValueError("SMS suppression removal requires an expected canonical tenant UUID")
        raw = self._client.request(
            "DELETE", f"/api/v1/sms/suppressions/{q(suppression_id)}"
        )
        if (
            not isinstance(raw, dict)
            or set(raw) != {"ok", "tenantId", "id"}
            or raw["ok"] is not True
            or raw["tenantId"] != expected_tenant
            or raw["id"] != suppression_id
        ):
            raise _suppression_contract_error()
        return {"ok": True, "tenantId": expected_tenant, "id": suppression_id}

    def list_campaigns(self) -> dict[str, list[SmsCampaign]]:
        return self._client.request("GET", "/api/v1/sms/campaigns")

    def get_campaign(self, campaign_id: str) -> SmsCampaign:
        return self._client.request("GET", f"/api/v1/sms/campaigns/{q(campaign_id)}")

    def create_campaign(self, payload: dict[str, Any]) -> SmsCampaign:
        return self._client.request(
            "POST",
            "/api/v1/sms/campaigns",
            body=_validated_sms_campaign_draft_input(payload),
        )

    def campaign_report(self, campaign_id: str) -> SmsCampaignReport:
        del campaign_id
        raise _sms_evidence_read_release_held()

    def export_campaign_report(
        self,
        campaign_id: str,
        *,
        status: str | None = None,
        limit: int | None = None,
    ) -> str:
        del campaign_id, status, limit
        raise _sms_evidence_read_release_held()

    def send_campaign(self, campaign_id: str, payload: dict[str, Any] | None = None) -> SmsBroadcastResult:
        del campaign_id, payload
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE, "SMS campaign dispatch"
        )

    def schedule_campaign(self, campaign_id: str, scheduled_at: str) -> SmsCampaign:
        del campaign_id, scheduled_at
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE, "SMS campaign scheduling"
        )

    def pause_campaign(self, campaign_id: str) -> SmsCampaign:
        return self._client.request("POST", f"/api/v1/sms/campaigns/{q(campaign_id)}/pause", body={})

    def resume_campaign(self, campaign_id: str) -> SmsCampaign:
        del campaign_id
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE, "SMS campaign resume"
        )

    def cancel_campaign(self, campaign_id: str) -> SmsCampaign:
        return self._client.request("POST", f"/api/v1/sms/campaigns/{q(campaign_id)}/cancel", body={})

    def send_test(self, payload: dict[str, Any]) -> dict[str, Any]:
        del payload
        raise _sms_operation_release_held(
            SMS_TEST_DISPATCH_RELEASE_HELD_CODE, "SMS test dispatch"
        )


class AsyncSmsResource(AsyncResource):
    async def setup(self) -> SmsSetupStatus:
        return await self._client.request("GET", "/api/v1/sms/setup")

    async def compliance(self) -> SmsComplianceStatus:
        return await self._client.request("GET", "/api/v1/sms/compliance")

    async def pilot_readiness(self) -> SmsPilotReadiness:
        return await self._client.request("GET", "/api/v1/sms/pilot-readiness")

    async def sender_pilot_certification(self, sender_id: str) -> SmsSenderPilotCertification:
        return await self._client.request("GET", f"/api/v1/sms/senders/{q(sender_id)}/pilot-certification")

    async def list_lists(self) -> dict[str, list[SmsList]]:
        return await self._client.request("GET", "/api/v1/sms/lists")

    async def create_list(self, payload: dict[str, Any]) -> SmsList:
        return await self._client.request("POST", "/api/v1/sms/lists", body=payload)

    async def list_senders(self) -> dict[str, list[SmsSenderProfile]]:
        return await self._client.request("GET", "/api/v1/sms/senders")

    async def upsert_sender(self, payload: dict[str, Any]) -> SmsSenderProfile:
        return await self._client.request(
            "POST", "/api/v1/sms/senders", body=_validated_sms_sender_input(payload)
        )

    async def pause_sender(self, sender_id: str, *, reason: str | None = None) -> SmsSenderProfile:
        return await self._client.request("POST", f"/api/v1/sms/senders/{q(sender_id)}/pause", body={"reason": reason})

    async def resume_sender(self, sender_id: str) -> SmsSenderProfile:
        return await self._client.request("POST", f"/api/v1/sms/senders/{q(sender_id)}/resume", body={})

    async def submit_brand_registration(self, sender_id: str, payload: dict[str, Any]) -> SmsA2PRegistrationResult:
        del sender_id, payload
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    async def submit_campaign_registration(self, sender_id: str, payload: dict[str, Any]) -> SmsA2PRegistrationResult:
        del sender_id, payload
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    async def poll_a2p_registration(self, sender_id: str) -> SmsA2PRegistrationResult:
        del sender_id
        raise _sms_operation_release_held(
            SMS_A2P_REGISTRATION_RELEASE_HELD_CODE, "SMS A2P registration"
        )

    async def record_consent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request(
            "POST",
            "/api/v1/sms/consent",
            body=_validated_sms_consent_revocation(payload),
        )

    async def list_suppressions(
        self,
        *,
        reason: str | None = None,
        phone: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        tenant_id: str | None = None,
    ) -> SmsSuppressionsPage:
        """Return one exact-admin response-cutoff page; continuation is explicit."""
        expected_tenant = tenant_id or (
            self._client.tenant_id
            if isinstance(self._client.tenant_id, str)
            and _SMS_CANONICAL_UUID.fullmatch(self._client.tenant_id)
            else None
        )
        if tenant_id is not None and _SMS_CANONICAL_UUID.fullmatch(tenant_id) is None:
            raise ValueError("SMS suppression tenant_id must be a canonical lowercase UUID")
        if expected_tenant is None:
            raise ValueError(
                "SMS suppression listing requires an expected canonical tenant UUID"
            )
        if phone is not None and limit is not None:
            raise ValueError("Exact SMS suppression lookup does not accept a limit")
        effective_limit = 100 if limit is None else limit
        request = _sms_suppression_list_input(
            reason=reason, phone=phone, cursor=cursor, limit=effective_limit
        )
        raw = await self._client.request(
            "POST" if phone is not None else "GET",
            "/api/v1/sms/suppressions/query" if phone is not None else "/api/v1/sms/suppressions",
            **(
                {
                    "body": {"phone": phone, **({"reason": reason} if reason is not None else {})},
                    "idempotency_key": None,
                }
                if phone is not None
                else {"query": request}
            ),
        )
        return _decode_sms_suppressions_page(
            raw,
            expected_tenant_id=expected_tenant,
            expected_limit=1 if phone is not None else effective_limit,
            expected_reason=reason,
            expected_phone=phone,
        )

    async def add_suppression(self, *, phone: str, reason: str = "manual") -> SmsSuppressionRow:
        if _SMS_NANP_E164.fullmatch(phone) is None or reason != "manual":
            raise ValueError(
                "SMS suppression add requires canonical US/Canada E.164 and reason=manual"
            )
        row = _decode_sms_suppression_row(
            await self._client.request(
                "POST", "/api/v1/sms/suppressions", body={"phone": phone, "reason": "manual"}
            )
        )
        if row["phone_e164"] != phone or not row["reversible"]:
            raise _suppression_contract_error()
        return row

    async def remove_suppression(
        self, suppression_id: str, *, tenant_id: str | None = None
    ) -> dict[str, Any]:
        if _SMS_UUID_V4.fullmatch(suppression_id) is None:
            raise ValueError("SMS suppression id must be a canonical lowercase UUIDv4")
        expected_tenant = tenant_id or (
            self._client.tenant_id
            if isinstance(self._client.tenant_id, str)
            and _SMS_CANONICAL_UUID.fullmatch(self._client.tenant_id)
            else None
        )
        if expected_tenant is None or _SMS_CANONICAL_UUID.fullmatch(expected_tenant) is None:
            raise ValueError("SMS suppression removal requires an expected canonical tenant UUID")
        raw = await self._client.request(
            "DELETE", f"/api/v1/sms/suppressions/{q(suppression_id)}"
        )
        if (
            not isinstance(raw, dict)
            or set(raw) != {"ok", "tenantId", "id"}
            or raw["ok"] is not True
            or raw["tenantId"] != expected_tenant
            or raw["id"] != suppression_id
        ):
            raise _suppression_contract_error()
        return {"ok": True, "tenantId": expected_tenant, "id": suppression_id}

    async def list_campaigns(self) -> dict[str, list[SmsCampaign]]:
        return await self._client.request("GET", "/api/v1/sms/campaigns")

    async def get_campaign(self, campaign_id: str) -> SmsCampaign:
        return await self._client.request("GET", f"/api/v1/sms/campaigns/{q(campaign_id)}")

    async def create_campaign(self, payload: dict[str, Any]) -> SmsCampaign:
        return await self._client.request(
            "POST",
            "/api/v1/sms/campaigns",
            body=_validated_sms_campaign_draft_input(payload),
        )

    async def campaign_report(self, campaign_id: str) -> SmsCampaignReport:
        del campaign_id
        raise _sms_evidence_read_release_held()

    async def export_campaign_report(
        self,
        campaign_id: str,
        *,
        status: str | None = None,
        limit: int | None = None,
    ) -> str:
        del campaign_id, status, limit
        raise _sms_evidence_read_release_held()

    async def send_campaign(self, campaign_id: str, payload: dict[str, Any] | None = None) -> SmsBroadcastResult:
        del campaign_id, payload
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE, "SMS campaign dispatch"
        )

    async def schedule_campaign(self, campaign_id: str, scheduled_at: str) -> SmsCampaign:
        del campaign_id, scheduled_at
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE, "SMS campaign scheduling"
        )

    async def pause_campaign(self, campaign_id: str) -> SmsCampaign:
        return await self._client.request("POST", f"/api/v1/sms/campaigns/{q(campaign_id)}/pause", body={})

    async def resume_campaign(self, campaign_id: str) -> SmsCampaign:
        del campaign_id
        raise _sms_operation_release_held(
            SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE, "SMS campaign resume"
        )

    async def cancel_campaign(self, campaign_id: str) -> SmsCampaign:
        return await self._client.request("POST", f"/api/v1/sms/campaigns/{q(campaign_id)}/cancel", body={})

    async def send_test(self, payload: dict[str, Any]) -> dict[str, Any]:
        del payload
        raise _sms_operation_release_held(
            SMS_TEST_DISPATCH_RELEASE_HELD_CODE, "SMS test dispatch"
        )
