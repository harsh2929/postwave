/**
 * PostwaveClient — the entry point for every SDK call.
 *
 * Construction:
 *   const pw = new PostwaveClient({
 *     apiKey: process.env.POSTWAVE_API_KEY!,
 *     tenantId: "acme",            // local-dev only; production API keys carry tenant scope
 *     baseUrl: "https://api.moosewave.com",
 *   });
 *
 * Then drill down via sub-resources:
 *   await pw.subscribers.list();
 *   await pw.sequences.generate({ template_id: "tpl_welcome_3", name: "Welcome" });
 */

import {
  mapError,
  NetworkError,
  ParseError,
  PostwaveError,
  RateLimitError,
  RequestAbortedError,
  responseMetadataFromHeaders,
  ServerError,
  TimeoutError,
} from "./errors.js";
import { MigrationsResource } from "./resources/migrations.js";
import { SubscribersResource } from "./resources/subscribers.js";
import { SequencesResource } from "./resources/sequences.js";
import { TemplatesResource } from "./resources/templates.js";
import { VoiceProfileResource } from "./resources/voice-profile.js";
import { FormsResource } from "./resources/forms.js";
import { InboxRealityResource } from "./resources/inbox-reality.js";
import { ReputationResource } from "./resources/reputation.js";
import { AuthChecksResource } from "./resources/auth-checks.js";
import { SendingResource } from "./resources/sending.js";
import { EmailsResource } from "./resources/emails.js";
import { AutomationsResource } from "./resources/automations.js";
import { WebhooksResource } from "./resources/webhooks.js";
import { CampaignsResource } from "./resources/campaigns.js";
import { CampaignAssuranceResource } from "./resources/campaign-assurance.js";
import { CampaignPollsResource } from "./resources/campaign-polls.js";
import { ConversionIngestResource } from "./resources/conversion-ingest.js";
import { ConversionIngestSecretsResource } from "./resources/conversion-ingest-secrets.js";
import { CampaignTemplatesResource } from "./resources/campaign-templates.js";
import { CampaignsABResource } from "./resources/campaigns-ab.js";
import { EventsResource } from "./resources/events.js";
import { SegmentsResource } from "./resources/segments.js";
import { TopicsResource } from "./resources/topics.js";
import { APIKeysResource } from "./resources/api-keys.js";
import { AuditResource } from "./resources/audit.js";
import { ApprovalsResource } from "./resources/approvals.js";
import { SandboxResource } from "./resources/sandbox.js";
import { CostResource } from "./resources/cost.js";
import { SafetyResource } from "./resources/safety.js";
import { AccountResource } from "./resources/account.js";
import { OnboardingResource } from "./resources/onboarding.js";
import { AudienceDestinationsResource } from "./resources/audience-destinations.js";
import { AudienceSyncsResource } from "./resources/audience-syncs.js";
import { AIComposeResource } from "./resources/ai-compose.js";
import { AudiencesResource } from "./resources/audiences.js";
import { IntegrationsResource } from "./resources/integrations.js";
import { NativeIntegrationsResource } from "./resources/native-integrations.js";
import { DeveloperMarketplaceResource } from "./resources/developer-marketplace.js";
import type { ChatIntegrationChannelResource } from "./resources/chat-integrations.js";
import { ChatIntegrationsResource } from "./resources/chat-integrations.js";
import { SlackIntegrationsResource } from "./resources/slack-integrations.js";
import { LandingPagesResource } from "./resources/landing-pages.js";
import { AnalyticsResource } from "./resources/analytics.js";
// X1+X2+X3 resource additions — net-new SDK surface for audience, sending,
// platform, paid, and forms+web domains.
import { ListsResource } from "./resources/lists.js";
import { TagsResource } from "./resources/tags.js";
import { SuppressionsResource } from "./resources/suppressions.js";
import { SendingSettingsResource } from "./resources/sending-settings.js";
import { AssetsResource } from "./resources/assets.js";
import { InboundWebhooksResource } from "./resources/inbound-webhooks.js";
import { TrackResource } from "./resources/track.js";
import { InboundEmailsResource } from "./resources/inbound-emails.js";
import { DmarcResource } from "./resources/dmarc.js";
import { DiscountsResource } from "./resources/discounts.js";
import { GiftSubscriptionsResource } from "./resources/gift-subscriptions.js";
import { SendTimeResource } from "./resources/send-time.js";
import { TemplatePreviewResource } from "./resources/template-preview.js";
import { CustomDomainsResource } from "./resources/custom-domains.js";
import { LinkCheckResource } from "./resources/link-check.js";
import { ArchiveResource } from "./resources/archive.js";
import { ReferralsResource } from "./resources/referrals.js";
import { SmsResource } from "./resources/sms.js";
import { PushSuppressionsResource } from "./resources/push-suppressions.js";
import { AgencyResource } from "./resources/agency.js";
import { AuditSinksResource } from "./resources/audit-sinks.js";
import { InboundRoutesResource } from "./resources/inbound-routes.js";
import { AgentMandatesResource } from "./resources/agent-mandates.js";
import { ScimResource } from "./resources/scim.js";
import { VoiceDriftResource } from "./resources/voice-drift.js";
import { MobilePushResource } from "./resources/mobile-push.js";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type PostwaveAuthMode = "api_key" | "session" | "none";

