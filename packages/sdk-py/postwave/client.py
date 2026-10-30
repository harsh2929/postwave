"""Sync + async Moosewave client.

Both classes share configuration and ergonomics; the only difference is
sync uses :class:`httpx.Client`, async uses :class:`httpx.AsyncClient`.
Resource accessors mirror the TS SDK::

    pw = Moosewave(api_key="sk_...", tenant_id="acme")
    page = pw.subscribers.list()

    apw = AsyncPostwave(api_key="sk_...", tenant_id="acme")
    page = await apw.subscribers.list()
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable

import httpx

from . import _http
from .errors import ParseError, PostwaveError
from .resources.account import AccountResource, AsyncAccountResource
from .resources.agency import AgencyResource, AsyncAgencyResource
from .resources.agent_mandates import (
    AgentMandatesResource,
    AsyncAgentMandatesResource,
)
from .resources.analytics import AnalyticsResource, AsyncAnalyticsResource
from .resources.api_keys import APIKeysResource, AsyncAPIKeysResource
from .resources.approvals import ApprovalsResource, AsyncApprovalsResource
from .resources.archive import ArchiveResource, AsyncArchiveResource
from .resources.assets import AssetsResource, AsyncAssetsResource
from .resources.ai_compose import AIComposeResource, AsyncAIComposeResource
from .resources.audience_destinations import AsyncAudienceDestinationsResource, AudienceDestinationsResource
from .resources.audience_syncs import AsyncAudienceSyncsResource, AudienceSyncsResource
from .resources.audiences import AsyncAudiencesResource, AudiencesResource
from .resources.audit import AuditResource, AsyncAuditResource
from .resources.audit_sinks import AuditSinksResource, AsyncAuditSinksResource
from .resources.automations import AutomationsResource, AsyncAutomationsResource
from .resources.auth_checks import AuthChecksResource, AsyncAuthChecksResource
from .resources.campaigns_ab import AsyncCampaignsABResource, CampaignsABResource
from .resources.campaigns import CampaignsResource, AsyncCampaignsResource
from .resources.campaign_assurance import (
    AsyncCampaignAssuranceResource,
    CampaignAssuranceResource,
)
from .resources.campaign_polls import AsyncCampaignPollsResource, CampaignPollsResource
from .resources.campaign_templates import (
    AsyncCampaignTemplatesResource,
    CampaignTemplatesResource,
)
from .resources.conversion_ingest import (
    AsyncConversionIngestResource,
    ConversionIngestResource,
)
from .resources.conversion_ingest_secrets import (
    AsyncConversionIngestSecretsResource,
    ConversionIngestSecretsResource,
)
from .resources.chat_integrations import AsyncChatIntegrationsResource, ChatIntegrationsResource
from .resources.cost import AsyncCostResource, CostResource
from .resources.custom_domains import AsyncCustomDomainsResource, CustomDomainsResource
from .resources.discounts import AsyncDiscountsResource, DiscountsResource
from .resources.dmarc import AsyncDmarcResource, DmarcResource
from .resources.developer_marketplace import AsyncDeveloperMarketplaceResource, DeveloperMarketplaceResource
from .resources.events import EventsResource, AsyncEventsResource
from .resources.forms import FormsResource, AsyncFormsResource
from .resources.gift_subscriptions import AsyncGiftSubscriptionsResource, GiftSubscriptionsResource
from .resources.inbound_emails import AsyncInboundEmailsResource, InboundEmailsResource
from .resources.inbound_routes import AsyncInboundRoutesResource, InboundRoutesResource
from .resources.inbound_webhooks import AsyncInboundWebhooksResource, InboundWebhooksResource
from .resources.inbox_reality import InboxRealityResource, AsyncInboxRealityResource
from .resources.integrations import AsyncIntegrationsResource, IntegrationsResource
from .resources.landing_pages import LandingPagesResource, AsyncLandingPagesResource
from .resources.link_check import AsyncLinkCheckResource, LinkCheckResource
from .resources.lists import AsyncListsResource, ListsResource
from .resources.migrations import MigrationsResource, AsyncMigrationsResource
from .resources.mobile_push import AsyncMobilePushResource, MobilePushResource
from .resources.native_integrations import AsyncNativeIntegrationsResource, NativeIntegrationsResource
from .resources.preferences import AsyncPreferencesResource, PreferencesResource
from .resources.referrals import AsyncReferralsResource, ReferralsResource
from .resources.reputation import ReputationResource, AsyncReputationResource
from .resources.safety import AsyncSafetyResource, SafetyResource
from .resources.sandbox import AsyncSandboxResource, SandboxResource
from .resources.scim import AsyncScimResource, ScimResource
from .resources.send_time import AsyncSendTimeResource, SendTimeResource
from .resources.sending_settings import AsyncSendingSettingsResource, SendingSettingsResource
from .resources.sending import SendingResource, AsyncSendingResource
from .resources.emails import EmailsResource, AsyncEmailsResource
from .resources.segments import SegmentsResource, AsyncSegmentsResource
from .resources.sequences import SequencesResource, AsyncSequencesResource
from .resources.slack_integrations import SlackIntegrationsResource, AsyncSlackIntegrationsResource
from .resources.sms import AsyncSmsResource, SmsResource
from .resources.push_suppressions import AsyncPushSuppressionsResource, PushSuppressionsResource
from .resources.subscribers import SubscribersResource, AsyncSubscribersResource
from .resources.suppressions import AsyncSuppressionsResource, SuppressionsResource
from .resources.tags import AsyncTagsResource, TagsResource
from .resources.template_preview import AsyncTemplatePreviewResource, TemplatePreviewResource
from .resources.templates import TemplatesResource, AsyncTemplatesResource
from .resources.topics import AsyncTopicsResource, TopicsResource
from .resources.track import AsyncTrackResource, TrackResource
from .resources.voice_drift import AsyncVoiceDriftResource, VoiceDriftResource
from .resources.voice_profile import VoiceProfileResource, AsyncVoiceProfileResource
from .resources.onboarding import AsyncOnboardingResource, OnboardingResource
from .resources.webhooks import WebhooksResource, AsyncWebhooksResource

DEFAULT_BASE = "https://api.moosewave.com"
DEFAULT_TIMEOUT = 30.0
DEFAULT_RETRIES = 3


def _request_attempt_limit(retries: int, max_attempts: Any) -> int:
    """Return a fail-closed wire-attempt bound for one logical request.

    ``max_attempts`` is an endpoint-level safety control, not another retry
    count. Invalid explicit values therefore collapse to one attempt instead
    of silently falling back to the client-wide retry policy.
    """
    if max_attempts is None:
        return max(1, retries + 1)
    if (
        isinstance(max_attempts, int)
        and not isinstance(max_attempts, bool)
        and max_attempts >= 1
    ):
        return max_attempts
    return 1


class Moosewave:
    """Synchronous Moosewave client."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        tenant_id: str | None = None,
        base_url: str = DEFAULT_BASE,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        http_client: httpx.Client | None = None,
    ) -> None:
        if api_key is not None:
            if not api_key:
                raise ValueError("api_key must not be empty when supplied")
            _http.validate_header_value("api_key", api_key)
        if tenant_id is not None:
            _http.validate_header_value("tenant_id", tenant_id)
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.base_url = _http.normalize_base_url(base_url)
        self.timeout = timeout
        self.retries = retries
        # Allow callers to inject a pre-configured client (handy for tests via
        # httpx.MockTransport) and we'll re-use it.
        self._http = http_client or httpx.Client(timeout=timeout)
        self._owns_http = http_client is None

        self.account = AccountResource(self)
        self.agency = AgencyResource(self)
        self.agent_mandates = AgentMandatesResource(self)
        self.migrations = MigrationsResource(self)
        self.mobile_push = MobilePushResource(self)
        self.native_integrations = NativeIntegrationsResource(self)
        self.subscribers = SubscribersResource(self)
        self.sequences = SequencesResource(self)
        self.templates = TemplatesResource(self)
        self.voice_drift = VoiceDriftResource(self)
        self.voice_profile = VoiceProfileResource(self)
        self.forms = FormsResource(self)
        self.inbox_reality = InboxRealityResource(self)
        self.reputation = ReputationResource(self)
        self.auth_checks = AuthChecksResource(self)
        self.campaigns = CampaignsResource(self)
        self.campaign_assurance = CampaignAssuranceResource(self)
        self.campaign_polls = CampaignPollsResource(self)
        self.conversion_ingest = ConversionIngestResource(self)
        self.conversion_ingest_secrets = ConversionIngestSecretsResource(self)
        self.campaign_templates = CampaignTemplatesResource(self)
        self.sending = SendingResource(self)
        self.emails = EmailsResource(self)
        self.automations = AutomationsResource(self)
        self.onboarding = OnboardingResource(self)
        self.webhooks = WebhooksResource(self)
        self.api_keys = APIKeysResource(self)
        self.chat_integrations = ChatIntegrationsResource(self)
        self.discord_integrations = self.chat_integrations.discord
        self.slack_integrations = SlackIntegrationsResource(self)
        self.teams_integrations = self.chat_integrations.teams
        self.sms = SmsResource(self)
        self.push_suppressions = PushSuppressionsResource(self)
        self.landing_pages = LandingPagesResource(self)
        self.analytics = AnalyticsResource(self)
        self.events = EventsResource(self)
        self.segments = SegmentsResource(self)
        self.approvals = ApprovalsResource(self)
        self.archive = ArchiveResource(self)
        self.assets = AssetsResource(self)
        self.audience_destinations = AudienceDestinationsResource(self)
        self.audience_syncs = AudienceSyncsResource(self)
        self.ai_compose = AIComposeResource(self)
        self.audiences = AudiencesResource(self)
        self.audit = AuditResource(self)
        self.audit_sinks = AuditSinksResource(self)
        self.campaigns_ab = CampaignsABResource(self)
        self.cost = CostResource(self)
        self.custom_domains = CustomDomainsResource(self)
        self.developer_marketplace = DeveloperMarketplaceResource(self)
        self.discounts = DiscountsResource(self)
        self.dmarc = DmarcResource(self)
        self.gift_subscriptions = GiftSubscriptionsResource(self)
        self.inbound_emails = InboundEmailsResource(self)
        self.inbound_routes = InboundRoutesResource(self)
        self.inbound_webhooks = InboundWebhooksResource(self)
        self.integrations = IntegrationsResource(self)
        self.link_check = LinkCheckResource(self)
        self.lists = ListsResource(self)
        self.preferences = PreferencesResource(self)
        self.referrals = ReferralsResource(self)
        self.safety = SafetyResource(self)
        self.sandbox = SandboxResource(self)
        self.scim = ScimResource(self)
        self.send_time = SendTimeResource(self)
        self.sending_settings = SendingSettingsResource(self)
        self.suppressions = SuppressionsResource(self)
        self.tags = TagsResource(self)
        self.template_preview = TemplatePreviewResource(self)
        self.topics = TopicsResource(self)
        self.track = TrackResource(self)

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Moosewave:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        raw_body: bytes | str | None = None,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: Any = _http.AUTO,
        omit_authentication: bool = False,
        on_response_headers: Callable[[httpx.Headers], None] | None = None,
        expected_status: int | None = None,
        max_attempts: Any = None,
        follow_redirects: bool | None = None,
    ) -> Any:
        if body is not None and raw_body is not None:
            raise ValueError("pass body or raw_body, not both")
        url, hdrs, params, json_body = _http.build_request(
            method=method, base_url=self.base_url, path=path,
            api_key=self.api_key, tenant_id=self.tenant_id,
            body=None if raw_body is not None else body, query=query, extra_headers=headers,
        )
        if omit_authentication:
            for name in list(hdrs):
                if name.lower() in {"authorization", "x-tenant-slug"}:
                    del hdrs[name]
        # Resolve & pin BEFORE the retry loop so every attempt of this
        # logical call sends the SAME key. That's how server-side dedup
        # turns a network-level retry storm into one row.
        ikey = _http.resolve_idempotency_key(
            method=method, headers=hdrs, idempotency_key=idempotency_key,
        )
        if idempotency_key is None:
            for name in list(hdrs):
                if name.lower() == "idempotency-key":
                    del hdrs[name]
        elif ikey is not None:
            hdrs["Idempotency-Key"] = ikey

        attempt_limit = _request_attempt_limit(self.retries, max_attempts)
        last_err: PostwaveError | None = None
        for attempt in range(attempt_limit):
            try:
                request_body = (
                    {"content": raw_body}
                    if raw_body is not None
                    else {"json": json_body}
                )
                if idempotency_key is None:
                    request = self._http.build_request(
                        method, url, headers=hdrs, params=params, **request_body
                    )
                    # httpx merges Client-level default headers after our
                    # dictionary is built. Remove this header from the final
                    # request object so opt-out is an actual wire guarantee.
                    request.headers.pop("Idempotency-Key", None)
                    resp = self._http.send(
                        request,
                        **(
                            {"follow_redirects": follow_redirects}
                            if follow_redirects is not None
                            else {}
                        ),
                    )
                else:
                    resp = self._http.request(
                        method,
                        url,
                        headers=hdrs,
                        params=params,
                        **request_body,
                        **(
                            {"follow_redirects": follow_redirects}
                            if follow_redirects is not None
                            else {}
                        ),
                    )
            except httpx.HTTPError as e:
                if attempt + 1 < attempt_limit and _http.retry_is_safe(
                    method, hdrs
                ):
                    time.sleep(_http.compute_backoff(attempt))
                    continue
                raise PostwaveError(str(e), status=0, code="network_error") from e
            if on_response_headers is not None:
                on_response_headers(resp.headers)
            try:
                _http.raise_for_response(resp)
            except PostwaveError as e:
                if (
                    attempt + 1 < attempt_limit
                    and _http.should_retry(e)
                    and _http.retry_is_safe(method, hdrs)
                ):
                    time.sleep(
                        _http.compute_backoff(
                            attempt,
                            retry_after_header=resp.headers.get("retry-after"),
                            retry_after_body=getattr(e, "retry_after_seconds", None),
                        )
                    )
                    last_err = e
                    continue
                raise
            if expected_status is not None and resp.status_code != expected_status:
                raise ParseError(
                    f"Unexpected successful HTTP {resp.status_code}; expected {expected_status}",
                    status=resp.status_code,
                    request_id=resp.headers.get("x-request-id"),
                )
            return _http.parse_response(resp)
        assert last_err is not None
        raise last_err


