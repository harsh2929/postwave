from __future__ import annotations

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


CAMPAIGN_ID = "00000000-0000-4000-8000-000000000202"


def _response(request: httpx.Request) -> httpx.Response:
    shared = {
        "tenant_id": "00000000-0000-4000-8000-000000000101",
        "campaign_id": CAMPAIGN_ID,
        "window_start": "2026-08-01T00:00:00Z",
        "window_end": "2026-08-13T00:00:00Z",
        "generated_at": "2026-08-13T00:00:01Z",
        "classifier_version": "classifier-v2",
        "methodology_version": "method-v2",
        "registry_version": "registry-v2",
        "configuration_hash": "a" * 64,
        "classifier_version_coverage": [
            {
                "classifier_version": "classifier-v2",
                "methodology_version": "method-v2",
                "registry_version": "registry-v2",
                "configuration_hash": "a" * 64,
                "shadow_mode": True,
                "event_count": 10,
                "unclassified": False,
            }
        ],
        "mixed_classifier_versions": False,
        "shadow_mode": True,
        "methodology": "Bounded classified engagement.",
    }
    reach = {
        **shared,
        "headline": "human-engaged reach floor: 4, with up to 2 additional unclassified",
        "provider_accepted_recipients": 12,
        "human_engaged_reach_floor": 4,
        "unknown_band": 2,
        "human_engaged_reach_upper_bound": 6,
        "machine_only_recipients": 3,
        "no_interaction_recipients": 3,
        "machine_by_subtype": {"apple_mpp": 3},
    }
    if request.url.path.endswith("human-engaged-reach/export"):
        evidence_report = {
            **reach,
            "machine_by_subtype": [{"subtype": "apple_mpp", "recipients": 3}],
        }
        evidence_report.pop("generated_at")
        return httpx.Response(
            200,
            headers={
                "content-type": "application/vnd.postwave.human-engaged-reach-evidence+json"
            },
            json={
                "artifact_schema_version": "postwave.human-engaged-reach-evidence.v1",
                "artifact_kind": "human_engaged_reach_evidence",
                "artifact_id": "sha256:" + "c" * 64,
                "generated_at": "2026-08-13T00:00:01Z",
                "integrity": {
                    "algorithm": "sha-256",
                    "digest_sha256": "c" * 64,
                    "scope": "evidence_payload",
                    "canonicalization": "postwave-fixed-schema-json-v1",
                    "authenticity": "not_signed",
                },
                "evidence_payload": {
                    "evidence_semantics": {
                        "observed_evidence": ["Provider delivery and interaction events."],
                        "inferred_evidence": ["Versioned classifier predictions."],
                        "not_observed": ["Human attention."],
                        "human_reach_claim": "Lower bound.",
                        "unknown_treatment": "Separate band.",
                        "acceptance_boundary": "Acceptance is not attention.",
                    },
                    "report": evidence_report,
                },
            },
        )
    if request.url.path.endswith("human-engaged-reach"):
        return httpx.Response(
            200,
            json=reach,
        )
    return httpx.Response(
        200,
        json={
            **shared,
            "unit": "interaction_events",
            "human": 4,
            "machine": 5,
            "unknown": 1,
            "total": 10,
            "machine_by_subtype": {"apple_mpp": 5},
        },
    )


def test_sync_engagement_reporting_preserves_scope_floor_and_band() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_read_reports", http_client=http, retries=0)
    query = {
        "campaign_id": CAMPAIGN_ID,
        "since": "2026-08-01T00:00:00Z",
        "until": "2026-08-13T00:00:00Z",
    }

    summary = client.analytics.engagement_classification_summary(**query)
    reach = client.analytics.human_engaged_reach(**query)
    artifact = client.analytics.export_human_engaged_reach_evidence(**query)

    assert [request.url.path for request in seen] == [
        "/api/v1/analytics/engagement-classification/summary",
        "/api/v1/analytics/human-engaged-reach",
        "/api/v1/analytics/human-engaged-reach/export",
    ]
    assert all(dict(request.url.params) == query for request in seen)
    assert (
        seen[2].headers["accept"]
        == "application/vnd.postwave.human-engaged-reach-evidence+json"
    )
    assert summary["human"] + summary["machine"] + summary["unknown"] == summary["total"]
    assert reach["human_engaged_reach_upper_bound"] == (
        reach["human_engaged_reach_floor"] + reach["unknown_band"]
    )
    assert "additional unclassified" in reach["headline"]
    assert artifact["integrity"]["authenticity"] == "not_signed"
    assert artifact["generated_at"] == "2026-08-13T00:00:01Z"
    assert "generated_at" not in artifact["evidence_payload"]["report"]


@pytest.mark.asyncio
async def test_async_engagement_reporting_routes() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncPostwave(api_key="pw_read_reports", http_client=http, retries=0)

    summary = await client.analytics.engagement_classification_summary()
    reach = await client.analytics.human_engaged_reach()
    artifact = await client.analytics.export_human_engaged_reach_evidence(
        campaign_id=CAMPAIGN_ID,
        since="2026-08-01T00:00:00Z",
        until="2026-08-13T00:00:00Z",
    )

    assert summary["classifier_version_coverage"][0]["event_count"] == 10
    assert reach["unknown_band"] == 2
    inferred = artifact["evidence_payload"]["evidence_semantics"]["inferred_evidence"]
    assert "predictions" in inferred[0]
    assert (
        seen[2].headers["accept"]
        == "application/vnd.postwave.human-engaged-reach-evidence+json"
    )
    assert len(seen) == 3
    await http.aclose()