export interface PostwaveClientOptions {
  apiKey?: string;
  /**
   * api_key signs requests with `Authorization: Bearer pw_...`.
   * session relies on origin-scoped cookies (mobile/web app users).
   * none is for unauthenticated/public endpoints.
   */
  authMode?: PostwaveAuthMode;
  baseUrl?: string;
  /**
   * Permit `http://` to a PRIVATE-NETWORK host (RFC1918 / link-local), not just
   * loopback.
   *
   * OFF BY DEFAULT and deliberately explicit. The default policy — http only to
   * localhost — exists because anything else puts credentials on a wire in
   * cleartext. Loopback is safe because the packets never leave the machine; a
   * LAN address is not, because everything on that network can read them.
   *
   * The one case this exists for: a physical mobile device talking to a dev API
   * on the developer's own machine, where `localhost` means the PHONE and so
   * the loopback rule cannot be satisfied at all. A caller enabling this must
   * gate it on a non-production build; the SDK cannot tell the difference and
   * will not guess. Public hosts stay https-only regardless of this flag.
   */
  allowInsecurePrivateNetwork?: boolean;
  /** Tenant slug used only by the opt-in local-development header fallback. */
  tenantSlug?: string;
  /** @deprecated Prefer tenantSlug for local development. */
  tenantId?: string;
  /** Forwarded to fetch, typically "include" for cookie-session clients. */
  credentials?: RequestCredentials;
  /** Override fetch (handy for testing or running on edge runtimes). */
  fetch?: FetchFn;
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Number of retries on 429/5xx. Default 3. */
  retries?: number;
  /** Default headers added to every request. */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Raw request body for non-JSON uploads (CSV, blobs, form-data). */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Maximum wire attempts for this call, including the first attempt.
   *
   * Use `1` for operations whose 5xx/transport outcome must be reconciled by
   * reading canonical state before anything is sent again. When omitted, the
   * client-wide `retries` setting remains in force. Explicit non-finite or
   * non-positive values fail safe to one attempt; larger values are bounded by
   * the same retry ceiling as the client-wide policy.
   */
  maxAttempts?: number;
  /** @internal Refuse automatic redirects for one-attempt write contracts. */
  redirect?: RequestRedirect;
  /** When true, parse the body as text/csv (returns string). */
  asText?: boolean;
  /**
   * Idempotency key for safe retries. When omitted on a non-idempotent
   * verb (POST/PATCH/DELETE), the SDK auto-mints a UUID at first attempt
   * and reuses it across retries — so a network-level retry storm cannot
   * create N duplicates server-side.
   *
   * Pass an explicit key when:
   *  - the call may be retried across processes (queue workers)
   *  - the call is part of a larger atomic operation that needs a stable
   *    key derived from the operation id
   *
   * Pass `idempotencyKey: null` to opt out of auto-minting. Doing so also
   * disables RETRIES for that request: without a key the server cannot
   * recognise a repeat, so re-sending a POST/PATCH/DELETE after a timeout
   * could apply it twice. The failure surfaces on the first attempt instead.
   */
  idempotencyKey?: string | null;
  /**
   * Observe the successful response's headers.
   *
   * Added because optimistic concurrency needs the ETag a GET emits and there was
   * no way to see it: several handlers now REQUIRE an exact `If-Match` and answer
   * 428 without one (e.g. subscribers Update, handlers.go:590-594), so a client
   * that cannot read an ETag cannot write at all. Called only on a 2xx, before the
   * body is parsed, and never on the error path — an error already carries its own
   * status/code.
   */
  onResponseHeaders?: (headers: Headers) => void;
  /** @internal Omit dashboard/API-key auth for a separately authenticated public operation. */
  auth?: "inherit" | "none";
  /** @internal Do not copy client-wide headers into a separately authenticated request. */
  omitDefaultHeaders?: boolean;
  /** @internal Require one exact successful status (used by reveal-once issuance). */
  expectedStatus?: number;
}

