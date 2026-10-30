from __future__ import annotations

import json

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave
from postwave.types.assurance import CreateCampaignAssuranceRunInput, FactContractV1


CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111"
RUN_ID = "22222222-2222-4222-8222-222222222222"
FINDING_ID = "33333333-3333-4333-8333-333333333333"
REVISION_ID = "44444444-4444-4444-8444-444444444444"
PLAN_ID = "55555555-5555-4555-8555-555555555555"
REQUEST_ID = "66666666-6666-4666-8666-666666666666"
NOW = "2026-08-09T00:00:00Z"
HASH = "a" * 64


def _fact_contract() -> FactContractV1:
    return FactContractV1.model_validate(
        {
            "schema_version": 1,
            "primary_intent": {
                "kind": "invite",
                "statement": "Invite customers",
            },
            "audience_context": {"description": "Existing Pro customers"},
            "core_claim": {"statement": "The webinar demonstrates automation"},
            "primary_action": {
                "action_id": "register",
                "block_id": "cta",
                "role": "register",
                "label": "Reserve my seat",
                "canonical_url": "https://example.test/events/launch",
            },
            "required_facts": [],
            "forbidden_claims": [],
            "allowed_secondary_actions": ["unsubscribe"],
            "language": "en-IN",
        }
    )


