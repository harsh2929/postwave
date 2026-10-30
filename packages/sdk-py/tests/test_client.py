"""Sync client happy-path tests using httpx.MockTransport."""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import Moosewave
from postwave.errors import ParseError, PostwaveError, ServerError
from postwave.resources.migrations import source_path
from postwave.resources.sequences import sequence_position_path


def _client(handler) -> Moosewave:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    return Moosewave(api_key="sk_test", tenant_id="acme", http_client=http, retries=0, base_url="http://localhost:8080")


def test_request_sends_bearer_and_tenant_headers():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers.get("authorization")
        seen["tenant"] = req.headers.get("x-tenant-slug")
        return httpx.Response(200, json={"tenant": "acme", "user": "x@y.z"})

    pw = _client(handler)
    out = pw.request("GET", "/api/v1/me")
    assert out == {"tenant": "acme", "user": "x@y.z"}
    assert seen["auth"] == "Bearer sk_test"
    assert seen["tenant"] == "acme"
    assert seen["url"] == "http://localhost:8080/api/v1/me"


def test_request_preserves_base_path():
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    pw = Moosewave(
        api_key="sk_test",
        http_client=http,
        retries=0,
        base_url="https://api.example.test/gateway///",
    )

    pw.request("GET", "api/v1/me", query={"expand": True})

    assert seen == [
        "https://api.example.test/gateway/api/v1/me?expand=true",
    ]


def test_request_rejects_unsafe_base_urls_and_paths():
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"ok": True}))
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")

    with pytest.raises(ValueError, match="base_url must be a valid"):
        Moosewave(
            api_key="sk_test",
            http_client=http,
            retries=0,
            base_url="http://api.example.test",
        )
    with pytest.raises(ValueError, match="base_url must be a valid"):
        Moosewave(
            api_key="sk_test",
            http_client=http,
            retries=0,
            base_url="https://api.example.test/\nmalformed",
        )
    with pytest.raises(ValueError, match="api_key contains unsafe"):
        Moosewave(
            api_key="sk_test\nx",
            http_client=http,
            retries=0,
            base_url="https://api.example.test",
        )
    with pytest.raises(ValueError, match="tenant_id contains unsafe"):
        Moosewave(
            api_key="sk_test",
            tenant_id="tenant\nx",
            http_client=http,
            retries=0,
            base_url="https://api.example.test",
        )
    with pytest.raises(ValueError, match="base_url must be a valid"):
        Moosewave(
            api_key="sk_test",
            http_client=http,
            retries=0,
            base_url="https://user:pass@api.example.test",
        )

    pw = Moosewave(
        api_key="sk_test",
        http_client=http,
        retries=0,
        base_url="https://api.example.test/gateway",
    )
    with pytest.raises(ValueError, match="unsafe request path"):
        pw.request("GET", "../api/v1/me")
    for path in [
        "https://evil.example/api/v1/me",
        "//evil.example/api/v1/me",
        "/api/v1/%2e%2e/admin",
        "/api/v1/%252e%252e/admin",
        "/api/v1\\admin",
        "/api/v1/me\nX-Injected: true",
        "/api/v1/me#fragment",
    ]:
        with pytest.raises(ValueError, match="unsafe request path"):
            pw.request("GET", path)

    with pytest.raises(ValueError, match="unsafe request header name"):
        pw.request("GET", "/api/v1/me", headers={"X-Bad\nName": "x"})
    with pytest.raises(ValueError, match="header X-Good contains unsafe"):
        pw.request("GET", "/api/v1/me", headers={"X-Good": "x\ny"})


def test_subscribers_list_serializes_query_params():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["q"] = dict(req.url.params)
        return httpx.Response(200, json={"items": [], "total": 0, "page": 2, "per_page": 25})

    pw = _client(handler)
    page = pw.subscribers.list(page=2, per_page=25)
    assert page.total == 0
    assert captured["q"] == {"page": "2", "per_page": "25"}


def test_request_handles_204_no_content():
    pw = _client(lambda req: httpx.Response(204))
    assert pw.subscribers.delete("sub_1") is None


def test_request_rejects_invalid_json_success_response():
    pw = _client(
        lambda req: httpx.Response(
            200,
            content=b"{not json",
            headers={"content-type": "application/json", "x-request-id": "req_bad_json"},
        )
    )
    with pytest.raises(ParseError) as exc:
        pw.request("GET", "/api/v1/me")
    # Must use the canonical taxonomy's ParseError, not a generic PostwaveError
    # with an ad-hoc code. ParseError IS a PostwaveError, so callers catching the
    # base class still work, but `except ParseError` now matches too.
    assert isinstance(exc.value, PostwaveError)
    assert exc.value.code == "invalid_json"
    assert exc.value.request_id == "req_bad_json"


def test_request_rejects_oversized_success_response():
    pw = _client(
        lambda req: httpx.Response(
            200,
            content=b"x" * (5 * 1024 * 1024 + 1),
            headers={"x-request-id": "req_too_big"},
        )
    )
    with pytest.raises(PostwaveError) as exc:
        pw.request("GET", "/api/v1/huge")
    assert exc.value.code == "response_too_large"
    assert exc.value.request_id == "req_too_big"


def test_request_rejects_oversized_success_content_length_before_parse():
    pw = _client(
        lambda req: httpx.Response(
            200,
            content=b'{"ok": true}',
            headers={
                "content-type": "application/json",
                "content-length": str(5 * 1024 * 1024 + 1),
                "x-request-id": "req_declared_big",
            },
        )
    )
    with pytest.raises(PostwaveError) as exc:
        pw.request("GET", "/api/v1/declared-huge")
    assert exc.value.code == "response_too_large"
    assert exc.value.request_id == "req_declared_big"


def test_generate_sequence_returns_pydantic_model():
    payload = {
        "id": "seq_1", "tenant_id": "acme", "template_id": "tpl_welcome_3",
        "name": "Welcome", "version": 1, "emails": [], "created_at": "2026-04-30T10:00:00Z",
    }

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert body["template_id"] == "tpl_welcome_3"
        return httpx.Response(202, json=payload)

    pw = _client(handler)
    seq = pw.sequences.generate({"template_id": "tpl_welcome_3", "name": "Welcome"})
    assert seq.id == "seq_1"
    assert seq.name == "Welcome"


def test_sequences_update_and_delete():
    seen: list[tuple[str, str, dict | None, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(
            (
                req.method,
                str(req.url),
                json.loads(req.content) if req.content else None,
                req.headers.get("if-match"),
            )
        )
        if req.method == "PATCH":
            return httpx.Response(
                200,
                json={
                    "id": "seq_1",
                    "tenant_id": "acme",
                    "template_id": "tpl_welcome_3",
                    "name": "After",
                    "version": 8,
                    "emails": [],
                    "created_at": "2026-04-30T10:00:00Z",
                },
            )
        return httpx.Response(204)

    pw = _client(handler)
    seq = pw.sequences.update("seq_1", {"name": "After"}, expected_version=7)
    assert seq.name == "After"
    assert seq.version == 8
    assert pw.sequences.delete("seq_1", expected_version=8) is None
    assert seen == [
        ("PATCH", "http://localhost:8080/api/v1/voice/sequences/seq_1", {"name": "After"}, '"7"'),
        ("DELETE", "http://localhost:8080/api/v1/voice/sequences/seq_1", None, '"8"'),
    ]

    with pytest.raises(ValueError, match="positive integer"):
        pw.sequences.update("seq_1", {"name": "Unsafe"}, expected_version=0)
    with pytest.raises(ValueError, match="positive integer"):
        pw.sequences.delete("seq_1", expected_version=True)
    assert len(seen) == 2


def test_sequences_regenerate_encodes_id_and_validates_position():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        return httpx.Response(
            200,
            json={
                "position": 2,
                "subject": "After",
                "body": "Body",
                "delay_seconds": 0,
            },
        )

    pw = _client(handler)
    email = pw.sequences.regenerate("seq/a", 2, {"user_hint": "shorter"})
    assert email.position == 2
    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/voice/sequences/seq%2Fa/regenerate/2",
            {"user_hint": "shorter"},
        )
    ]
    assert sequence_position_path(1) == "1"
    with pytest.raises(ValueError, match="positive integer"):
        pw.sequences.regenerate("seq/a", 0)
    with pytest.raises(ValueError, match="positive integer"):
        sequence_position_path(True)  # type: ignore[arg-type]


def test_templates_update_and_delete():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        if req.method == "PATCH":
            return httpx.Response(
                200,
                json={
                    "id": "tpl_1",
                    "slug": "welcome",
                    "category": "welcome",
                    "name": "After",
                    "description": "",
                    "length": 1,
                    "variables": [],
                    "emails": [],
                    "tags": [],
                    "author": "",
                    "performance": {
                        "open_rate": 0,
                        "click_rate": 0,
                        "conversion_rate": 0,
                        "sample_size": 0,
                    },
                },
            )
        return httpx.Response(204)

    pw = _client(handler)
    template = pw.templates.update("tpl_1", {"name": "After"})
    assert template.name == "After"
    assert pw.templates.delete("tpl_1") is None
    assert seen == [
        ("PATCH", "http://localhost:8080/api/v1/voice/templates/tpl_1", {"name": "After"}),
        ("DELETE", "http://localhost:8080/api/v1/voice/templates/tpl_1", None),
    ]


def test_campaign_queue_sandbox_header():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["sandbox"] = req.headers.get("x-postwave-sandbox")
        return httpx.Response(
            202,
            json={
                "campaign_id": "cmp_1",
                "recipients_queued": 12,
                "status": "sending",
                "sandbox": True,
            },
        )

    pw = _client(handler)
    out = pw.campaigns.queue("cmp_1", sandbox=True)
    assert captured["url"] == "http://localhost:8080/api/v1/campaigns/cmp_1/queue"
    assert captured["sandbox"] == "true"
    assert out["campaign_id"] == "cmp_1"
    assert out["sandbox"] is True


def test_campaign_send_approval_required_response():
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url) == "http://localhost:8080/api/v1/campaigns/cmp_2/send"
        return httpx.Response(
            202,
            json={
                "campaign_id": "cmp_2",
                "recipients_queued": 0,
                "status": "approval_required",
                "approval_id": "apr_1",
                "approval_status": "pending",
            },
        )

    pw = _client(handler)
    out = pw.campaigns.send("cmp_2")
    assert out["status"] == "approval_required"
    assert out["approval_id"] == "apr_1"


def test_events_subscribe_posts_filter_body():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["body"] = json.loads(req.content)
        return httpx.Response(
            200,
            json={
                "subscription_id": "evsub_1",
                "resource_uri": "moosewave://events/stream?event_type=opened",
            },
        )

    pw = _client(handler)
    out = pw.events.subscribe({"event_types": ["opened"], "campaign_id": "cmp_1"})
    assert captured["url"] == "http://localhost:8080/api/v1/events/subscriptions"
    assert captured["body"] == {"event_types": ["opened"], "campaign_id": "cmp_1"}
    assert out["subscription_id"] == "evsub_1"


def test_events_stream_parses_sse_frames():
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url) == "http://localhost:8080/api/v1/events/stream?event_type=opened&campaign=cmp_1"
        assert req.headers.get("accept") == "text/event-stream"
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b'data: {"event_type":"opened","campaign_id":"cmp_1"}\n\n',
        )

    pw = _client(handler)
    rows = list(pw.events.stream(event_type="opened", campaign="cmp_1"))
    assert rows == [{"event_type": "opened", "campaign_id": "cmp_1"}]


def test_segments_compile_from_natural_language():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["body"] = json.loads(req.content)
        return httpx.Response(
            200,
            json={
                "query_ast": {"op": "condition", "field": "tags", "comparator": "in", "value": ["vip"]},
                "suggested_name": "VIP readers",
            },
        )

    pw = _client(handler)
    out = pw.segments.compile_from_natural_language("VIP readers")
    assert captured["url"] == "http://localhost:8080/api/v1/segments/compile-from-text"
    assert captured["body"] == {"text": "VIP readers"}
    assert out["query_ast"]["field"] == "tags"