/** Methods that may safely auto-mint an idempotency key. */
/** Methods whose response the platform URL cache may revalidate. */
const CACHE_SAFE_METHODS = new Set(["GET", "HEAD"]);

const NON_IDEMPOTENT_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * Generate a UUID for idempotency keys. Uses crypto.randomUUID() when
 * available (Node 19+, all modern edge runtimes, browsers), then Web Crypto
 * random bytes for older runtimes.
 */
function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hexBytes = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return [
      hexBytes.slice(0, 4).join(""),
      hexBytes.slice(4, 6).join(""),
      hexBytes.slice(6, 8).join(""),
      hexBytes.slice(8, 10).join(""),
      hexBytes.slice(10, 16).join(""),
    ].join("-");
  }
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
      continue;
    }
    if (i === 14) {
      out += "4";
      continue;
    }
    if (i === 19) {
      out += hex[((Math.random() * 4) | 0) + 8];
      continue;
    }
    out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

const DEFAULT_BASE = "https://api.moosewave.com";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const MAX_RESPONSE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 10;

/**
 * The main client. Holds connection config + sub-resource accessors.
 */
export class PostwaveClient {
  readonly apiKey: string | undefined;
  readonly authMode: PostwaveAuthMode;
  readonly baseUrl: string;
  readonly tenantId: string | undefined;
  readonly tenantSlug: string | undefined;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly credentials: RequestCredentials | undefined;

  private readonly fetchImpl: FetchFn;
  private readonly defaultHeaders: Record<string, string>;

  // sub-resources
  readonly migrations: MigrationsResource;
  readonly subscribers: SubscribersResource;
  readonly sequences: SequencesResource;
  readonly templates: TemplatesResource;
  readonly voiceProfile: VoiceProfileResource;
  readonly forms: FormsResource;
  readonly inboxReality: InboxRealityResource;
  readonly reputation: ReputationResource;
  readonly authChecks: AuthChecksResource;
  readonly sending: SendingResource;
  readonly emails: EmailsResource;
  readonly automations: AutomationsResource;
  readonly webhooks: WebhooksResource;
  readonly campaigns: CampaignsResource;
  readonly campaignAssurance: CampaignAssuranceResource;
  readonly campaignPolls: CampaignPollsResource;
  readonly conversionIngest: ConversionIngestResource;
  /** Admin lifecycle for reveal-once conversion signing credentials. */
  readonly conversionIngestSecrets: ConversionIngestSecretsResource;
  /** Concrete visual email designs; distinct from voice-sequence `templates`. */
  readonly campaignTemplates: CampaignTemplatesResource;
  readonly campaignsAB: CampaignsABResource;
  readonly events: EventsResource;
  readonly segments: SegmentsResource;
  readonly topics: TopicsResource;
  readonly apiKeys: APIKeysResource;
  readonly audit: AuditResource;
  readonly approvals: ApprovalsResource;
  readonly sandbox: SandboxResource;
  readonly cost: CostResource;
  readonly safety: SafetyResource;
  readonly account: AccountResource;
  readonly onboarding: OnboardingResource;
  readonly audienceDestinations: AudienceDestinationsResource;
  readonly audienceSyncs: AudienceSyncsResource;
  readonly aiCompose: AIComposeResource;
  readonly audiences: AudiencesResource;
  readonly integrations: IntegrationsResource;
  readonly nativeIntegrations: NativeIntegrationsResource;
  readonly developerMarketplace: DeveloperMarketplaceResource;
  readonly chatIntegrations: ChatIntegrationsResource;
  readonly discordIntegrations: ChatIntegrationChannelResource;
  readonly slackIntegrations: SlackIntegrationsResource;
  readonly teamsIntegrations: ChatIntegrationChannelResource;
  readonly landingPages: LandingPagesResource;
  readonly analytics: AnalyticsResource;
  // X1+X2+X3 additions
  readonly lists: ListsResource;
  readonly tags: TagsResource;
  readonly suppressions: SuppressionsResource;
  readonly sendingSettings: SendingSettingsResource;
  readonly assets: AssetsResource;
  readonly inboundWebhooks: InboundWebhooksResource;
  readonly track: TrackResource;
  readonly inboundEmails: InboundEmailsResource;
  readonly dmarc: DmarcResource;
  readonly templatePreview: TemplatePreviewResource;
  readonly customDomains: CustomDomainsResource;
  readonly linkCheck: LinkCheckResource;
  readonly archive: ArchiveResource;
  readonly referrals: ReferralsResource;
  readonly discounts: DiscountsResource;
  readonly giftSubscriptions: GiftSubscriptionsResource;
  readonly sendTime: SendTimeResource;
  readonly sms: SmsResource;
  readonly pushSuppressions: PushSuppressionsResource;
  // Tier-1 enterprise additions (2026-05): agency / scim / audit sinks /
  // inbound routes / voice drift.
  readonly agency: AgencyResource;
  readonly auditSinks: AuditSinksResource;
  readonly inboundRoutes: InboundRoutesResource;
  readonly scim: ScimResource;
  /**
   * Agent-mandate governance. SESSION-ONLY on the server: a client built with
   * an API key gets 403 `session_required` on every method here, by design —
   * an agent must not be able to grant itself authority.
   */
  readonly agentMandates: AgentMandatesResource;
  readonly voiceDrift: VoiceDriftResource;
  readonly mobilePush: MobilePushResource;