class AsyncPostwave:
    """Asynchronous Moosewave client (httpx.AsyncClient under the hood)."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        tenant_id: str | None = None,
        base_url: str = DEFAULT_BASE,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if api_key is not None:
            if not api_key:
                raise ValueError("api_key must not be empty when supplied")
            _http.validate_header_value("api_key", api_key)
        if tenant_id is not None:
            _http.validate_header_value("tenant_id", tenant_id)
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.base_url = _http.normalize_base_url(base_url)
        self.timeout = timeout
        self.retries = retries
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self._owns_http = http_client is None

        self.account = AsyncAccountResource(self)
        self.agency = AsyncAgencyResource(self)
        self.agent_mandates = AsyncAgentMandatesResource(self)
        self.migrations = AsyncMigrationsResource(self)
        self.mobile_push = AsyncMobilePushResource(self)
        self.native_integrations = AsyncNativeIntegrationsResource(self)
        self.subscribers = AsyncSubscribersResource(self)
        self.sequences = AsyncSequencesResource(self)
        self.templates = AsyncTemplatesResource(self)
        self.voice_drift = AsyncVoiceDriftResource(self)
        self.voice_profile = AsyncVoiceProfileResource(self)
        self.forms = AsyncFormsResource(self)
        self.inbox_reality = AsyncInboxRealityResource(self)
        self.reputation = AsyncReputationResource(self)
        self.auth_checks = AsyncAuthChecksResource(self)
        self.campaigns = AsyncCampaignsResource(self)
        self.campaign_assurance = AsyncCampaignAssuranceResource(self)
        self.campaign_polls = AsyncCampaignPollsResource(self)
        self.conversion_ingest = AsyncConversionIngestResource(self)
        self.conversion_ingest_secrets = AsyncConversionIngestSecretsResource(self)
        self.campaign_templates = AsyncCampaignTemplatesResource(self)
        self.sending = AsyncSendingResource(self)
        self.emails = AsyncEmailsResource(self)
        self.automations = AsyncAutomationsResource(self)
        self.onboarding = AsyncOnboardingResource(self)
        self.webhooks = AsyncWebhooksResource(self)
        self.api_keys = AsyncAPIKeysResource(self)
        self.chat_integrations = AsyncChatIntegrationsResource(self)
        self.discord_integrations = self.chat_integrations.discord
        self.slack_integrations = AsyncSlackIntegrationsResource(self)
        self.teams_integrations = self.chat_integrations.teams
        self.sms = AsyncSmsResource(self)
        self.push_suppressions = AsyncPushSuppressionsResource(self)
        self.landing_pages = AsyncLandingPagesResource(self)
        self.analytics = AsyncAnalyticsResource(self)
        self.events = AsyncEventsResource(self)
        self.segments = AsyncSegmentsResource(self)
        self.approvals = AsyncApprovalsResource(self)
        self.archive = AsyncArchiveResource(self)
        self.assets = AsyncAssetsResource(self)
        self.audience_destinations = AsyncAudienceDestinationsResource(self)
        self.audience_syncs = AsyncAudienceSyncsResource(self)
        self.ai_compose = AsyncAIComposeResource(self)
        self.audiences = AsyncAudiencesResource(self)
        self.audit = AsyncAuditResource(self)
        self.audit_sinks = AsyncAuditSinksResource(self)
        self.campaigns_ab = AsyncCampaignsABResource(self)
        self.cost = AsyncCostResource(self)
        self.custom_domains = AsyncCustomDomainsResource(self)
        self.developer_marketplace = AsyncDeveloperMarketplaceResource(self)
        self.discounts = AsyncDiscountsResource(self)
        self.dmarc = AsyncDmarcResource(self)
        self.gift_subscriptions = AsyncGiftSubscriptionsResource(self)
        self.inbound_emails = AsyncInboundEmailsResource(self)
        self.inbound_routes = AsyncInboundRoutesResource(self)
        self.inbound_webhooks = AsyncInboundWebhooksResource(self)
        self.integrations = AsyncIntegrationsResource(self)
        self.link_check = AsyncLinkCheckResource(self)
        self.lists = AsyncListsResource(self)
        self.preferences = AsyncPreferencesResource(self)
        self.referrals = AsyncReferralsResource(self)
        self.safety = AsyncSafetyResource(self)
        self.sandbox = AsyncSandboxResource(self)
        self.scim = AsyncScimResource(self)
        self.send_time = AsyncSendTimeResource(self)
        self.sending_settings = AsyncSendingSettingsResource(self)
        self.suppressions = AsyncSuppressionsResource(self)
        self.tags = AsyncTagsResource(self)
        self.template_preview = AsyncTemplatePreviewResource(self)
        self.topics = AsyncTopicsResource(self)
        self.track = AsyncTrackResource(self)

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncPostwave:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        raw_body: bytes | str | None = None,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: Any = _http.AUTO,
        omit_authentication: bool = False,
        on_response_headers: Callable[[httpx.Headers], None] | None = None,
        expected_status: int | None = None,
        max_attempts: Any = None,
        follow_redirects: bool | None = None,
    ) -> Any:
        if body is not None and raw_body is not None:
            raise ValueError("pass body or raw_body, not both")
        url, hdrs, params, json_body = _http.build_request(
            method=method, base_url=self.base_url, path=path,
            api_key=self.api_key, tenant_id=self.tenant_id,
            body=None if raw_body is not None else body, query=query, extra_headers=headers,
        )
        if omit_authentication:
            for name in list(hdrs):
                if name.lower() in {"authorization", "x-tenant-slug"}:
                    del hdrs[name]
        # See sync Moosewave.request — same invariant: pin once before retries.
        ikey = _http.resolve_idempotency_key(
            method=method, headers=hdrs, idempotency_key=idempotency_key,
        )
        if idempotency_key is None:
            for name in list(hdrs):
                if name.lower() == "idempotency-key":
                    del hdrs[name]
        elif ikey is not None:
            hdrs["Idempotency-Key"] = ikey

        attempt_limit = _request_attempt_limit(self.retries, max_attempts)
        last_err: PostwaveError | None = None
        for attempt in range(attempt_limit):
            try:
                request_body = (
                    {"content": raw_body}
                    if raw_body is not None
                    else {"json": json_body}
                )
                if idempotency_key is None:
                    request = self._http.build_request(
                        method, url, headers=hdrs, params=params, **request_body
                    )
                    request.headers.pop("Idempotency-Key", None)
                    resp = await self._http.send(
                        request,
                        **(
                            {"follow_redirects": follow_redirects}
                            if follow_redirects is not None
                            else {}
                        ),
                    )
                else:
                    resp = await self._http.request(
                        method,
                        url,
                        headers=hdrs,
                        params=params,
                        **request_body,
                        **(
                            {"follow_redirects": follow_redirects}
                            if follow_redirects is not None
                            else {}
                        ),
                    )
            except httpx.HTTPError as e:
                if attempt + 1 < attempt_limit and _http.retry_is_safe(
                    method, hdrs
                ):
                    await asyncio.sleep(_http.compute_backoff(attempt))
                    continue
                raise PostwaveError(str(e), status=0, code="network_error") from e
            if on_response_headers is not None:
                on_response_headers(resp.headers)
            try:
                _http.raise_for_response(resp)
            except PostwaveError as e:
                if (
                    attempt + 1 < attempt_limit
                    and _http.should_retry(e)
                    and _http.retry_is_safe(method, hdrs)
                ):
                    await asyncio.sleep(
                        _http.compute_backoff(
                            attempt,
                            retry_after_header=resp.headers.get("retry-after"),
                            retry_after_body=getattr(e, "retry_after_seconds", None),
                        )
                    )
                    last_err = e
                    continue
                raise
            if expected_status is not None and resp.status_code != expected_status:
                raise ParseError(
                    f"Unexpected successful HTTP {resp.status_code}; expected {expected_status}",
                    status=resp.status_code,
                    request_id=resp.headers.get("x-request-id"),
                )
            return _http.parse_response(resp)
        assert last_err is not None
        raise last_err