def test_segments_get_url_encodes_id():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        return httpx.Response(200, json={"id": "segment/a", "name": "A", "query_ast": {"op": "and"}})

    pw = _client(handler)
    out = pw.segments.get("segment/a")
    assert captured["url"] == "http://localhost:8080/api/v1/segments/segment%2Fa"
    assert out["id"] == "segment/a"


def test_python_sdk_exposes_ts_resource_parity_surface():
    pw = _client(lambda req: httpx.Response(200, json={}))
    expected = [
        "account", "agent_mandates", "analytics", "api_keys", "approvals", "archive", "assets",
        "audit", "audience_destinations", "audience_syncs", "auth_checks", "automations", "campaigns", "campaigns_ab",
        "chat_integrations", "cost", "custom_domains", "discord_integrations", "discounts", "dmarc", "events", "forms",
        "gift_subscriptions", "inbound_emails", "inbound_webhooks",
        "inbox_reality", "integrations", "landing_pages", "link_check", "lists", "migrations",
        "native_integrations", "preferences", "referrals", "reputation", "safety",
        "push_suppressions", "sandbox", "segments", "send_time", "sending", "sending_settings", "sms",
        "sequences", "slack_integrations", "subscribers", "suppressions",
        "tags", "teams_integrations", "template_preview", "templates", "topics", "track",
        "voice_profile", "webhooks",
    ]
    missing = [name for name in expected if not hasattr(pw, name)]
    assert missing == []


def test_new_python_parity_resources_route_to_expected_paths():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url)))
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.account.me()
    pw.campaigns_ab.evaluate("cmp/a")
    pw.custom_domains.verify("dom/a")
    pw.lists.delete(123)
    pw.send_time.schedule_campaign("cmp/a")
    pw.topics.subscribe("person+tag@example.com", "topic/a")
    assert seen == [
        ("GET", "http://localhost:8080/api/v1/me"),
        ("POST", "http://localhost:8080/api/v1/campaigns/cmp%2Fa/ab/evaluate"),
        ("POST", "http://localhost:8080/api/v1/custom-domains/dom%2Fa/verify"),
        ("DELETE", "http://localhost:8080/api/v1/lists/123"),
        ("POST", "http://localhost:8080/api/v1/campaigns/cmp%2Fa/schedule-by-best-time"),
        ("POST", "http://localhost:8080/api/v1/subscribers/person%2Btag%40example.com/topics/topic%2Fa/subscribe"),
    ]


def test_documented_membership_transform_and_upload_status_routes():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        seen.append((req.method, str(req.url), body))
        if "for-subscriber" in req.url.path:
            return httpx.Response(200, json={"items": [], "count": 0})
        if "/uploads/" in req.url.path:
            return httpx.Response(200, json={"upload_id": "upload/1", "received": 4, "total": 8, "updated_at": "2026-07-14T08:15:30Z"})
        if req.method == "DELETE":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, json={"items": [], "total": 0})

    pw = _client(handler)
    pw.lists.for_subscriber("subscriber/1")
    pw.subscribers.transform_rules()
    pw.subscribers.upsert_transform_rule({"name": "country", "source_path": "country", "target_key": "country_code"})
    pw.subscribers.delete_transform_rule("rule/1")
    pw.migrations.upload_status("csv", "upload/1")

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/lists/for-subscriber/subscriber%2F1", None),
        ("GET", "http://localhost:8080/api/v1/profile-transform-rules", None),
        (
            "POST",
            "http://localhost:8080/api/v1/profile-transform-rules",
            {"name": "country", "source_path": "country", "target_key": "country_code"},
        ),
        ("DELETE", "http://localhost:8080/api/v1/profile-transform-rules/rule%2F1", None),
        ("GET", "http://localhost:8080/api/v1/migrations/csv/uploads/upload%2F1", None),
    ]

    with pytest.raises(ValueError, match="Subscriber ID"):
        pw.lists.for_subscriber(" ")
    with pytest.raises(ValueError, match="transform rule ID"):
        pw.subscribers.delete_transform_rule(" ")
    with pytest.raises(ValueError, match="upload ID"):
        pw.migrations.upload_status("csv", " ")
    with pytest.raises(ValueError, match="Unsupported CRM OAuth provider"):
        pw.native_integrations.crm.oauth_availability("../../admin")


def test_mailchimp_migration_forwards_explicit_audience_scope():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        seen.append((req.method, req.url.path, body))
        if req.url.path.endswith("/discover"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "mailchimp",
                    "subscribers_count": 3,
                    "audiences": [
                        {"id": "aud_a", "name": "Primary", "subscribers_total": 3}
                    ],
                },
            )
        return httpx.Response(200, json={"job_id": "job/a"})

    pw = _client(handler)
    discovery = pw.migrations.discover("mailchimp", "job/a")
    assert discovery.job_id == "job/a"
    assert discovery.audiences[0].id == "aud_a"
    pw.migrations.discover("mailchimp", "job/a", ["aud_a"])
    pw.migrations.dry_run("mailchimp", "job/a", ["aud_a"])
    pw.migrations.commit("mailchimp", "job/a", ["aud_a"])

    assert seen == [
        ("POST", "/api/v1/migrations/mailchimp/discover", {"job_id": "job/a"}),
        (
            "POST",
            "/api/v1/migrations/mailchimp/discover",
            {"job_id": "job/a", "selected_audience_ids": ["aud_a"]},
        ),
        (
            "POST",
            "/api/v1/migrations/mailchimp/dry-run",
            {"job_id": "job/a", "selected_audience_ids": ["aud_a"]},
        ),
        (
            "POST",
            "/api/v1/migrations/mailchimp/commit",
            {"job_id": "job/a", "selected_audience_ids": ["aud_a"]},
        ),
    ]
    with pytest.raises(ValueError, match="selected audience ID"):
        pw.migrations.dry_run("mailchimp", "job/a")
    with pytest.raises(ValueError, match="selected audience ID"):
        pw.migrations.commit("mailchimp", "job/a", [])


def test_klaviyo_discovery_preserves_extended_inventory_counts():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert req.url.path == "/api/v1/migrations/klaviyo/discover"
        assert json.loads(req.content) == {"job_id": "job/klaviyo"}
        return httpx.Response(
            200,
            json={
                "job_id": "job/klaviyo",
                "source": "klaviyo",
                "subscribers_count": 120,
                "profiles_without_email_count": 3,
                "source_archive_count": 12,
                "sms_campaigns_count": 2,
                "push_campaigns_count": 1,
            },
        )

    discovery = _client(handler).migrations.discover("klaviyo", "job/klaviyo")

    assert discovery.job_id == "job/klaviyo"
    assert discovery.profiles_without_email_count == 3
    assert discovery.source_archive_count == 12
    assert discovery.sms_campaigns_count == 2
    assert discovery.push_campaigns_count == 1


def test_customerio_discovery_preserves_object_type_metadata_count():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert req.url.path == "/api/v1/migrations/customerio/discover"
        return httpx.Response(
            200,
            json={
                "job_id": "job/customerio",
                "source": "customerio",
                "subscribers_count": 7,
                "custom_objects_count": 4,
                "subscription_channels_count": 3,
            },
        )

    discovery = _client(handler).migrations.discover(
        "customerio", "job/customerio"
    )

    assert discovery.custom_objects_count == 4
    assert discovery.subscription_channels_count == 3


def test_hubspot_discovery_preserves_additional_email_identity_count():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert req.url.path == "/api/v1/migrations/hubspot/discover"
        return httpx.Response(
            200,
            json={
                "job_id": "job/hubspot",
                "source": "hubspot",
                "subscribers_count": 7,
                "profiles_without_email_count": 2,
                "additional_email_identities_count": 3,
            },
        )

    discovery = _client(handler).migrations.discover("hubspot", "job/hubspot")

    assert discovery.profiles_without_email_count == 2
    assert discovery.additional_email_identities_count == 3


def test_mailchimp_oauth_reconnect_and_rollback_contracts():
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        if req.url.path.endswith("/oauth/start"):
            return httpx.Response(
                200,
                json={
                    "authorize_url": "https://login.mailchimp.com/oauth2/authorize",
                    "state": "csrf",
                },
            )
        if req.url.path.endswith("/rollback"):
            return httpx.Response(202, json={"job_id": "job/a", "state": "running"})
        return httpx.Response(
            200,
            json={
                "state": "running",
                "archive_deleted": 0,
                "archive_total": 1,
                "templates_deleted": 0,
                "templates_total": 1,
                "automations_deleted": 0,
                "automations_total": 0,
                "segments_deleted": 0,
                "segments_total": 0,
                "subscribers_deleted": 1,
                "subscribers_total": 3,
                "lists_deleted": 0,
                "lists_total": 1,
                "paid_subs_deleted": 0,
                "paid_subs_total": 0,
                "started_at": "2026-07-15T00:00:00Z",
            },
        )

    pw = _client(handler)
    assert pw.migrations.start("mailchimp", " job/a ").state == "csrf"
    accepted = pw.migrations.rollback("job/a")
    progress = pw.migrations.rollback_status("job/a")

    assert accepted.job_id == "job/a"
    assert accepted.state == "running"
    assert progress.subscribers_deleted == 1
    assert progress.templates_total == 1
    assert seen == [
        "http://localhost:8080/api/v1/migrations/mailchimp/oauth/start?job_id=job%2Fa",
        "http://localhost:8080/api/v1/migrations/job%2Fa/rollback",
        "http://localhost:8080/api/v1/migrations/job%2Fa/rollback-status",
    ]
    with pytest.raises(ValueError, match="job ID is required for OAuth reconnect"):
        pw.migrations.start("mailchimp", " ")


def test_migration_models_preserve_verification_and_template_counters():
    from postwave.types import MigrationProgress, VerificationReport

    progress = MigrationProgress.model_validate(
        {"templates_total": 4, "templates_done": 3}
    )
    report = VerificationReport.model_validate(
        {
            "consent_known": 2,
            "consent_unknown": 1,
            "duplicate_subscribers_merged": 1,
            "subscriber_merge_conflicts": [
                {
                    "email": "ada@example.com",
                    "source_ids": ["aud_a:member_1", "aud_b:member_2"],
                    "conflict_fields": ["first_name"],
                }
            ],
            "templates_imported": 4,
            "premium_memberships_observed": 3,
            "source_archive_by_resource": {"customer_journeys": 2},
        }
    )

    assert progress.templates_done == 3
    assert report.subscriber_merge_conflicts[0].email == "ada@example.com"
    assert report.premium_memberships_observed == 3
    assert report.source_archive_by_resource == {"customer_journeys": 2}


def test_discovery_report_requires_nonempty_authoritative_job_id():
    from pydantic import ValidationError as PydanticValidationError

    from postwave.types import DiscoveryReport

    report = DiscoveryReport.model_validate({"job_id": "job/a"})
    assert report.job_id == "job/a"

    with pytest.raises(PydanticValidationError):
        DiscoveryReport.model_validate({})
    with pytest.raises(PydanticValidationError):
        DiscoveryReport.model_validate({"job_id": ""})