  constructor(opts: PostwaveClientOptions) {
    const authMode = opts.authMode ?? "api_key";
    if (authMode === "api_key" && !opts.apiKey) {
      throw new Error("PostwaveClient: apiKey is required for api_key auth");
    }
    if (opts.apiKey !== undefined && !safeHeaderValue(opts.apiKey)) {
      throw new Error("PostwaveClient: apiKey contains unsafe characters");
    }
    if (opts.tenantId !== undefined && !safeHeaderValue(opts.tenantId)) {
      throw new Error("PostwaveClient: tenantId contains unsafe characters");
    }
    if (opts.tenantSlug !== undefined && !safeHeaderValue(opts.tenantSlug)) {
      throw new Error("PostwaveClient: tenantSlug contains unsafe characters");
    }
    this.authMode = authMode;
    this.apiKey = opts.apiKey;
    this.baseUrl = normalizeBaseUrl(
      opts.baseUrl,
      opts.allowInsecurePrivateNetwork === true,
    );
    this.tenantId = opts.tenantId;
    this.tenantSlug = opts.tenantSlug;
    this.retries = normalizeRetries(opts.retries);
    this.timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchFn);
    if (!this.fetchImpl) {
      throw new Error(
        "PostwaveClient: no fetch implementation found; pass `fetch` explicitly",
      );
    }
    this.defaultHeaders = opts.defaultHeaders ?? {};