def test_sync_set_fact_contract_returns_next_etag_and_exact_request() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            headers={"etag": '"campaign-next-version"'},
            json={"id": CAMPAIGN_ID, "status": "draft"},
        )

    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = Moosewave(
        api_key="pw_assurance",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    result = client.campaign_assurance.set_fact_contract(
        CAMPAIGN_ID,
        _fact_contract(),
        if_match='"campaign-reviewed-version"',
        idempotency_key="fact-contract-set",
    )

    assert result.campaign["id"] == CAMPAIGN_ID
    assert result.etag == '"campaign-next-version"'
    assert len(seen) == 1
    assert seen[0].method == "PUT"
    assert seen[0].url.path.endswith(f"/campaigns/{CAMPAIGN_ID}/fact-contract")
    assert seen[0].headers["if-match"] == '"campaign-reviewed-version"'
    assert seen[0].headers["idempotency-key"] == "fact-contract-set"
    assert json.loads(seen[0].content) == _fact_contract().model_dump(
        mode="json", exclude_none=True
    )


def test_set_fact_contract_refuses_success_without_next_etag() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": CAMPAIGN_ID})

    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = Moosewave(
        api_key="pw_assurance",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    with pytest.raises(ValueError, match="did not include a valid strong campaign ETag"):
        client.campaign_assurance.set_fact_contract(
            CAMPAIGN_ID, {}, if_match='"campaign-reviewed-version"'
        )


def _measurement() -> dict:
    return {
        "name": "Predicted Agent Comprehension",
        "interpretation": "A prediction, not a private inbox-provider observation.",
        "source_classes": [
            {
                "class": "deterministic",
                "present": True,
                "meaning": "versioned rule-based analysis",
            },
            {
                "class": "modeled",
                "present": False,
                "meaning": "modeled prediction only",
            },
            {
                "class": "controlled_observation",
                "present": False,
                "meaning": "named controlled environment only",
            },
        ],
    }


def _run() -> dict:
    return {
        "id": RUN_ID,
        "campaign_id": CAMPAIGN_ID,
        "content_revision_id": REVISION_ID,
        "send_plan_id": PLAN_ID,
        "run_no": 1,
        "request_id": REQUEST_ID,
        "request_hash": HASH,
        "trigger_kind": "explicit",
        "profile": "full",
        "state": "running",
        "source_hash": HASH,
        "plan_hash": HASH,
        "artifact_set_hash": HASH,
        "coverage_manifest_hash": HASH,
        "configuration_manifest_hash": HASH,
        "target_manifest_hash": HASH,
        "renderer_version": "renderer.v1",
        "compiler_version": "compiler.v1",
        "fixture_set_version": "fixtures.v1",
        "plan_policy_version": "plan.v1",
        "analyzer_suite_version": "analyzer.v1",
        "model_suite_version": "model.v1",
        "prompt_suite_version": "prompt.v1",
        "prompt_suite_hash": HASH,
        "normalization_version": "normalization.v1",
        "scoring_version": "scoring.v1",
        "gate_policy_version": "gate.v1",
        "methodology_version": "method.v1",
        "required_scenario_count": 1,
        "required_configuration_count": 1,
        "required_extraction_count": 1,
        "terminal_extraction_count": 0,
        "successful_extraction_count": 0,
        "extraction_error_count": 0,
        "finding_count": 0,
        "blocking_finding_count": 0,
        "overall_score": None,
        "score_min": None,
        "score_max": None,
        "score_spread": None,
        "agreement": None,
        "gate_decision": "pending",
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_microunits": 0,
        "max_modeled_cost_microunits": 0,
        "latency_ms": 0,
        "attempt_count": 0,
        "max_attempts": 3,
        "created_at": NOW,
        "updated_at": NOW,
    }


def _manifest() -> dict:
    return {"run": _run(), "artifacts": [], "configurations": [], "targets": []}


def _response_data(path: str, method: str) -> dict:
    if path.endswith("/events"):
        return {
            "run_id": RUN_ID,
            "state": "running",
            "gate_decision": "pending",
            "attempt_count": 0,
            "required_extractions": 1,
            "terminal_extractions": 0,
            "successful_extractions": 0,
            "extraction_errors": 0,
            "finding_count": 0,
            "blocking_finding_count": 0,
            "updated_at": NOW,
            "event_history_available": False,
            "event_history_explanation": "durable event history is unavailable",
            "source_classes": ["deterministic"],
        }
    if path.endswith("/manifest"):
        return _manifest()
    if path.endswith("/evidence"):
        page = {"items": [], "offset": 20, "limit": 50, "total": 0}
        return {
            "run": _run(),
            "source_classes": ["deterministic"],
            "extractions": page,
            "findings": page,
            "overrides": page,
        }
    if path.endswith("/apply"):
        created_revision_id = "99999999-9999-4999-8999-999999999999"
        return {
            "application": {
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "campaign_id": CAMPAIGN_ID,
                "run_id": RUN_ID,
                "attempt_count": 1,
                "finding_id": FINDING_ID,
                "request_id": REQUEST_ID,
                "request_hash": HASH,
                "finding_receipt_hash": HASH,
                "typed_patch_hash": HASH,
                "typed_patch_schema_version": 1,
                "base_content_revision_id": REVISION_ID,
                "created_content_revision_id": created_revision_id,
                "actor_id": "88888888-8888-4888-8888-888888888888",
                "campaign_updated_at": NOW,
                "created_at": NOW,
            },
            "revision": {
                "id": created_revision_id,
                "campaign_id": CAMPAIGN_ID,
                "revision_no": 2,
                "source_mode": "semantic",
                "content_schema_version": 1,
                "subject": "Applied subject",
                "semantic_tree": {"type": "document", "children": []},
                "fact_contract": {},
                "variants": [],
                "locales": [],
                "source_hash": HASH,
                "created_at": NOW,
            },
            "campaign_etag": '"campaign-new-version"',
            "originating_run_state": "stale",
            "rerun_required": True,
        }
    if path.endswith("/appeals") or path.endswith("/overrides"):
        return {
            "id": "77777777-7777-4777-8777-777777777777",
            "campaign_id": CAMPAIGN_ID,
            "run_id": RUN_ID,
            "attempt_count": 1,
            "finding_id": FINDING_ID,
            "finding_receipt_hash": HASH,
            "request_id": REQUEST_ID,
            "request_hash": HASH,
            "artifact_set_hash": HASH,
            "actor_id": "88888888-8888-4888-8888-888888888888",
            "actor_role": "admin",
            "decision": "allow_send" if path.endswith("/appeals") else "reject",
            "reason": "Reviewed governed evidence",
            "created_at": NOW,
        }
    if path.endswith("/cancel"):
        value = _run()
        value["state"] = "cancelled"
        return value
    if path.endswith("/assurance-runs") and method == "POST":
        return {
            "run_id": RUN_ID,
            "campaign_id": CAMPAIGN_ID,
            "content_revision_id": REVISION_ID,
            "send_plan_id": PLAN_ID,
            "request_id": REQUEST_ID,
            "profile": "full",
            "state": "queued",
            "required_scenario_count": 1,
            "required_extraction_count": 1,
            "status_url": f"{path}/{RUN_ID}",
            "evidence_url": f"{path}/{RUN_ID}/evidence",
            "events_url": f"{path}/{RUN_ID}/events",
        }
    detail = {
        "run": _run(),
        "manifest": _manifest(),
        "source_classes": ["deterministic"],
    }
    if path.endswith("/assurance"):
        return {
            "detail": detail,
            "applicability": {
                "applicable_to_frozen_snapshot": True,
                "freshness": "frozen_snapshot_current",
                "basis": "exact frozen identity",
            },
        }
    return detail


def test_sync_campaign_assurance_contract_routes_auth_and_keys() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "measurement": _measurement(),
                "data": _response_data(request.url.path, request.method),
            },
        )

    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = Moosewave(
        api_key="pw_assurance",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    client.campaign_assurance.create_run(
        CAMPAIGN_ID,
        CreateCampaignAssuranceRunInput(
            profile="full",
            content_revision_id=REVISION_ID,
            send_plan_id=PLAN_ID,
            request_id=REQUEST_ID,
        ),
        idempotency_key="assurance-create",
    )
    client.campaign_assurance.get_latest(CAMPAIGN_ID)
    client.campaign_assurance.get_run(CAMPAIGN_ID, RUN_ID)
    client.campaign_assurance.get_manifest(CAMPAIGN_ID, RUN_ID)
    client.campaign_assurance.get_evidence(
        CAMPAIGN_ID, RUN_ID, offset=20, limit=50
    )
    events = client.campaign_assurance.get_events(CAMPAIGN_ID, RUN_ID)
    client.campaign_assurance.appeal_finding(
        CAMPAIGN_ID,
        RUN_ID,
        FINDING_ID,
        {
            "request_id": REQUEST_ID,
            "decision": "allow_send",
            "reason": "Reviewed governed evidence",
        },
        idempotency_key="assurance-appeal",
    )
    client.campaign_assurance.override_finding(
        CAMPAIGN_ID,
        RUN_ID,
        FINDING_ID,
        {
            "request_id": REQUEST_ID,
            "decision": "reject",
            "reason": "Rejected after evidence review",
        },
        idempotency_key="assurance-override",
    )
    applied = client.campaign_assurance.apply_finding(
        CAMPAIGN_ID,
        RUN_ID,
        FINDING_ID,
        {
            "request_id": REQUEST_ID,
            "typed_patch": {"operation": "replace_subject", "value": "injected"},
        },
        if_match='"campaign-reviewed-version"',
        idempotency_key="assurance-apply",
    )
    client.campaign_assurance.cancel_run(
        CAMPAIGN_ID, RUN_ID, idempotency_key="assurance-cancel"
    )

    base = f"/api/v1/campaigns/{CAMPAIGN_ID}"
    assert [(request.method, request.url.path) for request in seen] == [
        ("POST", f"{base}/assurance-runs"),
        ("GET", f"{base}/assurance"),
        ("GET", f"{base}/assurance-runs/{RUN_ID}"),
        ("GET", f"{base}/assurance-runs/{RUN_ID}/manifest"),
        ("GET", f"{base}/assurance-runs/{RUN_ID}/evidence"),
        ("GET", f"{base}/assurance-runs/{RUN_ID}/events"),
        ("POST", f"{base}/assurance-runs/{RUN_ID}/findings/{FINDING_ID}/appeals"),
        ("POST", f"{base}/assurance-runs/{RUN_ID}/findings/{FINDING_ID}/overrides"),
        ("POST", f"{base}/assurance-runs/{RUN_ID}/findings/{FINDING_ID}/apply"),
        ("POST", f"{base}/assurance-runs/{RUN_ID}/cancel"),
    ]
    assert all(request.headers["authorization"] == "Bearer pw_assurance" for request in seen)
    assert seen[0].headers["idempotency-key"] == "assurance-create"
    assert seen[6].headers["idempotency-key"] == "assurance-appeal"
    assert seen[7].headers["idempotency-key"] == "assurance-override"
    assert seen[8].headers["idempotency-key"] == "assurance-apply"
    assert seen[8].headers["if-match"] == '"campaign-reviewed-version"'
    assert json.loads(seen[8].content) == {"request_id": REQUEST_ID}
    assert seen[9].headers["idempotency-key"] == "assurance-cancel"
    assert dict(seen[4].url.params) == {"limit": "50", "offset": "20"}
    assert events.data.event_history_available is False
    assert events.measurement.source_classes[1].present is False
    assert applied.data.application.campaign_updated_at == NOW
    assert applied.data.originating_run_state == "stale"
    assert applied.data.rerun_required is True


def test_campaign_assurance_explicit_key_validation() -> None:
    client = Moosewave(api_key="pw_assurance")
    with pytest.raises(ValueError, match="1-255 UTF-8 bytes"):
        client.campaign_assurance.cancel_run(
            CAMPAIGN_ID, RUN_ID, idempotency_key="bad\nkey"
        )


@pytest.mark.parametrize(
    "if_match",
    ["", "*", 'W/"weak"', '"one", "two"', "bare", ' "spaced"', '"bad\nvalue"'],
)
def test_campaign_assurance_apply_requires_exact_strong_etag(if_match: str) -> None:
    client = Moosewave(api_key="pw_assurance")
    with pytest.raises(ValueError, match="exact strong campaign ETag"):
        client.campaign_assurance.apply_finding(
            CAMPAIGN_ID,
            RUN_ID,
            FINDING_ID,
            {"request_id": REQUEST_ID},
            if_match=if_match,
            idempotency_key="assurance-apply",
        )


@pytest.mark.asyncio
async def test_async_campaign_assurance_events_preserve_unavailable_history() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "measurement": _measurement(),
                "data": _response_data(request.url.path, request.method),
            },
        )

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    client = AsyncPostwave(
        api_key="pw_assurance",
        base_url="http://localhost:8080",
        http_client=http,
        retries=0,
    )
    result = await client.campaign_assurance.get_events(CAMPAIGN_ID, RUN_ID)
    assert result.data.event_history_available is False
    assert "unavailable" in result.data.event_history_explanation
    await client.aclose()