def test_integrations_resource_routes_to_facade_paths():
    from postwave.resources.integrations import path_segment

    seen: list[tuple[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url)))
        return httpx.Response(200, json={"items": [], "summary": {}, "counts": {}})

    pw = _client(handler)
    pw.integrations.catalog(q="Shopify", category="ecommerce", badge="native", capability="orders")
    pw.integrations.recipes(source="hubspot", provider="zapier", available=True)
    pw.integrations.coverage()
    pw.integrations.stacks()
    pw.integrations.readiness()
    pw.integrations.detail("hubspot/crm")
    pw.integrations.health("hubspot/crm")
    pw.integrations.contract("hubspot/crm")
    pw.integrations.recipe("recipe/a")
    pw.integrations.apply_recipe("recipe/a")
    pw.integrations.start_connect("snowflake")
    pw.integrations.finish_connect("snowflake")
    pw.integrations.sync("snowflake")
    pw.integrations.backfill("snowflake")
    pw.integrations.pause("snowflake")
    pw.integrations.disconnect("snowflake")

    assert path_segment("hubspot/crm") == "hubspot%2Fcrm"
    with pytest.raises(ValueError, match="integration slug is required"):
        path_segment(" ")

    assert seen == [
        (
            "GET",
            "http://localhost:8080/api/v1/integrations/catalog?q=Shopify&category=ecommerce&badge=native&capability=orders",
        ),
        (
            "GET",
            "http://localhost:8080/api/v1/integrations/recipes?source=hubspot&provider=zapier&available=true",
        ),
        ("GET", "http://localhost:8080/api/v1/integrations/coverage"),
        ("GET", "http://localhost:8080/api/v1/integrations/stacks"),
        ("GET", "http://localhost:8080/api/v1/integrations/readiness"),
        ("GET", "http://localhost:8080/api/v1/integrations/hubspot%2Fcrm"),
        ("GET", "http://localhost:8080/api/v1/integrations/hubspot%2Fcrm/health"),
        ("GET", "http://localhost:8080/api/v1/integrations/hubspot%2Fcrm/contract"),
        ("GET", "http://localhost:8080/api/v1/integrations/recipes/recipe%2Fa"),
        ("POST", "http://localhost:8080/api/v1/integrations/recipes/recipe%2Fa/apply"),
        ("POST", "http://localhost:8080/api/v1/integrations/snowflake/connect/start"),
        ("POST", "http://localhost:8080/api/v1/integrations/snowflake/connect/callback"),
        ("POST", "http://localhost:8080/api/v1/integrations/snowflake/sync"),
        ("POST", "http://localhost:8080/api/v1/integrations/snowflake/backfill"),
        ("POST", "http://localhost:8080/api/v1/integrations/snowflake/pause"),
        ("DELETE", "http://localhost:8080/api/v1/integrations/snowflake"),
    ]


def test_integrations_rejects_empty_slug_before_request():
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    pw = _client(handler)
    with pytest.raises(ValueError, match="integration slug is required"):
        pw.integrations.detail(" ")
    assert calls == 0


def test_audience_destinations_resource_routes_to_first_party_paths():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        if req.method == "DELETE":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "provider_cleanup": {
                        "provider": "meta",
                        "status": "operator_action_required",
                        "postwave_status": "disconnected",
                        "provider_cleanup_posture": "operator_managed_provider_console",
                        "managed_provider_cleanup": False,
                        "audience_cleanup_status": "operator_review_required",
                        "audience_membership_cleanup_status": "postwave_delivery_stopped",
                        "credential_cleanup_status": "operator_revoke_or_rotate_if_no_longer_used",
                    },
                },
            )
        return httpx.Response(200, json={"id": "aud/1", "provider": "meta", "status": "active", "items": []})

    pw = _client(handler)
    pw.audience_destinations.providers()
    pw.audience_destinations.list()
    pw.audience_destinations.list("meta")
    pw.audience_destinations.create({
        "provider": "meta",
        "list_id": "list_123",
        "external_audience_id": "act_123",
        "config": {"credentials_ref": "vault://meta"},
    })
    pw.audience_destinations.get("aud/1")
    pw.audience_destinations.update(
        "aud/1",
        {
            "status": "paused",
            "config": {"credentials_ref": "vault://meta-rotated"},
        },
    )
    pw.audience_destinations.readiness("meta", {"audience_id": "audience_123"})
    pw.audience_destinations.preview("aud/1")
    pw.audience_destinations.sync("aud/1")
    pw.audience_destinations.jobs("aud/1")
    pw.audience_destinations.job_diagnostics("aud/1", "job/1")
    disconnected = pw.audience_destinations.disconnect("aud/1")
    assert disconnected["provider_cleanup"]["managed_provider_cleanup"] is False

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/audience-destinations/providers", None),
        ("GET", "http://localhost:8080/api/v1/audience-destinations", None),
        ("GET", "http://localhost:8080/api/v1/audience-destinations?provider=meta", None),
        (
            "POST",
            "http://localhost:8080/api/v1/audience-destinations",
            {
                "provider": "meta",
                "list_id": "list_123",
                "external_audience_id": "act_123",
                "config": {"credentials_ref": "vault://meta"},
            },
        ),
        ("GET", "http://localhost:8080/api/v1/audience-destinations/aud%2F1", None),
        (
            "PATCH",
            "http://localhost:8080/api/v1/audience-destinations/aud%2F1",
            {
                "status": "paused",
                "config": {"credentials_ref": "vault://meta-rotated"},
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/audience-destinations/meta/readiness",
            {"config": {"audience_id": "audience_123"}},
        ),
        ("GET", "http://localhost:8080/api/v1/audience-destinations/aud%2F1/preview", None),
        ("POST", "http://localhost:8080/api/v1/audience-destinations/aud%2F1/sync", {}),
        ("GET", "http://localhost:8080/api/v1/audience-destinations/aud%2F1/jobs", None),
        ("GET", "http://localhost:8080/api/v1/audience-destinations/aud%2F1/jobs/job%2F1/diagnostics", None),
        ("DELETE", "http://localhost:8080/api/v1/audience-destinations/aud%2F1", None),
    ]


def test_audience_destinations_reject_empty_path_values_before_request():
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    pw = _client(handler)
    with pytest.raises(ValueError, match="audience destination id is required"):
        pw.audience_destinations.get(" ")
    with pytest.raises(ValueError, match="audience destination provider is required"):
        pw.audience_destinations.readiness(" ")
    with pytest.raises(ValueError, match="audience destination job id is required"):
        pw.audience_destinations.job_diagnostics("aud/1", " ")
    assert calls == 0


def test_chat_integrations_route_to_first_party_notification_paths():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "chat/1", "ok": True})

    pw = _client(handler)
    pw.chat_integrations.slack.list()
    pw.chat_integrations.discord.create(
        url="https://discord.com/api/webhooks/123/token",
        channel_hint="#growth",
        events=["subscriber.created"],
    )
    pw.teams_integrations.update("teams/1", enabled=False, events=["campaign.sent"])
    pw.discord_integrations.delete("discord/1")

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/integrations/slack", None),
        (
            "POST",
            "http://localhost:8080/api/v1/integrations/discord",
            {
                "url": "https://discord.com/api/webhooks/123/token",
                "events": ["subscriber.created"],
                "channel_hint": "#growth",
            },
        ),
        (
            "PATCH",
            "http://localhost:8080/api/v1/integrations/teams/teams%2F1",
            {"enabled": False, "events": ["campaign.sent"]},
        ),
        ("DELETE", "http://localhost:8080/api/v1/integrations/discord/discord%2F1", None),
    ]


def test_native_integrations_resource_routes_to_managed_family_paths():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "conn/1", "status": "ok", "items": []})

    pw = _client(handler)
    families = [
        (pw.native_integrations.lead, "/api/v1/lead-integrations/providers", "/api/v1/lead-integrations", True),
        (
            pw.native_integrations.subscriptions,
            "/api/v1/subscription-integrations/providers",
            "/api/v1/subscription-integrations",
            True,
        ),
        (
            pw.native_integrations.marketing,
            "/api/v1/marketing-integrations/providers",
            "/api/v1/marketing-integrations",
            False,
        ),
    ]

    for resource, _providers_path, _base_path, supports_ingest in families:
        resource.providers()
        resource.list()
        if resource is pw.native_integrations.marketing:
            resource.create({
                "provider": "mailerlite",
                "name": "MailerLite production",
                "settings": {"workspace_id": "workspace_123"},
                "credentials_ref": "vault://marketing/mailerlite",
            })
        else:
            resource.create({"provider": "hubspot", "name": "Primary", "config": {"portal_id": "123"}})
        resource.get("conn/1")
        resource.sync("conn/1", {"objects": ["profiles"], "reason": "manual"})
        resource.backfill("conn/1", {"full": True})
        if supports_ingest:
            resource.ingest("conn/1", {"source_id": "evt_1"})
        resource.pause("conn/1")
        resource.disconnect("conn/1")
        if resource is pw.native_integrations.marketing:
            resource.acknowledge_provider_cleanup(
                "conn/1",
                {
                    "completed_actions": ["private_api_key_revoked_or_rotated"],
                    "notes": "Verified in Klaviyo",
                },
            )
        resource.runs("conn/1", limit=10)

    expected: list[tuple[str, str, object | None]] = []
    for resource, providers_path, base_path, supports_ingest in families:
        create_payload = (
            {
                "provider": "mailerlite",
                "name": "MailerLite production",
                "settings": {"workspace_id": "workspace_123"},
                "credentials_ref": "vault://marketing/mailerlite",
            }
            if resource is pw.native_integrations.marketing
            else {"provider": "hubspot", "name": "Primary", "config": {"portal_id": "123"}}
        )
        expected.extend([
            ("GET", f"http://localhost:8080{providers_path}", None),
            ("GET", f"http://localhost:8080{base_path}", None),
            (
                "POST",
                f"http://localhost:8080{base_path}",
                create_payload,
            ),
            ("GET", f"http://localhost:8080{base_path}/conn%2F1", None),
            (
                "POST",
                f"http://localhost:8080{base_path}/conn%2F1/sync",
                {"objects": ["profiles"], "reason": "manual"},
            ),
            ("POST", f"http://localhost:8080{base_path}/conn%2F1/backfill", {"full": True}),
        ])
        if supports_ingest:
            expected.append(
                ("POST", f"http://localhost:8080{base_path}/conn%2F1/ingest", {"source_id": "evt_1"})
            )
        expected.extend([
            ("POST", f"http://localhost:8080{base_path}/conn%2F1/pause", None),
            ("DELETE", f"http://localhost:8080{base_path}/conn%2F1", None),
        ])
        if resource is pw.native_integrations.marketing:
            expected.append(
                (
                    "POST",
                    f"http://localhost:8080{base_path}/conn%2F1/provider-cleanup/acknowledge",
                    {
                        "completed_actions": ["private_api_key_revoked_or_rotated"],
                        "notes": "Verified in Klaviyo",
                    },
                )
            )
        expected.append(("GET", f"http://localhost:8080{base_path}/conn%2F1/runs?limit=10", None))

    assert seen == expected


def test_native_crm_resource_uses_canonical_import_payload_shape():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        if (
            req.method == "DELETE"
            and str(req.url) == "http://localhost:8080/api/v1/crm/integrations/crm%2F1"
        ):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "provider_cleanup": {
                        "provider": "hubspot",
                        "status": "operator_action_required",
                        "postwave_status": "disconnected",
                        "provider_cleanup_posture": "mixed_postwave_oauth_operator_hubspot_console",
                        "managed_provider_cleanup": False,
                        "webhook_cleanup_status": (
                            "app_level_webhook_subscription_shared_no_per_tenant_cleanup"
                        ),
                        "credential_cleanup_status": (
                            "operator_revoke_or_rotate_hubspot_private_app_token_if_no_longer_used"
                        ),
                    },
                },
            )
        return httpx.Response(200, json={"id": "crm/1", "status": "completed", "items": []})

    pw = _client(handler)
    pw.native_integrations.crm.providers()
    pw.native_integrations.crm.list()
    pw.native_integrations.crm.create({
        "provider": "hubspot",
        "name": "HubSpot production",
        "credentials_ref": "vault://crm/hubspot",
        "settings": {"portal_id": "123"},
    })
    pw.native_integrations.crm.get("crm/1")
    pw.native_integrations.crm.oauth_availability("salesforce")
    assert (
        pw.native_integrations.crm.oauth_start_url(
            "salesforce",
            {
                "name": "Salesforce production",
                "sync_tasks": False,
                "redirect_to": "/app/integrations",
            },
        )
        == "/api/v1/crm/salesforce/oauth/start?name=Salesforce+production&sync_tasks=false&redirect_to=%2Fapp%2Fintegrations"
    )
    pw.native_integrations.crm.sync(
        "crm/1",
        {
            "cursor": "crm_cursor_1",
            "contacts": [{"email": "ada@example.com"}],
            "events": [{"email": "ada@example.com", "event_name": "Deal Stage Changed"}],
        },
    )
    pw.native_integrations.crm.backfill("crm/1", {"contacts": [{"email": "lin@example.com"}]})
    pw.native_integrations.crm.pause("crm/1")
    disconnected = pw.native_integrations.crm.disconnect("crm/1")
    pw.native_integrations.crm.runs("crm/1", limit=10)

    assert (
        disconnected["provider_cleanup"]["provider_cleanup_posture"]
        == "mixed_postwave_oauth_operator_hubspot_console"
    )

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/crm/providers", None),
        ("GET", "http://localhost:8080/api/v1/crm/integrations", None),
        (
            "POST",
            "http://localhost:8080/api/v1/crm/integrations",
            {
                "provider": "hubspot",
                "name": "HubSpot production",
                "credentials_ref": "vault://crm/hubspot",
                "settings": {"portal_id": "123"},
            },
        ),
        ("GET", "http://localhost:8080/api/v1/crm/integrations/crm%2F1", None),
        ("GET", "http://localhost:8080/api/v1/crm/salesforce/oauth/availability", None),
        (
            "POST",
            "http://localhost:8080/api/v1/crm/integrations/crm%2F1/sync",
            {
                "cursor": "crm_cursor_1",
                "contacts": [{"email": "ada@example.com"}],
                "events": [{"email": "ada@example.com", "event_name": "Deal Stage Changed"}],
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/crm/integrations/crm%2F1/backfill",
            {"contacts": [{"email": "lin@example.com"}]},
        ),
        ("POST", "http://localhost:8080/api/v1/crm/integrations/crm%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/crm/integrations/crm%2F1", None),
        ("GET", "http://localhost:8080/api/v1/crm/integrations/crm%2F1/runs?limit=10", None),
    ]

    with pytest.raises(ValueError, match="does not support ingest"):
        pw.native_integrations.crm.ingest("crm/1", {"email": "ada@example.com"})