    this.migrations = new MigrationsResource(this);
    this.subscribers = new SubscribersResource(this);
    this.sequences = new SequencesResource(this);
    this.templates = new TemplatesResource(this);
    this.voiceProfile = new VoiceProfileResource(this);
    this.forms = new FormsResource(this);
    this.inboxReality = new InboxRealityResource(this);
    this.reputation = new ReputationResource(this);
    this.authChecks = new AuthChecksResource(this);
    this.sending = new SendingResource(this);
    this.emails = new EmailsResource(this);
    this.automations = new AutomationsResource(this);
    this.webhooks = new WebhooksResource(this);
    this.campaigns = new CampaignsResource(this);
    this.campaignAssurance = new CampaignAssuranceResource(this);
    this.campaignPolls = new CampaignPollsResource(this);
    this.conversionIngest = new ConversionIngestResource(this);
    this.conversionIngestSecrets = new ConversionIngestSecretsResource(this);
    this.campaignTemplates = new CampaignTemplatesResource(this);
    this.campaignsAB = new CampaignsABResource(this);
    this.events = new EventsResource(this);
    this.segments = new SegmentsResource(this);
    this.topics = new TopicsResource(this);
    this.apiKeys = new APIKeysResource(this);
    this.audit = new AuditResource(this);
    this.approvals = new ApprovalsResource(this);
    this.sandbox = new SandboxResource(this);
    this.cost = new CostResource(this);
    this.safety = new SafetyResource(this);
    this.account = new AccountResource(this);
    this.onboarding = new OnboardingResource(this);
    this.audienceDestinations = new AudienceDestinationsResource(this);
    this.audienceSyncs = new AudienceSyncsResource(this);
    this.aiCompose = new AIComposeResource(this);
    this.audiences = new AudiencesResource(this);
    this.integrations = new IntegrationsResource(this);
    this.nativeIntegrations = new NativeIntegrationsResource(this);
    this.developerMarketplace = new DeveloperMarketplaceResource(this);
    this.chatIntegrations = new ChatIntegrationsResource(this);
    this.discordIntegrations = this.chatIntegrations.discord;
    this.slackIntegrations = new SlackIntegrationsResource(this);
    this.teamsIntegrations = this.chatIntegrations.teams;
    this.landingPages = new LandingPagesResource(this);
    this.analytics = new AnalyticsResource(this);
    // X1+X2+X3 additions
    this.lists = new ListsResource(this);
    this.tags = new TagsResource(this);
    this.suppressions = new SuppressionsResource(this);
    this.sendingSettings = new SendingSettingsResource(this);
    this.assets = new AssetsResource(this);
    this.inboundWebhooks = new InboundWebhooksResource(this);
    this.track = new TrackResource(this);
    this.inboundEmails = new InboundEmailsResource(this);
    this.dmarc = new DmarcResource(this);
    this.templatePreview = new TemplatePreviewResource(this);
    this.customDomains = new CustomDomainsResource(this);
    this.linkCheck = new LinkCheckResource(this);
    this.archive = new ArchiveResource(this);
    this.referrals = new ReferralsResource(this);
    this.discounts = new DiscountsResource(this);
    this.giftSubscriptions = new GiftSubscriptionsResource(this);
    this.sendTime = new SendTimeResource(this);
    this.sms = new SmsResource(this);
    this.pushSuppressions = new PushSuppressionsResource(this);
    // Tier-1 enterprise additions.
    this.agency = new AgencyResource(this);
    this.auditSinks = new AuditSinksResource(this);
    this.inboundRoutes = new InboundRoutesResource(this);
    this.scim = new ScimResource(this);
    this.agentMandates = new AgentMandatesResource(this);
    this.voiceDrift = new VoiceDriftResource(this);
    this.mobilePush = new MobilePushResource(this);
  }

  /**
   * Low-level request. Handles auth, tenant header, JSON serialization,
   * timeout, retry-on-429/5xx with exponential backoff + Retry-After
   * honoring, and typed-error mapping.
   */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers = this.buildRequestHeaders(
      opts.headers,
      opts.auth === "none",
      opts.omitDefaultHeaders === true,
    );
    if (opts.body !== undefined && opts.rawBody !== undefined) {
      throw new Error(
        "PostwaveClient.request: pass either body or rawBody, not both",
      );
    }
    if (opts.body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    // Idempotency key: explicit > caller-supplied header > auto-mint for
    // non-idempotent verbs. Auto-mint happens ONCE, so all retry attempts
    // below see the same key (server-side dedup works).
    const upperMethod = method.toUpperCase();
    let idempotencyKey: string | undefined;
    if (opts.idempotencyKey === null) {
      // Explicit opt-out is an absence guarantee, including when a client-wide
      // default or per-request header tried to supply a differently-cased key.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "idempotency-key") delete headers[name];
      }
    } else if (
      typeof opts.idempotencyKey === "string" &&
      opts.idempotencyKey !== ""
    ) {
      idempotencyKey = opts.idempotencyKey;
    } else if (headers["Idempotency-Key"]) {
      idempotencyKey = headers["Idempotency-Key"];
    } else if (NON_IDEMPOTENT_METHODS.has(upperMethod)) {
      idempotencyKey = newIdempotencyKey();
    }
    if (idempotencyKey && !headers["Idempotency-Key"]) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    // Whether a failed attempt may be repeated.
    //
    // Retrying is only safe when the server can recognise the repeat. That is
    // true for a semantically idempotent verb, or for any request carrying an
    // Idempotency-Key. It is NOT true for a keyless POST/PATCH/DELETE — and
    // that combination was reachable: `idempotencyKey: null` is documented as
    // opting out of auto-minting, and nothing said retries continued anyway.
    // A caller who disabled dedup on a campaign send still got three attempts
    // on a timeout, which is the exact case where the write may have committed
    // and only the response was lost.
    const retryIsSafe =
      !NON_IDEMPOTENT_METHODS.has(upperMethod) ||
      Boolean(headers["Idempotency-Key"]);

    const init: RequestInit = {
      method,
      headers,
      // NEVER let the platform HTTP cache revalidate on our behalf.
      //
      // The API sets ETag + Cache-Control on collection reads. Left alone,
      // NSURLSession/the browser cache re-issues the request with
      // If-None-Match and the server answers 304 WITH AN EMPTY BODY. This
      // client has no body cache to satisfy that 304 from -- callers
      // (TanStack Query in the apps) hold the cache -- so the 304 falls
      // straight past `resp.ok` into mapError and surfaces as
      // `ApiError: HTTP 304`.
      //
      // Observed live on 2026-08-19: the mobile dashboard loaded correctly at
      // 10:26:09 (200, 908 bytes) and every refetch from 10:26:41 onward was a
      // 0-byte 304, so a working screen replaced itself with "Something went
      // wrong loading the dashboard" exactly one refetch interval after
      // opening, and stayed broken.
      cache: "no-store",
      body:
        opts.rawBody !== undefined
          ? opts.rawBody
          : opts.body !== undefined
            ? JSON.stringify(opts.body)
            : null,
    };
    if (opts.redirect !== undefined) init.redirect = opts.redirect;
    if (this.credentials) init.credentials = this.credentials;
    if (opts.signal) init.signal = opts.signal;

    const requestRetries =
      normalizeMaxAttempts(opts.maxAttempts, this.retries) - 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= requestRetries; attempt++) {
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, this.timeoutMs);
      // If caller supplied a signal, abort our controller when theirs fires.
      const userSignal = opts.signal;
      const onUserAbort = () => ac.abort();
      if (userSignal) {
        if (userSignal.aborted) ac.abort();
        else userSignal.addEventListener("abort", onUserAbort);
      }

      try {
        let resp = await this.fetchImpl(url, { ...init, signal: ac.signal });

        // ── SURVIVE A 304 THE PLATFORM CACHE PRODUCED BEHIND OUR BACK ──────
        //
        // `cache: "no-store"` above is the correct instruction and browsers
        // honour it. REACT NATIVE DOES NOT: its fetch is a polyfill over
        // RCTNetworking/NSURLSession that silently drops the option, so on iOS
        // the URL cache still revalidates with If-None-Match and the server
        // answers 304 WITH A ZERO-BYTE BODY.
        //
        // We cannot serve that 304 -- this client holds no body cache, the
        // callers do -- and `resp.ok` is false for 304, so without this the
        // response falls into mapError as `ApiError: HTTP 304` and a healthy
        // read becomes a failed query. Measured on a simulator: the dashboard
        // loaded at 200/908 bytes and every refetch after was a 0-byte 304.
        //
        // A cache-busting parameter is the only lever RN leaves us: it changes
        // the cache KEY, so there is no stored entry to revalidate against and
        // the server must send a full body. Retried once, only for safe
        // methods, and only when a 304 actually arrives -- so the extra round
        // trip is paid on the revalidation path alone, never on a first load.
        if (resp.status === 304 && CACHE_SAFE_METHODS.has(upperMethod)) {
          const bust = this.buildUrl(path, {
            ...(opts.query ?? {}),
            _cb: `${Date.now()}-${attempt}`,
          });
          resp = await this.fetchImpl(bust, { ...init, signal: ac.signal });
        }
        clearTimeout(timer);
        if (userSignal) userSignal.removeEventListener("abort", onUserAbort);

        const requestId = resp.headers.get("x-request-id") ?? undefined;
        const responseMetadata = responseMetadataFromHeaders(resp.headers);

        if (resp.ok) {
          if (
            opts.expectedStatus !== undefined &&
            resp.status !== opts.expectedStatus
          ) {
            throw new ParseError({
              status: resp.status,
              payload: `expected HTTP ${opts.expectedStatus}`,
              requestId,
              responseMetadata,
            });
          }
          opts.onResponseHeaders?.(resp.headers);
          if (resp.status === 204) return undefined as T;
          if (opts.asText) {
            return (await readTextLimited(
              resp,
              MAX_RESPONSE_TEXT_BYTES,
            )) as unknown as T;
          }
          const ct = resp.headers.get("content-type") ?? "";
          const text = await readTextLimited(resp, MAX_RESPONSE_TEXT_BYTES);
          if (!text) return undefined as T;
          if (isJSONMediaType(ct)) {
            try {
              return JSON.parse(text) as T;
            } catch {
              throw new ParseError({
                status: resp.status,
                payload: text,
                requestId,
                responseMetadata,
              });
            }
          }
          // A caller that did NOT ask for text is expecting JSON, so a
          // non-JSON body is a protocol failure and not a value.
          //
          // Returning the raw text here typed it as whatever the method
          // declared, which is silent and catastrophic: a reverse proxy that
          // answers 200 text/html for an absent upstream (an SPA fallback)
          // made `migrations.list(): Promise<MigrationJob[]>` hand back an
          // HTML STRING. The screen then read `.length` off it and rendered
          // ONE JOB PER CHARACTER -- 1,293 phantom rows, every `id` undefined,
          // every React key identical, and a red-screen from the first
          // `job.id.slice()`. Observed in-app on 2026-08-19.
          //
          // ParseError already carries the status and payload, so the caller
          // can see exactly what arrived instead of guessing.
          throw new ParseError({
            status: resp.status,
            payload: text,
            requestId,
            responseMetadata,
          });
        }

        const body = await safeReadBody(resp);
        const err = mapError(resp.status, body, requestId, resp.headers);

        // Retry policy: 429 + 5xx (except 501 Not Implemented).
        if (
          attempt < requestRetries &&
          retryIsSafe &&
          (err instanceof RateLimitError ||
            (err instanceof ServerError && err.status !== 501))
        ) {
          const delay = computeBackoff({
            attempt,
            retryAfterSecondsHeader: resp.headers.get("retry-after"),
            retryAfterSecondsBody:
              err instanceof RateLimitError ? err.retryAfterSeconds : undefined,
          });
          await sleep(delay, opts.signal);
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        clearTimeout(timer);
        if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
        if (e instanceof PostwaveError) throw e;
        const transportError = mapTransportError(e, {
          timedOut,
          userAborted: Boolean(userSignal?.aborted && !timedOut),
        });
        if (transportError instanceof RequestAbortedError) {
          throw transportError;
        }
        // Network/timeout error — retry with backoff, then bail. Gated on
        // retryIsSafe for the same reason as the status path above, and it
        // matters more here: a timeout says nothing about whether the server
        // processed the request.
        if (attempt < requestRetries && retryIsSafe) {
          await sleep(computeBackoff({ attempt }), opts.signal);
          lastErr = transportError;
          continue;
        }
        throw transportError;
      }
    }
    // Should be unreachable; surface the last seen error if it slips through.
    throw (
      lastErr ??
      new PostwaveError("exhausted retries", { status: 0, code: "exhausted" })
    );
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const base = new URL(`${this.baseUrl}/`);
    const rawPath = String(path || "");
    if (rawPath.trim() !== rawPath || /[\u0000-\u001f\u007f\\]/.test(rawPath)) {
      throw new Error("PostwaveClient.request: unsafe request path");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
      throw new Error("PostwaveClient.request: unsafe request path");
    }
    const relativePath = rawPath.replace(/^\/+/, "");
    const pathOnly = relativePath.split(/[?#]/, 1)[0] ?? "";
    if (pathOnly.split("/").some((segment) => isUnsafePathSegment(segment))) {
      throw new Error("PostwaveClient.request: unsafe request path");
    }
    const url = new URL(`${base.toString()}${relativePath}`);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("PostwaveClient.request: unsafe request path");
    }
    if (!query) return url.toString();
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) usp.set(k, String(v));
    }
    const qs = usp.toString();
    if (qs) {
      for (const [k, v] of usp.entries()) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /** @internal Shared by streaming resources that cannot use request(). */
  buildRequestUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    return this.buildUrl(path, query);
  }

  /** @internal Shared by streaming resources that cannot use request(). */
  buildRequestHeaders(
    headers?: Record<string, string>,
    omitAuthentication = false,
    omitDefaultHeaders = false,
  ): Record<string, string> {
    const out: Record<string, string> = {
      Accept: "application/json",
      ...(omitDefaultHeaders ? {} : this.defaultHeaders),
      ...headers,
    };
    if (omitAuthentication) {
      for (const name of Object.keys(out)) {
        const normalized = name.toLowerCase();
        if (normalized === "authorization" || normalized === "x-tenant-slug") {
          delete out[name];
        }
      }
    } else if (this.apiKey && !out.Authorization) {
      out.Authorization = `Bearer ${this.apiKey}`;
    }
    const localTenantSlug = omitAuthentication
      ? undefined
      : (this.tenantSlug ??
        (this.authMode === "api_key" ? this.tenantId : undefined));
    if (localTenantSlug && !out["X-Tenant-Slug"]) {
      out["X-Tenant-Slug"] = localTenantSlug;
    }
    validateHeaderRecord(out);
    return out;
  }

  /** @internal Shared by streaming resources that cannot use request(). */
  fetchRaw(input: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }
}

function normalizeBaseUrl(
  raw: string | undefined,
  allowPrivateNetwork = false,
): string {
  const value = String(raw || DEFAULT_BASE).trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      "PostwaveClient: baseUrl must be a valid http(s) URL without credentials, query, or fragment",
    );
  }
  try {
    const url = new URL(value.replace(/\/+$/, ""));
    if (url.protocol === "http:") {
      const httpAllowed =
        isLocalHttpHost(url.hostname) ||
        (allowPrivateNetwork && isPrivateNetworkHost(url.hostname));
      if (!httpAllowed) throw new Error("http requires localhost");
    } else if (url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe URL components");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(
      "PostwaveClient: baseUrl must be a valid http(s) URL without credentials, query, or fragment",
    );
  }
}

function isLocalHttpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * RFC1918 private IPv4, IPv4 link-local, and IPv6 unique-local/link-local.
 *
 * Deliberately IP-only: a NAME could resolve anywhere, so allowing hostnames
 * here would reopen the hole this whole policy exists to close.
 */
function isPrivateNetworkHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

function isUnsafePathSegment(segment: string): boolean {
  if (!segment) return false;
  let decoded = segment;
  for (let i = 0; i < 2; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  for (const value of [segment, decoded]) {
    if (value === "." || value === "..") return true;
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return true;
  }
  return false;
}

function validateHeaderRecord(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`PostwaveClient: unsafe request header name: ${name}`);
    }
    if (!safeHeaderValue(value)) {
      throw new Error(
        `PostwaveClient: unsafe request header value for ${name}`,
      );
    }
  }
}