def test_native_review_resource_uses_canonical_review_payload_shape():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "review/1", "status": "completed", "items": []})

    pw = _client(handler)
    pw.native_integrations.reviews.providers()
    pw.native_integrations.reviews.list()
    pw.native_integrations.reviews.create({
        "provider": "yotpo",
        "name": "Yotpo reviews",
        "credentials_ref": "vault://reviews/yotpo",
        "settings": {"store_id": "store_123"},
    })
    pw.native_integrations.reviews.get("review/1")
    pw.native_integrations.reviews.sync(
        "review/1",
        {
            "cursor": "review_cursor_1",
            "reviews": [{"source_id": "r1", "reviewer_email": "ada@example.com", "rating": 5}],
        },
    )
    pw.native_integrations.reviews.backfill("review/1", {"reviews": [{"source_id": "r0", "rating": 4}]})
    pw.native_integrations.reviews.ingest(
        "review/1",
        {"source_id": "r2", "reviewer_email": "lin@example.com", "rating": 5},
    )
    pw.native_integrations.reviews.pause("review/1")
    pw.native_integrations.reviews.disconnect("review/1")
    pw.native_integrations.reviews.acknowledge_provider_cleanup(
        "review/1",
        {
            "completed_actions": ["app_secret_or_api_credentials_rotated"],
            "notes": "Verified in Yotpo console.",
        },
    )
    pw.native_integrations.reviews.runs("review/1", limit=10)

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/review-integrations/providers", None),
        ("GET", "http://localhost:8080/api/v1/review-integrations", None),
        (
            "POST",
            "http://localhost:8080/api/v1/review-integrations",
            {
                "provider": "yotpo",
                "name": "Yotpo reviews",
                "credentials_ref": "vault://reviews/yotpo",
                "settings": {"store_id": "store_123"},
            },
        ),
        ("GET", "http://localhost:8080/api/v1/review-integrations/review%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/review-integrations/review%2F1/sync",
            {
                "cursor": "review_cursor_1",
                "reviews": [{"source_id": "r1", "reviewer_email": "ada@example.com", "rating": 5}],
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/review-integrations/review%2F1/backfill",
            {"reviews": [{"source_id": "r0", "rating": 4}]},
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/review-integrations/review%2F1/ingest",
            {"source_id": "r2", "reviewer_email": "lin@example.com", "rating": 5},
        ),
        ("POST", "http://localhost:8080/api/v1/review-integrations/review%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/review-integrations/review%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/review-integrations/review%2F1/provider-cleanup/acknowledge",
            {
                "completed_actions": ["app_secret_or_api_credentials_rotated"],
                "notes": "Verified in Yotpo console.",
            },
        ),
        ("GET", "http://localhost:8080/api/v1/review-integrations/review%2F1/runs?limit=10", None),
    ]


def test_native_loyalty_resource_uses_canonical_loyalty_payload_shape():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "loyalty/1", "status": "completed", "items": []})

    pw = _client(handler)
    pw.native_integrations.loyalty.providers()
    pw.native_integrations.loyalty.list()
    pw.native_integrations.loyalty.create({
        "provider": "smile",
        "name": "Smile loyalty",
        "credentials_ref": "vault://loyalty/smile",
        "settings": {"shop_domain": "acme.myshopify.com"},
    })
    pw.native_integrations.loyalty.get("loyalty/1")
    pw.native_integrations.loyalty.sync(
        "loyalty/1",
        {
            "cursor": "loyalty_cursor_1",
            "members": [{"email": "vip@example.com", "points_balance": 1200}],
            "events": [{"email": "vip@example.com", "event_name": "loyalty.points_earned"}],
        },
    )
    pw.native_integrations.loyalty.backfill("loyalty/1", {"members": [{"email": "lin@example.com"}]})
    pw.native_integrations.loyalty.ingest(
        "loyalty/1",
        {"email": "vip@example.com", "event_name": "loyalty.reward_redeemed"},
    )
    pw.native_integrations.loyalty.pause("loyalty/1")
    pw.native_integrations.loyalty.disconnect("loyalty/1")
    pw.native_integrations.loyalty.acknowledge_provider_cleanup(
        "loyalty/1",
        {
            "completed_actions": ["api_token_revoked_or_rotated"],
            "notes": "Verified in Smile console.",
        },
    )
    pw.native_integrations.loyalty.runs("loyalty/1", limit=10)

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/loyalty-integrations/providers", None),
        ("GET", "http://localhost:8080/api/v1/loyalty-integrations", None),
        (
            "POST",
            "http://localhost:8080/api/v1/loyalty-integrations",
            {
                "provider": "smile",
                "name": "Smile loyalty",
                "credentials_ref": "vault://loyalty/smile",
                "settings": {"shop_domain": "acme.myshopify.com"},
            },
        ),
        ("GET", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/sync",
            {
                "cursor": "loyalty_cursor_1",
                "members": [{"email": "vip@example.com", "points_balance": 1200}],
                "events": [{"email": "vip@example.com", "event_name": "loyalty.points_earned"}],
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/backfill",
            {"members": [{"email": "lin@example.com"}]},
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/ingest",
            {"email": "vip@example.com", "event_name": "loyalty.reward_redeemed"},
        ),
        ("POST", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/provider-cleanup/acknowledge",
            {
                "completed_actions": ["api_token_revoked_or_rotated"],
                "notes": "Verified in Smile console.",
            },
        ),
        ("GET", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/runs?limit=10", None),
    ]


def test_native_support_resource_keeps_minimized_reads_and_locally_holds_runtime_effects():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"items": []})

    pw = _client(handler)
    integration_id = "11111111-1111-4111-8111-111111111111"
    cursor = "opaque+/=?&%cursor"
    pw.native_integrations.support.providers()
    pw.native_integrations.support.list()
    pw.native_integrations.support.list(limit=17, cursor=cursor)
    pw.native_integrations.support.get(integration_id)

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/support-integrations/providers", None),
        ("GET", "http://localhost:8080/api/v1/support-integrations", None),
        (
            "GET",
            "http://localhost:8080/api/v1/support-integrations?limit=17&cursor=opaque%2B%2F%3D%3F%26%25cursor",
            None,
        ),
        ("GET", f"http://localhost:8080/api/v1/support-integrations/{integration_id}", None),
    ]

    effects = [
        lambda: pw.native_integrations.support.create({"provider": "zendesk"}),
        lambda: pw.native_integrations.support.sync(integration_id, {}),
        lambda: pw.native_integrations.support.backfill(integration_id),
        lambda: pw.native_integrations.support.ingest(
            integration_id,
            {"email": "private@example.com", "event_name": "support.ticket_updated"},
        ),
        lambda: pw.native_integrations.support.pause(integration_id),
        lambda: pw.native_integrations.support.disconnect(integration_id),
        lambda: pw.native_integrations.support.runs(integration_id, limit=10),
        lambda: pw.native_integrations.support.runs("private-run-id", limit=0),
    ]
    for effect in effects:
        with pytest.raises(ServerError) as raised:
            effect()
        assert raised.value.status == 503
        assert raised.value.code == "support_integration_runtime_held"
    with pytest.raises(ValueError, match="canonical UUID"):
        pw.native_integrations.support.get("support/1")
    invalid_options = [
        {"limit": 0},
        {"limit": 101},
        {"limit": 1.5},
        {"limit": "10"},
        {"limit": True},
        {"cursor": ""},
        {"cursor": " surrounded"},
        {"cursor": "surrounded "},
        {"cursor": "opaque\0cursor"},
        {"cursor": "opaque\tcursor"},
        {"cursor": "opaque\ncursor"},
        {"cursor": "opaque\rcursor"},
        {"cursor": "opaque\u0085cursor"},
        {"cursor": "opaque\u061ccursor"},
        {"cursor": "opaque\u200bcursor"},
        {"cursor": "opaque\u202ecursor"},
        {"cursor": "opaque\u2066cursor"},
        {"cursor": "opaque\ufeffcursor"},
        {"cursor": "x" * 4097},
        {"cursor": 123},
    ]
    for options in invalid_options:
        with pytest.raises(ValueError, match="limit|cursor"):
            pw.native_integrations.support.list(**options)
    assert len(seen) == 4


def test_async_native_support_list_paginates_and_rejects_hostile_cursor_before_network():
    import asyncio

    from postwave import AsyncPostwave

    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        return httpx.Response(
            200,
            json={"items": [], "page": {"has_more": False, "next_cursor": None}},
        )

    async def run() -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://localhost:8080",
        )
        pw = AsyncPostwave(
            api_key="sk_test",
            tenant_id="acme",
            http_client=http,
            retries=0,
            base_url="http://localhost:8080",
        )
        cursor = "opaque+/=?&%cursor"
        try:
            await pw.native_integrations.support.list()
            await pw.native_integrations.support.list(limit=100, cursor=cursor)
            for hostile in [
                "",
                " surrounded",
                "surrounded ",
                "opaque\0cursor",
                "opaque\tcursor",
                "opaque\ncursor",
                "opaque\rcursor",
                "opaque\u0085cursor",
                "opaque\u061ccursor",
                "opaque\u200bcursor",
                "opaque\u202ecursor",
                "opaque\u2066cursor",
                "opaque\ufeffcursor",
                "x" * 4097,
                123,
            ]:
                with pytest.raises(ValueError, match="cursor"):
                    await pw.native_integrations.support.list(cursor=hostile)
        finally:
            await pw.aclose()

    asyncio.run(run())
    assert seen == [
        "http://localhost:8080/api/v1/support-integrations",
        "http://localhost:8080/api/v1/support-integrations?limit=100&cursor=opaque%2B%2F%3D%3F%26%25cursor",
    ]


def test_async_native_support_effects_are_held_without_network_or_input_echo():
    import asyncio

    from postwave import AsyncPostwave

    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    async def run() -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://localhost:8080",
        )
        pw = AsyncPostwave(
            api_key="sk_test",
            tenant_id="acme",
            http_client=http,
            retries=0,
            base_url="http://localhost:8080",
        )
        private_value = "private-support-token"
        try:
            effects = [
                lambda: pw.native_integrations.support.create(
                    {"provider": "zendesk", "credentials_ref": private_value}
                ),
                lambda: pw.native_integrations.support.sync(private_value, {}),
                lambda: pw.native_integrations.support.backfill(private_value),
                lambda: pw.native_integrations.support.ingest(
                    private_value, {"secret": private_value}
                ),
                lambda: pw.native_integrations.support.pause(private_value),
                lambda: pw.native_integrations.support.disconnect(private_value),
                lambda: pw.native_integrations.support.runs(private_value),
            ]
            for effect in effects:
                with pytest.raises(ServerError) as raised:
                    await effect()
                assert raised.value.status == 503
                assert raised.value.code == "support_integration_runtime_held"
                assert private_value not in str(raised.value)
        finally:
            await pw.aclose()

    asyncio.run(run())
    assert calls == 0


def test_native_provider_pull_resources_allow_empty_payloads():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "conn/1", "status": "completed", "items": []})

    pw = _client(handler)

    pw.native_integrations.commerce.sync("commerce/1", {"cursor": "shopify_cursor_1"})
    pw.native_integrations.commerce.backfill("commerce/1")
    pw.native_integrations.crm.sync("crm/1", {"cursor": "hubspot_cursor_1"})
    pw.native_integrations.crm.backfill("crm/1")
    pw.native_integrations.lead.sync("lead/1", {"cursor": "typeform_cursor_1"})
    pw.native_integrations.lead.backfill("lead/1")
    pw.native_integrations.reviews.sync("review/1", {"cursor": "yotpo_cursor_1"})
    pw.native_integrations.reviews.backfill("review/1")
    pw.native_integrations.loyalty.sync("loyalty/1", {"cursor": "smile_cursor_1"})
    pw.native_integrations.loyalty.backfill("loyalty/1")
    pw.native_integrations.subscriptions.sync("subscription/1", {"cursor": "recharge_cursor_1"})
    pw.native_integrations.subscriptions.backfill("subscription/1")
    pw.native_integrations.subscriptions.acknowledge_provider_cleanup(
        "subscription/1",
        {
            "completed_actions": ["api_token_revoked_or_rotated"],
            "notes": "Verified in Recharge console.",
        },
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1/sync",
            {"cursor": "shopify_cursor_1"},
        ),
        ("POST", "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1/backfill", {}),
        ("POST", "http://localhost:8080/api/v1/crm/integrations/crm%2F1/sync", {"cursor": "hubspot_cursor_1"}),
        ("POST", "http://localhost:8080/api/v1/crm/integrations/crm%2F1/backfill", {}),
        ("POST", "http://localhost:8080/api/v1/lead-integrations/lead%2F1/sync", {"cursor": "typeform_cursor_1"}),
        ("POST", "http://localhost:8080/api/v1/lead-integrations/lead%2F1/backfill", {}),
        ("POST", "http://localhost:8080/api/v1/review-integrations/review%2F1/sync", {"cursor": "yotpo_cursor_1"}),
        ("POST", "http://localhost:8080/api/v1/review-integrations/review%2F1/backfill", {}),
        ("POST", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/sync", {"cursor": "smile_cursor_1"}),
        ("POST", "http://localhost:8080/api/v1/loyalty-integrations/loyalty%2F1/backfill", {}),
        (
            "POST",
            "http://localhost:8080/api/v1/subscription-integrations/subscription%2F1/sync",
            {"cursor": "recharge_cursor_1"},
        ),
        ("POST", "http://localhost:8080/api/v1/subscription-integrations/subscription%2F1/backfill", {}),
        (
            "POST",
            "http://localhost:8080/api/v1/subscription-integrations/subscription%2F1/provider-cleanup/acknowledge",
            {
                "completed_actions": ["api_token_revoked_or_rotated"],
                "notes": "Verified in Recharge console.",
            },
        ),
    ]


def test_native_analytics_resource_uses_canonical_payload_shape():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        return httpx.Response(200, json={"id": "analytics/1", "status": "completed", "items": []})

    pw = _client(handler)
    pw.native_integrations.analytics.providers()
    pw.native_integrations.analytics.list()
    pw.native_integrations.analytics.create({
        "provider": "segment",
        "name": "Segment production",
        "credentials_ref": "vault://analytics/segment",
        "settings": {"source_id": "src_123"},
    })
    pw.native_integrations.analytics.get("analytics/1")
    pw.native_integrations.analytics.sync(
        "analytics/1",
        {
            "cursor": "cur_1",
            "profiles": [{"email": "ada@example.com"}],
            "events": [{"email": "ada@example.com", "event_name": "Viewed"}],
        },
    )
    pw.native_integrations.analytics.backfill("analytics/1", {"profiles": [{"email": "lin@example.com"}]})
    pw.native_integrations.analytics.ingest(
        "analytics/1",
        {"email": "ada@example.com", "event_name": "Checkout Started"},
    )
    pw.native_integrations.analytics.pause("analytics/1")
    pw.native_integrations.analytics.disconnect("analytics/1")
    pw.native_integrations.analytics.runs("analytics/1", limit=10)

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/analytics-integrations/providers", None),
        ("GET", "http://localhost:8080/api/v1/analytics-integrations", None),
        (
            "POST",
            "http://localhost:8080/api/v1/analytics-integrations",
            {
                "provider": "segment",
                "name": "Segment production",
                "credentials_ref": "vault://analytics/segment",
                "settings": {"source_id": "src_123"},
            },
        ),
        ("GET", "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1/sync",
            {
                "cursor": "cur_1",
                "profiles": [{"email": "ada@example.com"}],
                "events": [{"email": "ada@example.com", "event_name": "Viewed"}],
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1/backfill",
            {"profiles": [{"email": "lin@example.com"}]},
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1/ingest",
            {"email": "ada@example.com", "event_name": "Checkout Started"},
        ),
        ("POST", "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1", None),
        ("GET", "http://localhost:8080/api/v1/analytics-integrations/analytics%2F1/runs?limit=10", None),
    ]


def test_native_integrations_reject_empty_id_before_request():
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    pw = _client(handler)
    with pytest.raises(ValueError, match="native integration id is required"):
        pw.native_integrations.crm.sync(" ", {"contacts": [{"email": "ada@example.com"}]})
    with pytest.raises(ValueError, match="does not support ingest"):
        pw.native_integrations.crm.ingest("conn/1", {})
    with pytest.raises(ValueError, match="does not support ingest"):
        pw.native_integrations.marketing.ingest("marketing/1", {})
    assert calls == 0