function safeHeaderValue(value: string): boolean {
  return (
    typeof value === "string" &&
    !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)
  );
}

function mapTransportError(
  err: unknown,
  flags: { timedOut: boolean; userAborted: boolean },
): NetworkError {
  if (flags.timedOut) {
    return new TimeoutError({ payload: err });
  }
  if (flags.userAborted) {
    return new RequestAbortedError({ payload: err });
  }
  const message =
    err instanceof Error && err.message
      ? err.message
      : "Network request failed";
  return new NetworkError({ message, payload: err });
}

async function safeReadBody(resp: Response): Promise<unknown> {
  try {
    const ct = resp.headers.get("content-type") ?? "";
    const text = await readTextLimited(resp, MAX_ERROR_TEXT_BYTES);
    if (!text) return undefined;
    if (isJSONMediaType(ct)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return null;
  }
}

function isJSONMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readTextLimited(
  resp: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PostwaveError(
      "API response body exceeded the SDK safety limit.",
      {
        status: resp.status,
        code: "response_too_large",
        payload: { maxBytes, contentLength },
      },
    );
  }
  if (!resp.body) {
    const read = resp.text.bind(resp);
    const text = await read();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new PostwaveError(
        "API response body exceeded the SDK safety limit.",
        {
          status: resp.status,
          code: "response_too_large",
          payload: { maxBytes, contentLength: byteLength },
        },
      );
    }
    return text;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PostwaveError(
        "API response body exceeded the SDK safety limit.",
        {
          status: resp.status,
          code: "response_too_large",
          payload: { maxBytes, contentLength: total },
        },
      );
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new RequestAbortedError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeRetries(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETRIES;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RETRIES;
  return Math.min(Math.floor(value), MAX_RETRIES);
}

function normalizeMaxAttempts(
  value: number | undefined,
  defaultRetries: number,
): number {
  if (value === undefined) return defaultRetries + 1;
  // An explicit unsafe limit must not silently restore the broader client
  // retry policy. One attempt is the conservative, always-executable floor.
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.max(1, Math.floor(value)), MAX_RETRIES + 1);
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

/**
 * Exponential backoff with jitter, capped at 30s. Honors a Retry-After
 * header in either delta-seconds or HTTP-date form.
 */
export function computeBackoff(input: {
  attempt: number;
  retryAfterSecondsHeader?: string | null;
  retryAfterSecondsBody?: number;
}): number {
  if (input.retryAfterSecondsBody && input.retryAfterSecondsBody > 0) {
    return Math.min(input.retryAfterSecondsBody * 1000, 30_000);
  }
  if (input.retryAfterSecondsHeader) {
    const asNum = Number(input.retryAfterSecondsHeader);
    if (!Number.isNaN(asNum) && asNum >= 0)
      return Math.min(asNum * 1000, 30_000);
    const asDate = Date.parse(input.retryAfterSecondsHeader);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return Math.min(delta, 30_000);
    }
  }
  const base = 250 * 2 ** input.attempt; // 250, 500, 1000, 2000, ...
  const jitter = Math.random() * base;
  return Math.min(base + jitter, 30_000);
}