def test_native_integrations_commerce_and_warehouse_route_to_first_party_surfaces():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content.decode()) if req.content else None
        seen.append((req.method, str(req.url), body))
        if req.method == "DELETE" and "/api/v1/commerce/integrations/" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "provider_cleanup": {
                        "provider": "stripe",
                        "status": "operator_action_required",
                        "postwave_status": "disconnected",
                        "provider_cleanup_posture": "operator_managed_stripe_dashboard",
                        "managed_provider_cleanup": False,
                        "provider_scope_type": "stripe_account_id",
                        "provider_scope_id": "acct_123",
                        "credential_ref_present": True,
                        "webhook_secret_ref_present": True,
                        "webhook_cleanup_status": "operator_delete_or_disable_stripe_webhook_endpoint",
                        "credential_cleanup_status": "operator_revoke_or_rotate_stripe_restricted_key",
                    },
                },
            )
        if req.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(200, json={"id": "conn/1", "provider": "snowflake", "status": "active", "items": []})

    pw = _client(handler)
    pw.native_integrations.commerce.providers()
    pw.native_integrations.commerce.list()
    pw.native_integrations.commerce.create({"provider": "bigcommerce", "settings": {"store_hash": "abc"}})
    pw.native_integrations.commerce.get("commerce/1")
    pw.native_integrations.commerce.sync(
        "commerce/1",
        {
            "cursor": "cur_1",
            "orders": [
                {"source_id": "order_1", "customer_email": "buyer@example.com"}
            ],
        },
    )
    pw.native_integrations.commerce.backfill(
        "commerce/1",
        {"products": [{"source_id": "product_1", "title": "Desk lamp"}]},
    )
    pw.native_integrations.commerce.pause("commerce/1")
    disconnected = pw.native_integrations.commerce.disconnect("commerce/1")
    assert disconnected["ok"] is True
    assert disconnected["provider_cleanup"]["provider_cleanup_posture"] == "operator_managed_stripe_dashboard"
    assert disconnected["provider_cleanup"]["credential_ref_present"] is True
    assert (
        disconnected["provider_cleanup"]["webhook_cleanup_status"]
        == "operator_delete_or_disable_stripe_webhook_endpoint"
    )

    pw.native_integrations.warehouse.providers()
    pw.native_integrations.warehouse.list()
    pw.native_integrations.warehouse.list(status="disconnected")
    pw.native_integrations.warehouse.create({"name": "Snowflake", "provider": "snowflake"})
    pw.native_integrations.warehouse.get("warehouse/1")
    pw.native_integrations.warehouse.health("warehouse/1")
    pw.native_integrations.warehouse.health("warehouse/1", provider_check=True)
    pw.native_integrations.warehouse.sync("warehouse/1", {"object_selection": ["profiles"]})
    pw.native_integrations.warehouse.backfill("warehouse/1", {"object_selection": ["profiles", "events"]})
    pw.native_integrations.warehouse.pause("warehouse/1")
    pw.native_integrations.warehouse.disconnect("warehouse/1")
    pw.native_integrations.warehouse.acknowledge_provider_cleanup(
        "warehouse/1",
        {
            "completed_actions": ["snowflake_roles_or_grants_removed"],
            "notes": "Verified in Snowflake console.",
        },
    )
    pw.native_integrations.warehouse.runs("warehouse/1", limit=5)

    assert seen == [
        ("GET", "http://localhost:8080/api/v1/commerce/providers", None),
        ("GET", "http://localhost:8080/api/v1/commerce/integrations", None),
        ("POST", "http://localhost:8080/api/v1/commerce/integrations", {"provider": "bigcommerce", "settings": {"store_hash": "abc"}}),
        ("GET", "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1/sync",
            {
                "cursor": "cur_1",
                "orders": [
                    {"source_id": "order_1", "customer_email": "buyer@example.com"}
                ],
            },
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1/backfill",
            {"products": [{"source_id": "product_1", "title": "Desk lamp"}]},
        ),
        ("POST", "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/commerce/integrations/commerce%2F1", None),
        ("GET", "http://localhost:8080/api/v1/warehouse/providers", None),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections", None),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections?status=disconnected", None),
        ("POST", "http://localhost:8080/api/v1/warehouse/connections", {"name": "Snowflake", "provider": "snowflake"}),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1", None),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/health", None),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/health?provider_check=true", None),
        ("POST", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/runs", {"object_selection": ["profiles"], "run_mode": "manual"}),
        ("POST", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/runs", {"object_selection": ["profiles", "events"], "run_mode": "backfill"}),
        ("POST", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/pause", None),
        ("DELETE", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1", None),
        (
            "POST",
            "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/provider-cleanup/acknowledge",
            {
                "completed_actions": ["snowflake_roles_or_grants_removed"],
                "notes": "Verified in Snowflake console.",
            },
        ),
        ("GET", "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/runs?limit=5", None),
    ]


def test_developer_marketplace_oauth_runtime_routes_to_canonical_paths():
    seen: list[tuple[str, str, dict[str, object], str | None, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((
            req.method,
            str(req.url),
            json.loads(req.content.decode() or "{}"),
            req.headers.get("idempotency-key"),
            req.headers.get("x-postwave-review-secret"),
        ))
        return httpx.Response(200, json={"status": "ok"})

    pw = _client(handler)
    app_body = {
        "name": "Inventory Sync",
        "slug": "inventory-sync",
        "app_type": "public",
        "distribution": "marketplace",
        "status": "draft",
        "scopes": ["read:subscribers"],
        "redirect_uris": ["https://partner.example/oauth/callback"],
        "api_revisions": ["2026-05-29"],
        "webhook_topics": ["profile.created"],
        "test_mode": True,
    }
    pw.developer_marketplace.catalog()
    pw.developer_marketplace.validate_app(app_body)
    pw.developer_marketplace.list_apps("draft")
    pw.developer_marketplace.create_app(app_body)
    pw.developer_marketplace.get_app("app/123")
    pw.developer_marketplace.update_app("app/123", app_body)
    pw.developer_marketplace.submit_app_review("app/123")
    pw.developer_marketplace.monitoring("app/123")
    pw.developer_marketplace.list_oauth_clients("app/123")
    pw.developer_marketplace.create_oauth_client("app/123", {
        "redirect_uris": ["https://partner.example/oauth/callback"],
        "scopes": ["read:subscribers"],
    })
    pw.developer_marketplace.revoke_oauth_client("app/123", "client/123")
    pw.developer_marketplace.list_test_accounts("app/123")
    pw.developer_marketplace.create_test_account("app/123", {
        "name": "Partner sandbox",
        "status": "active",
    })
    pw.developer_marketplace.list_listings("ecommerce")
    pw.developer_marketplace.upsert_listing("app/123", {
        "name": "Inventory Sync",
        "category": "ecommerce",
        "status": "draft",
        "review_state": "draft",
    })
    pw.developer_marketplace.submit_listing_review("app/123")
    pw.developer_marketplace.list_installations("installed")
    pw.developer_marketplace.install_app("app/123", {
        "installed_by": "ada@example.com",
        "status": "installed",
        "granted_scopes": ["read:subscribers"],
    })
    pw.developer_marketplace.revoke_installation("install/123")
    pw.developer_marketplace.list_webhook_subscriptions("app/123")
    pw.developer_marketplace.create_webhook_subscription("app/123", {
        "endpoint_url": "https://partner.example/postwave",
        "topics": ["profile.created"],
        "status": "active",
    })
    pw.developer_marketplace.list_partner_profiles("agency")
    pw.developer_marketplace.upsert_partner_profile({
        "organization_name": "Example Agency",
        "profile_type": "agency",
    })
    pw.developer_marketplace.submit_partner_profile_review()
    pw.developer_marketplace.review_queue("review-secret", kind="partner_profile", limit=25)
    pw.developer_marketplace.review_app_decision(
        "app/123",
        {
            "tenant_id": "00000000-0000-0000-0000-000000000000",
            "decision": "approve",
        },
        "review-secret",
    )
    pw.developer_marketplace.review_listing_decision(
        "app/123",
        {
            "tenant_id": "00000000-0000-0000-0000-000000000000",
            "decision": "approve",
            "partner_level": "certified",
        },
        "review-secret",
    )
    pw.developer_marketplace.review_partner_profile_decision(
        "tenant/123",
        {
            "decision": "approve",
            "partner_level": "premier",
        },
        "review-secret",
    )
    pw.developer_marketplace.list_audit_logs("app/123")
    pw.developer_marketplace.authorize({
        "response_type": "code",
        "client_id": "pw_oac_123",
        "redirect_uri": "https://partner.example/oauth/callback",
        "state": "st_123",
        "code_challenge": "challenge",
        "code_challenge_method": "S256",
    })
    pw.developer_marketplace.token({
        "grant_type": "authorization_code",
        "code": "pw_code_123",
        "redirect_uri": "https://partner.example/oauth/callback",
        "client_id": "pw_oac_123",
        "client_secret": "pw_oas_secret",
        "code_verifier": "verifier",
    })
    pw.developer_marketplace.revoke({
        "token": "pw_at_123",
        "client_id": "pw_oac_123",
        "client_secret": "pw_oas_secret",
    })

    route_map = [(method, url, body, review_secret) for method, url, body, _, review_secret in seen]
    assert route_map == [
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/catalog", {}, None),
        ("POST", "http://localhost:8080/api/v1/developer-marketplace/apps/validate", app_body, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps?status=draft", {}, None),
        ("POST", "http://localhost:8080/api/v1/developer-marketplace/apps", app_body, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123", {}, None),
        ("PATCH", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123", app_body, None),
        ("POST", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/submit-review", {}, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/monitoring", {}, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/oauth-clients", {}, None),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/oauth-clients",
            {
                "redirect_uris": ["https://partner.example/oauth/callback"],
                "scopes": ["read:subscribers"],
            },
            None,
        ),
        (
            "DELETE",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/oauth-clients/client%2F123",
            {},
            None,
        ),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/test-accounts", {}, None),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/test-accounts",
            {"name": "Partner sandbox", "status": "active"},
            None,
        ),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/listings?category=ecommerce", {}, None),
        (
            "PUT",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/listing",
            {
                "name": "Inventory Sync",
                "category": "ecommerce",
                "status": "draft",
                "review_state": "draft",
            },
            None,
        ),
        ("POST", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/listing/submit-review", {}, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/installations?status=installed", {}, None),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/installations",
            {
                "installed_by": "ada@example.com",
                "status": "installed",
                "granted_scopes": ["read:subscribers"],
            },
            None,
        ),
        ("DELETE", "http://localhost:8080/api/v1/developer-marketplace/installations/install%2F123", {}, None),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/webhook-subscriptions", {}, None),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/apps/app%2F123/webhook-subscriptions",
            {
                "endpoint_url": "https://partner.example/postwave",
                "topics": ["profile.created"],
                "status": "active",
            },
            None,
        ),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/partner-profiles?profile_type=agency", {}, None),
        (
            "PUT",
            "http://localhost:8080/api/v1/developer-marketplace/partner-profile",
            {"organization_name": "Example Agency", "profile_type": "agency"},
            None,
        ),
        ("POST", "http://localhost:8080/api/v1/developer-marketplace/partner-profile/submit-review", {}, None),
        (
            "GET",
            "http://localhost:8080/api/v1/developer-marketplace/review/queue?kind=partner_profile&limit=25",
            {},
            "review-secret",
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/review/apps/app%2F123/decision",
            {
                "tenant_id": "00000000-0000-0000-0000-000000000000",
                "decision": "approve",
            },
            "review-secret",
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/review/apps/app%2F123/listing/decision",
            {
                "tenant_id": "00000000-0000-0000-0000-000000000000",
                "decision": "approve",
                "partner_level": "certified",
            },
            "review-secret",
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/review/partner-profiles/tenant%2F123/decision",
            {"decision": "approve", "partner_level": "premier"},
            "review-secret",
        ),
        ("GET", "http://localhost:8080/api/v1/developer-marketplace/audit-logs?app_id=app%2F123", {}, None),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/oauth/authorize",
            {
                "response_type": "code",
                "client_id": "pw_oac_123",
                "redirect_uri": "https://partner.example/oauth/callback",
                "state": "st_123",
                "code_challenge": "challenge",
                "code_challenge_method": "S256",
            },
            None,
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/oauth/token",
            {
                "grant_type": "authorization_code",
                "code": "pw_code_123",
                "redirect_uri": "https://partner.example/oauth/callback",
                "client_id": "pw_oac_123",
                "client_secret": "pw_oas_secret",
                "code_verifier": "verifier",
            },
            None,
        ),
        (
            "POST",
            "http://localhost:8080/api/v1/developer-marketplace/oauth/revoke",
            {
                "token": "pw_at_123",
                "client_id": "pw_oac_123",
                "client_secret": "pw_oas_secret",
            },
            None,
        ),
    ]
    assert seen[-2][3] is None
    assert seen[-1][3] is None


def test_python_sdk_encodes_additional_dynamic_route_ids():
    seen: list[tuple[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url)))
        if req.url.path.endswith("/executions"):
            return httpx.Response(200, json={"executions": []})
        if "/inbox-reality/" in req.url.path or "/diagnose/" in req.url.path:
            return httpx.Response(200, json={"campaign_id": "campaign/a"})
        if req.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.subscribers.delete("sub/a")
    pw.forms.delete("form/a")
    pw.voice_profile.remove_source("source/a")
    pw.webhooks.delete("hook/a")
    pw.automations.pause("automation/a")
    pw.automations.list_executions("automation/a")
    assert pw.inbox_reality.get_campaign_report("campaign/a").campaign_id == "campaign/a"
    assert pw.inbox_reality.diagnose("campaign/a").campaign_id == "campaign/a"

    assert seen == [
        ("DELETE", "http://localhost:8080/api/v1/subscribers/sub%2Fa"),
        ("DELETE", "http://localhost:8080/api/v1/forms/form%2Fa"),
        ("DELETE", "http://localhost:8080/api/v1/voice/sources/source%2Fa"),
        ("DELETE", "http://localhost:8080/api/v1/outbound-webhooks/hook%2Fa"),
        ("POST", "http://localhost:8080/api/v1/automations/automation%2Fa/pause"),
        ("GET", "http://localhost:8080/api/v1/automations/automation%2Fa/executions"),
        ("GET", "http://localhost:8080/api/v1/inbox-reality/campaigns/campaign%2Fa"),
        ("POST", "http://localhost:8080/api/v1/diagnose/campaign%2Fa"),
    ]


def test_segments_update_url_encodes_id():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json={"id": "segment/a", "name": "After", "query_ast": {"op": "and"}})

    pw = _client(handler)
    out = pw.segments.update("segment/a", {"name": "After"})
    assert captured["url"] == "http://localhost:8080/api/v1/segments/segment%2Fa"
    assert captured["body"] == {"name": "After"}
    assert out["name"] == "After"


def test_sms_sdk_methods_route_to_expected_paths():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.sms.setup()
    pw.sms.create_list({"name": "VIP"})
    pw.sms.upsert_sender({"provider": "twilio"})
    sender_call_count = len(seen)
    for unsafe_sender in (
        {"brand_registration_sid": "BN_PRIVATE"},
        {"campaign_registration_sid": "QE_PRIVATE"},
        {"registration_status": "approved"},
    ):
        with pytest.raises(PostwaveError) as sender_error:
            pw.sms.upsert_sender(unsafe_sender)
        assert sender_error.value.status == 409
        assert (
            sender_error.value.code
            == "sms_registration_evidence_authority_required"
        )
    assert len(seen) == sender_call_count
    pw.sms.pause_sender("sender/a", reason="maintenance")
    pw.sms.resume_sender("sender/a")
    held_call_count = len(seen)
    for operation in (
        lambda: pw.sms.submit_brand_registration(
            "sender/private", {"company_name": "Private Acme"}
        ),
        lambda: pw.sms.submit_campaign_registration(
            "sender/private",
            {
                "description": "Private alerts",
                "message_flow": "Private flow",
                "message_samples": ["Private sample"],
            },
        ),
        lambda: pw.sms.poll_a2p_registration("sender/private"),
    ):
        with pytest.raises(PostwaveError) as a2p_error:
            operation()
        assert a2p_error.value.status == 503
        assert a2p_error.value.code == "sms_a2p_registration_release_held"
    assert len(seen) == held_call_count
    consent_call_count = len(seen)
    with pytest.raises(PostwaveError) as grant_error:
        pw.sms.record_consent(
            {
                "phone_e164": "+14155551212",
                "action": "granted",
                "source": "manual",
                "proof_text": "private proof",
            }
        )
    assert grant_error.value.status == 409
    assert grant_error.value.code == "carrier_resubscribe_authority_required"
    assert len(seen) == consent_call_count
    pw.sms.record_consent(
        {
            "phone_e164": "+14155551212",
            "action": "revoked",
            "source": "manual",
            "proof_text": "Operator revocation request",
        }
    )
    pw.sms.create_campaign({"name": "Launch", "body": "Hi"})
    scheduled_call_count = len(seen)
    with pytest.raises(PostwaveError) as create_schedule_error:
        pw.sms.create_campaign(
            {
                "name": "Private scheduled campaign",
                "body": "Private body",
                "status": "scheduled",
                "scheduled_at": "2026-08-23T12:00:00Z",
            }
        )
    assert create_schedule_error.value.status == 503
    assert create_schedule_error.value.code == "sms_campaign_schedule_release_held"
    assert len(seen) == scheduled_call_count
    confidential_campaign_id = "campaign/+14155551212/private"
    with pytest.raises(PostwaveError) as report_error:
        pw.sms.campaign_report(confidential_campaign_id)
    assert report_error.value.status == 503
    assert report_error.value.code == "sms_evidence_read_release_held"
    assert confidential_campaign_id not in str(report_error.value)
    with pytest.raises(PostwaveError) as export_error:
        pw.sms.export_campaign_report(confidential_campaign_id, status="failed", limit=10)
    assert export_error.value.status == 503
    assert export_error.value.code == "sms_evidence_read_release_held"
    assert confidential_campaign_id not in str(export_error.value)
    with pytest.raises(PostwaveError) as dispatch_error:
        pw.sms.send_campaign("campaign/private", {"limit": 5})
    assert dispatch_error.value.code == "sms_campaign_dispatch_release_held"
    with pytest.raises(PostwaveError) as schedule_error:
        pw.sms.schedule_campaign("campaign/private", "2026-05-19T12:00:00Z")
    assert schedule_error.value.code == "sms_campaign_schedule_release_held"
    pw.sms.pause_campaign("campaign/a")
    with pytest.raises(PostwaveError) as resume_error:
        pw.sms.resume_campaign("campaign/private")
    assert resume_error.value.code == "sms_campaign_resume_release_held"
    pw.sms.cancel_campaign("campaign/a")
    with pytest.raises(PostwaveError) as test_error:
        pw.sms.send_test(
            {
                "sender_profile_id": "sender/private",
                "list_id": "list/private",
                "to": "+14155551212",
                "body": "Private test body",
            }
        )
    assert test_error.value.code == "sms_test_dispatch_release_held"
    assert "Private" not in str(seen)
    assert "sender/private" not in str(seen)
    assert "campaign/private" not in str(seen)
    assert seen == [
        ("GET", "http://localhost:8080/api/v1/sms/setup", None),
        ("POST", "http://localhost:8080/api/v1/sms/lists", {"name": "VIP"}),
        ("POST", "http://localhost:8080/api/v1/sms/senders", {"provider": "twilio"}),
        ("POST", "http://localhost:8080/api/v1/sms/senders/sender%2Fa/pause", {"reason": "maintenance"}),
        ("POST", "http://localhost:8080/api/v1/sms/senders/sender%2Fa/resume", {}),
        (
            "POST",
            "http://localhost:8080/api/v1/sms/consent",
            {
                "phone_e164": "+14155551212",
                "action": "revoked",
                "source": "manual",
                "proof_text": "Operator revocation request",
            },
        ),
        ("POST", "http://localhost:8080/api/v1/sms/campaigns", {"name": "Launch", "body": "Hi"}),
        ("POST", "http://localhost:8080/api/v1/sms/campaigns/campaign%2Fa/pause", {}),
        ("POST", "http://localhost:8080/api/v1/sms/campaigns/campaign%2Fa/cancel", {}),
    ]


def test_async_sms_held_operations_fail_locally_without_network():
    import asyncio

    from postwave import AsyncPostwave

    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    async def run() -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://localhost:8080",
        )
        pw = AsyncPostwave(
            api_key="sk_test",
            tenant_id="acme",
            http_client=http,
            retries=0,
            base_url="http://localhost:8080",
        )
        secret = "campaign/+14155551212/private"
        try:
            with pytest.raises(PostwaveError) as report_error:
                await pw.sms.campaign_report(secret)
            assert report_error.value.code == "sms_evidence_read_release_held"
            assert secret not in str(report_error.value)

            with pytest.raises(PostwaveError) as export_error:
                await pw.sms.export_campaign_report(secret, status="failed", limit=10)
            assert export_error.value.code == "sms_evidence_read_release_held"
            assert secret not in str(export_error.value)

            held_operations = [
                (
                    lambda: pw.sms.upsert_sender(
                        {"brand_registration_sid": "BN_PRIVATE"}
                    ),
                    "sms_registration_evidence_authority_required",
                    409,
                ),
                (
                    lambda: pw.sms.submit_brand_registration(
                        "sender/private", {"company_name": "Private"}
                    ),
                    "sms_a2p_registration_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.submit_campaign_registration(
                        "sender/private", {"description": "Private"}
                    ),
                    "sms_a2p_registration_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.poll_a2p_registration("sender/private"),
                    "sms_a2p_registration_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.create_campaign(
                        {
                            "name": "Private scheduled campaign",
                            "body": "Private body",
                            "status": "scheduled",
                        }
                    ),
                    "sms_campaign_schedule_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.send_campaign("campaign/private", {"limit": 1}),
                    "sms_campaign_dispatch_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.schedule_campaign(
                        "campaign/private", "2026-05-19T12:00:00Z"
                    ),
                    "sms_campaign_schedule_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.resume_campaign("campaign/private"),
                    "sms_campaign_resume_release_held",
                    503,
                ),
                (
                    lambda: pw.sms.send_test(
                        {"to": "+14155551212", "body": "Private body"}
                    ),
                    "sms_test_dispatch_release_held",
                    503,
                ),
            ]
            for operation, expected_code, expected_status in held_operations:
                with pytest.raises(PostwaveError) as held_error:
                    await operation()
                assert held_error.value.status == expected_status
                assert held_error.value.code == expected_code

            with pytest.raises(PostwaveError) as consent_error:
                await pw.sms.record_consent(
                    {
                        "phone_e164": "+14155551212",
                        "action": "granted",
                        "source": "manual",
                        "proof_text": "Private proof",
                    }
                )
            assert consent_error.value.code == "carrier_resubscribe_authority_required"
        finally:
            await pw.aclose()

    asyncio.run(run())
    assert calls == 0


def test_migration_pilot_methods_route_to_expected_paths():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        if req.url.path.endswith("/pilot-acceptance"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "activecampaign",
                    "status": "pass",
                    "blockers": 0,
                    "warnings": 0,
                    "items": [],
                },
            )
        if req.url.path.endswith("/rollback-rehearsal"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "activecampaign",
                    "status": "warning",
                    "total_resources": 0,
                    "items": [],
                },
            )
        if req.url.path.endswith("/automation-rebuilds") and req.method == "GET":
            return httpx.Response(
                200,
                json={"items": [{"rank": 1, "name": "Welcome flow", "status": "not_started"}]},
            )
        if req.url.path.endswith("/automation-rebuilds") and req.method == "PATCH":
            return httpx.Response(
                200,
                json={"rank": 1, "name": "Welcome flow", "status": "test_passed"},
            )
        if req.url.path.endswith("/shadow-check"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "activecampaign",
                    "current_discovery": {},
                    "needs_delta_import": False,
                    "recommended_action": "ready_for_cutover_review",
                    "warnings": ["source inventory was stable"],
                    "deltas": [],
                },
            )
        if "shadow-monitor" in req.url.path:
            if req.method == "DELETE":
                return httpx.Response(200, json={"job_id": "job/a", "enabled": False})
            return httpx.Response(
                200,
                json={
                    "monitor": {
                        "job_id": "job/a",
                        "source": "activecampaign",
                        "enabled": True,
                        "interval_seconds": 3600,
                    },
                    "history": [],
                },
            )
        if req.url.path.endswith("/review"):
            return httpx.Response(
                200,
                json={
                    "id": "event/a",
                    "job_id": "job/a",
                    "source": "activecampaign",
                    "source_event_id": "[redacted-activecampaign-source-event-id]",
                    "resource_type": "activecampaign_non_email_contact",
                    "action": "manual_review",
                    "applied": False,
                    "review_status": "reviewed",
                    "review_detail": "Phone-only contact reconciled.",
                    "review_evidence": ["cutover-ticket-42"],
                },
            )
        if "source-events" in req.url.path:
            if req.method == "DELETE":
                return httpx.Response(
                    200,
                    json={
                        "job_id": "job/a",
                        "enabled": False,
                        "source_session_cleared": "post_pilot_cleanup=1" in str(req.url),
                    },
                )
            return httpx.Response(
                200,
                json={
                    "monitor": {
                        "job_id": "job/a",
                        "source": "activecampaign",
                        "enabled": True,
                        "interval_seconds": 3600,
                    },
                    "events": [],
                },
            )
        return httpx.Response(202, json={"job_id": "job/a", "mode": "delta_import"})

    pw = _client(handler)
    assert pw.migrations.delta_import("activecampaign", "job/a")["mode"] == "delta_import"
    shadow = pw.migrations.shadow_check("activecampaign", "job/a")
    assert shadow.recommended_action == "ready_for_cutover_review"
    assert shadow.warnings == ["source inventory was stable"]
    assert shadow.error is None
    assert pw.migrations.start_shadow_monitor("activecampaign", "job/a").monitor.enabled is True
    assert pw.migrations.shadow_monitor("job/a").monitor.enabled is True
    assert pw.migrations.stop_shadow_monitor("job/a")["enabled"] is False
    assert pw.migrations.start_source_events("activecampaign", "job/a").monitor.enabled is True
    assert pw.migrations.source_events("job/a").events == []
    assert pw.migrations.stop_source_events("job/a")["enabled"] is False
    cleanup = pw.migrations.stop_source_events("job/a", post_pilot_cleanup=True)
    assert cleanup["enabled"] is False
    assert cleanup["source_session_cleared"] is True
    reviewed = pw.migrations.update_source_event_review(
        "job/a",
        "event/a",
        {
            "status": "reviewed",
            "detail": "Phone-only contact reconciled.",
            "evidence": ["cutover-ticket-42"],
        },
    )
    assert reviewed.review_status == "reviewed"
    assert reviewed.applied is False
    assert pw.migrations.pilot_acceptance("job/a").status == "pass"
    assert pw.migrations.rollback_rehearsal("job/a").status == "warning"
    assert pw.migrations.automation_rebuilds("job/a")[0].name == "Welcome flow"
    assert pw.migrations.update_automation_rebuild("job/a", {"rank": 1, "status": "test_passed"}).status == "test_passed"

    paths = [(method, url.replace("http://localhost:8080", ""), body) for method, url, body in seen]
    assert paths[:4] == [
        ("POST", "/api/v1/migrations/activecampaign/delta-import", {"job_id": "job/a"}),
        ("POST", "/api/v1/migrations/activecampaign/shadow-check", {"job_id": "job/a"}),
        (
            "POST",
            "/api/v1/migrations/sources/activecampaign/shadow-monitor",
            {"job_id": "job/a", "interval_seconds": 3600},
        ),
        ("GET", "/api/v1/migrations/job%2Fa/shadow-monitor", None),
    ]
    assert (
        "PATCH",
        "/api/v1/migrations/job%2Fa/source-events/event%2Fa/review",
        {
            "status": "reviewed",
            "detail": "Phone-only contact reconciled.",
            "evidence": ["cutover-ticket-42"],
        },
    ) in paths


def test_migration_source_path_validation_and_encoding():
    assert source_path("activecampaign") == "activecampaign"
    assert source_path("klaviyo") == "klaviyo"
    assert source_path("customerio") == "customerio"
    assert source_path("constant-contact") == "constant-contact"
    assert source_path("campaign-monitor") == "campaign-monitor"
    with pytest.raises(ValueError, match="Unsupported migration source"):
        source_path("mailchimp_api")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="Unsupported migration source"):
        source_path("activecampaign/../../admin")  # type: ignore[arg-type]


def test_activecampaign_credentials_send_api_token_and_account_api_url():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        return httpx.Response(200, json={"job_id": "job/a", "account_id": "acme"})

    pw = _client(handler)
    pw.migrations.credentials(
        "activecampaign",
        api_key="new_token",
        account_id="https://acme.api-us1.com/api/3",
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/migrations/activecampaign/credentials",
            {
                "api_key": "new_token",
                "account_id": "https://acme.api-us1.com/api/3",
            },
        )
    ]


def test_hubspot_credentials_send_private_app_token_and_hub_id():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        return httpx.Response(200, json={"job_id": "job/a", "account_id": "12345"})

    pw = _client(handler)
    pw.migrations.credentials(
        "hubspot",
        api_key="pat-secret",
        account_id="12345",
        extra={"hub_id": "12345"},
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/migrations/hubspot/credentials",
            {
                "api_key": "pat-secret",
                "account_id": "12345",
                "extra": {"hub_id": "12345"},
            },
        )
    ]


def test_klaviyo_credentials_send_caller_managed_bearer_tokens():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content)))
        return httpx.Response(
            200,
            json={"job_id": "job/klaviyo", "account_id": "account_primary"},
        )

    _client(handler).migrations.credentials(
        "klaviyo",
        access_token="klaviyo-oauth-token",
        refresh_token="klaviyo-refresh-token",
        account_id="account_primary",
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/migrations/klaviyo/credentials",
            {
                "access_token": "klaviyo-oauth-token",
                "refresh_token": "klaviyo-refresh-token",
                "account_id": "account_primary",
            },
        )
    ]


def test_customerio_credentials_preserve_workspace_and_region():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content)))
        return httpx.Response(
            200,
            json={"job_id": "job/customerio", "account_id": "9001"},
        )

    _client(handler).migrations.credentials(
        "customerio",
        api_key="cio_app_key",
        account_id="9001",
        extra={"region": "eu"},
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/migrations/customerio/credentials",
            {
                "api_key": "cio_app_key",
                "account_id": "9001",
                "extra": {"region": "eu"},
            },
        )
    ]


def test_async_klaviyo_credentials_send_caller_managed_bearer_tokens():
    import asyncio

    from postwave import AsyncPostwave

    seen: list[dict | None] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(
            200,
            json={"job_id": "job/klaviyo", "account_id": "account_primary"},
        )

    async def run() -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://localhost:8080",
        )
        client = AsyncPostwave(
            api_key="sk_test",
            tenant_id="acme",
            http_client=http,
            retries=0,
            base_url="http://localhost:8080",
        )
        await client.migrations.credentials(
            "klaviyo",
            access_token="klaviyo-oauth-token",
            refresh_token="klaviyo-refresh-token",
            account_id="account_primary",
        )
        await client.aclose()

    asyncio.run(run())

    assert seen == [
        {
            "access_token": "klaviyo-oauth-token",
            "refresh_token": "klaviyo-refresh-token",
            "account_id": "account_primary",
        }
    ]


def test_beehiiv_credentials_bind_explicit_publication():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        return httpx.Response(200, json={"job_id": "job/a", "account_id": "pub_primary"})

    pw = _client(handler)
    pw.migrations.credentials(
        "beehiiv",
        api_key="beehiiv-secret",
        account_id="pub_primary",
        extra={"publication_id": "pub_primary"},
    )

    assert seen == [
        (
            "POST",
            "http://localhost:8080/api/v1/migrations/beehiiv/credentials",
            {
                "api_key": "beehiiv-secret",
                "account_id": "pub_primary",
                "extra": {"publication_id": "pub_primary"},
            },
        )
    ]


def test_beehiiv_shadow_check_exposes_logical_binding():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v1/migrations/beehiiv/shadow-check"
        return httpx.Response(
            200,
            json={
                "job_id": "job/a",
                "source": "beehiiv",
                "generated_at": "2026-07-16T00:00:00Z",
                "attempt_token": "a" * 64,
                "import_epoch": "b" * 64,
                "baseline_fingerprint": "c" * 64,
                "current_discovery": {},
                "needs_delta_import": False,
                "recommended_action": "ready_for_cutover_review",
                "deltas": [],
            },
        )

    shadow = _client(handler).migrations.shadow_check("beehiiv", "job/a")
    assert shadow.attempt_token == "a" * 64
    assert shadow.import_epoch == "b" * 64
    assert shadow.baseline_fingerprint == "c" * 64


def test_hubspot_pilot_bridge_methods_route_to_expected_paths():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), json.loads(req.content) if req.content else None))
        if req.url.path.endswith("/delta-import"):
            return httpx.Response(202, json={"job_id": "job/a", "mode": "delta_import"})
        if req.url.path.endswith("/shadow-check"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "hubspot",
                    "current_discovery": {},
                    "needs_delta_import": False,
                    "recommended_action": "ready_for_cutover_review",
                    "deltas": [],
                },
            )
        if req.url.path.endswith("/source-session"):
            return httpx.Response(200, json={"id": "job/a", "source": "hubspot", "status": "completed"})
        if req.url.path.endswith("/pilot-acceptance"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "hubspot",
                    "status": "pass",
                    "blockers": 0,
                    "warnings": 0,
                    "items": [],
                },
            )
        if req.url.path.endswith("/rollback-rehearsal"):
            return httpx.Response(
                200,
                json={
                    "job_id": "job/a",
                    "source": "hubspot",
                    "status": "pass",
                    "total_resources": 0,
                    "items": [],
                },
            )
        if "source-events" in req.url.path:
            if req.method == "DELETE":
                return httpx.Response(
                    200,
                    json={
                        "job_id": "job/a",
                        "enabled": False,
                        "source_session_cleared": "post_pilot_cleanup=1" in str(req.url),
                    },
                )
            return httpx.Response(
                200,
                json={
                    "monitor": {
                        "job_id": "job/a",
                        "source": "hubspot",
                        "enabled": True,
                        "interval_seconds": 900,
                    },
                    "events": [],
                },
            )
        return httpx.Response(200, json={"job_id": "job/a"})

    pw = _client(handler)
    assert pw.migrations.start_source_events("hubspot", "job/a", 900).monitor.enabled is True
    assert pw.migrations.source_events("job/a").events == []
    assert pw.migrations.delta_import("hubspot", "job/a")["mode"] == "delta_import"
    assert pw.migrations.shadow_check("hubspot", "job/a").recommended_action == "ready_for_cutover_review"
    assert pw.migrations.refresh_source_session(
        "job/a",
        {"api_key": "pat-secret-rotated", "account_id": "12345", "extra": {"portal_id": "12345"}},
    ).source == "hubspot"
    assert pw.migrations.pilot_acceptance("job/a").status == "pass"
    assert pw.migrations.rollback_rehearsal("job/a").status == "pass"
    assert pw.migrations.stop_source_events("job/a")["enabled"] is False
    cleanup = pw.migrations.stop_source_events("job/a", post_pilot_cleanup=True)
    assert cleanup["enabled"] is False
    assert cleanup["source_session_cleared"] is True

    paths = [(method, url.replace("http://localhost:8080", ""), body) for method, url, body in seen]
    assert paths == [
        (
            "POST",
            "/api/v1/migrations/sources/hubspot/source-events",
            {"job_id": "job/a", "interval_seconds": 900},
        ),
        ("GET", "/api/v1/migrations/job%2Fa/source-events", None),
        ("POST", "/api/v1/migrations/hubspot/delta-import", {"job_id": "job/a"}),
        ("POST", "/api/v1/migrations/hubspot/shadow-check", {"job_id": "job/a"}),
        (
            "POST",
            "/api/v1/migrations/job%2Fa/source-session",
            {"api_key": "pat-secret-rotated", "account_id": "12345", "extra": {"portal_id": "12345"}},
        ),
        ("GET", "/api/v1/migrations/job%2Fa/pilot-acceptance", None),
        ("GET", "/api/v1/migrations/job%2Fa/rollback-rehearsal", None),
        ("DELETE", "/api/v1/migrations/job%2Fa/source-events", None),
        (
            "DELETE",
            "/api/v1/migrations/job%2Fa/source-events?post_pilot_cleanup=1",
            None,
        ),
    ]


def test_migration_rejects_invalid_source_before_request():
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    pw = _client(handler)
    with pytest.raises(ValueError, match="Unsupported migration source"):
        pw.migrations.start("mailchimp_api")  # type: ignore[arg-type]
    assert calls == 0


def test_async_client_works():
    import asyncio

    from postwave import AsyncPostwave

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [], "total": 0, "page": 1, "per_page": 50})

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://localhost:8080")
    pw = AsyncPostwave(api_key="k", tenant_id="t", http_client=http, retries=0, base_url="http://localhost:8080")

    async def go():
        out = await pw.subscribers.list()
        assert out.total == 0
        await pw.aclose()

    asyncio.run(go())


def test_sms_suppressions_are_body_queried_and_strictly_decoded():
    tenant = "00000000-0000-0000-0000-000000000001"
    row = {
        "id": "33333333-3333-4333-8333-333333333333",
        "phone_e164": "+12025550101",
        "reason": "manual",
        "source": "manual",
        "created_at": "2026-08-28T09:00:00Z",
        "reversible": True,
    }
    seen: list[tuple[str, str, dict | None]] = []
    seen_idempotency_keys: list[str | None] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        seen.append((req.method, str(req.url), body))
        seen_idempotency_keys.append(req.headers.get("idempotency-key"))
        if req.method == "DELETE":
            return httpx.Response(
                200, json={"ok": True, "tenantId": tenant, "id": row["id"]}
            )
        if req.method == "POST" and str(req.url).endswith("/api/v1/sms/suppressions"):
            return httpx.Response(201, json=row)
        if str(req.url).endswith("/api/v1/sms/suppressions/query"):
            return httpx.Response(
                200,
                json={
                    "tenantId": tenant,
                    "items": [row],
                    "total": 1,
                    "snapshotAt": "2026-08-28T10:00:00Z",
                },
            )
        return httpx.Response(
            200,
            json={
                "tenantId": tenant,
                "items": [row],
                "total": 2,
                "nextCursor": "v1.bmV4dA",
                "snapshotAt": "2026-08-28T10:00:00Z",
            },
        )

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    pw = Moosewave(
        api_key="sk_test_admin",
        tenant_id=tenant,
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )
    page = pw.sms.list_suppressions(phone="+12025550101", reason="manual")
    assert page["total"] == 1
    assert "+12025550101" not in seen[0][1]
    assert seen[0] == (
        "POST",
        "http://localhost:8080/api/v1/sms/suppressions/query",
        {
            "reason": "manual",
            "phone": "+12025550101",
        },
    )
    assert seen_idempotency_keys[0] is None
    cursor_page = pw.sms.list_suppressions(
        reason="manual", cursor="v1.b3BhcXVl", limit=1
    )
    assert cursor_page["nextCursor"] == "v1.bmV4dA"
    assert pw.sms.add_suppression(phone="+12025550101") == row
    assert pw.sms.remove_suppression(row["id"]) == {
        "ok": True,
        "tenantId": tenant,
        "id": row["id"],
    }

    with pytest.raises(ValueError, match="canonical US/Canada"):
        pw.sms.list_suppressions(phone="letters12025550101")
    for invalid_cursor in ("opaque", "v2.token", "v1.bad.token", "v1."):
        with pytest.raises(ValueError, match="cursor"):
            pw.sms.list_suppressions(cursor=invalid_cursor)
    with pytest.raises(ValueError, match="cannot continue"):
        pw.sms.list_suppressions(
            phone="+12025550101", cursor="v1.b3BhcXVl", limit=1
        )
    with pytest.raises(ValueError, match="does not accept a limit"):
        pw.sms.list_suppressions(phone="+12025550101", limit=1)


def test_async_sms_suppression_exact_query_omits_idempotency_key():
    import asyncio

    from postwave import AsyncPostwave

    tenant = "00000000-0000-0000-0000-000000000001"
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(
            200,
            json={
                "tenantId": tenant,
                "items": [],
                "total": 0,
                "snapshotAt": "2026-08-28T10:00:00Z",
            },
        )

    async def run() -> None:
        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(
            transport=transport, base_url="http://localhost:8080"
        )
        pw = AsyncPostwave(
            api_key="sk_test_admin",
            tenant_id=tenant,
            http_client=http,
            retries=0,
            base_url="http://localhost:8080",
        )
        try:
            page = await pw.sms.list_suppressions(phone="+12025550101")
            assert page["total"] == 0
        finally:
            await pw.aclose()

    asyncio.run(run())
    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/v1/sms/suppressions/query"
    assert seen[0].headers.get("idempotency-key") is None


def test_sms_suppression_projection_time_and_cursor_poison_fail_closed():
    from postwave.resources.sms import _decode_sms_suppressions_page

    tenant = "00000000-0000-0000-0000-000000000001"
    row = {
        "id": "33333333-3333-4333-8333-333333333333",
        "phone_e164": "+12025550101",
        "reason": "manual",
        "source": "manual",
        "created_at": "2026-08-28T09:00:00Z",
        "reversible": True,
    }
    base = {
        "tenantId": tenant,
        "items": [row],
        "total": 1,
        "snapshotAt": "2026-08-28T10:00:00Z",
    }
    for poison in (
        {"snapshotAt": "1999-12-31T23:59:59Z"},
        {"snapshotAt": "2100-01-01T00:00:00Z"},
        {"snapshotAt": "2000-01-01T00:00:00+14:00"},
        {"snapshotAt": "2099-12-31T23:59:59-14:00"},
        {"nextCursor": "opaque", "total": 2},
        {"nextCursor": "v2.token", "total": 2},
    ):
        with pytest.raises(PostwaveError, match="Invalid SMS suppression"):
            _decode_sms_suppressions_page(
                {**base, **poison},
                expected_tenant_id=tenant,
                expected_limit=1,
            )
