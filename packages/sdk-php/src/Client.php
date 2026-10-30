<?php
// SPDX-License-Identifier: MIT
//
// Moosewave\Client — entry point for the PHP SDK. Wraps a curl-based
// HTTP transport and exposes one property per resource. Each resource
// is a small class that translates idiomatic PHP calls into the
// underlying REST contract documented in packages/openapi/openapi.yaml.
//
// Design choices:
//   * No Guzzle. ext-curl + ext-json keep the install footprint zero
//     transitive deps.
//   * Resources are eagerly constructed; they're light and the cost
//     is one method-table lookup per resource.
//   * Errors map to a typed hierarchy under Moosewave\Errors. Callers
//     branch on instanceof rather than HTTP status codes.

declare(strict_types=1);

namespace Moosewave;

use Moosewave\Errors\AuthError;
use Moosewave\Errors\ConflictError;
use Moosewave\Errors\ForbiddenError;
use Moosewave\Errors\NetworkError;
use Moosewave\Errors\NotFoundError;
use Moosewave\Errors\ParseError;
use Moosewave\Errors\PostwaveError;
use Moosewave\Errors\RateLimitError;
use Moosewave\Errors\ServerError;
use Moosewave\Errors\ValidationError;
use Moosewave\Errors\WrongRegionError;
use Moosewave\Resources\AccountResource;
use Moosewave\Resources\AgencyResource;
use Moosewave\Resources\AnalyticsResource;
use Moosewave\Resources\APIKeysResource;
use Moosewave\Resources\ApprovalsResource;
use Moosewave\Resources\ArchiveResource;
use Moosewave\Resources\AssetsResource;
use Moosewave\Resources\AIComposeResource;
use Moosewave\Resources\AudienceDestinationsResource;
use Moosewave\Resources\AudienceSyncsResource;
use Moosewave\Resources\AudiencesResource;
use Moosewave\Resources\AuditResource;
use Moosewave\Resources\AuditSinksResource;
use Moosewave\Resources\AuthChecksResource;
use Moosewave\Resources\AutomationsResource;
use Moosewave\Resources\CampaignsABResource;
use Moosewave\Resources\CampaignAssuranceResource;
use Moosewave\Resources\CampaignPollsResource;
use Moosewave\Resources\CampaignTemplatesResource;
use Moosewave\Resources\CampaignsResource;
use Moosewave\Resources\ConversionIngestSecretsResource;
use Moosewave\Resources\ChatIntegrationChannelResource;
use Moosewave\Resources\ChatIntegrationsResource;
use Moosewave\Resources\CostResource;
use Moosewave\Resources\CustomDomainsResource;
use Moosewave\Resources\DeveloperMarketplaceResource;
use Moosewave\Resources\DiscountsResource;
use Moosewave\Resources\DmarcResource;
use Moosewave\Resources\EventsResource;
use Moosewave\Resources\FormsResource;
use Moosewave\Resources\GiftSubscriptionsResource;
use Moosewave\Resources\InboundEmailsResource;
use Moosewave\Resources\InboundRoutesResource;
use Moosewave\Resources\InboundWebhooksResource;
use Moosewave\Resources\InboxRealityResource;
use Moosewave\Resources\IntegrationsResource;
use Moosewave\Resources\LandingPagesResource;
use Moosewave\Resources\LinkCheckResource;
use Moosewave\Resources\NativeIntegrationsResource;
use Moosewave\Resources\ListsResource;
use Moosewave\Resources\MigrationsResource;
use Moosewave\Resources\PreferencesResource;
use Moosewave\Resources\PushSuppressionsResource;
use Moosewave\Resources\ReferralsResource;
use Moosewave\Resources\ReputationResource;
use Moosewave\Resources\SafetyResource;
use Moosewave\Resources\SandboxResource;
use Moosewave\Resources\ScimResource;
use Moosewave\Resources\SegmentsResource;
use Moosewave\Resources\SendingResource;
use Moosewave\Resources\EmailsResource;
use Moosewave\Resources\SendingSettingsResource;
use Moosewave\Resources\SendTimeResource;
use Moosewave\Resources\SequencesResource;
use Moosewave\Resources\SlackIntegrationsResource;
use Moosewave\Resources\SmsResource;
use Moosewave\Resources\StatusResource;
use Moosewave\Resources\SubscribersResource;
use Moosewave\Resources\SuppressionsResource;
use Moosewave\Resources\TagsResource;
use Moosewave\Resources\TemplatePreviewResource;
use Moosewave\Resources\TemplatesResource;
use Moosewave\Resources\TopicsResource;
use Moosewave\Resources\TrackResource;
use Moosewave\Resources\VoiceDriftResource;
use Moosewave\Resources\VoiceProfileResource;
use Moosewave\Resources\WebhooksResource;

final class Client
{
    public CampaignsResource $campaigns;
    public CampaignAssuranceResource $campaignAssurance;
    public CampaignPollsResource $campaignPolls;
    public CampaignTemplatesResource $campaignTemplates;
    /** Admin lifecycle for reveal-once conversion-ingest signing keys. */
    public ConversionIngestSecretsResource $conversionIngestSecrets;
    public SubscribersResource $subscribers;
    public ListsResource $lists;
    public SegmentsResource $segments;
    public FormsResource $forms;
    public IntegrationsResource $integrations;
    public NativeIntegrationsResource $nativeIntegrations;
    public AudienceDestinationsResource $audienceDestinations;
    public AudienceSyncsResource $audienceSyncs;
    public AIComposeResource $aiCompose;
    public AudiencesResource $audiences;
    public ChatIntegrationsResource $chatIntegrations;
    public ChatIntegrationChannelResource $discordIntegrations;
    public ChatIntegrationChannelResource $teamsIntegrations;
    public SmsResource $sms;
    public DeveloperMarketplaceResource $developerMarketplace;
    public APIKeysResource $apiKeys;
    public InboundWebhooksResource $inboundWebhooks;
    public WebhooksResource $webhooks;
    public EventsResource $events;
    public StatusResource $status;
    public AnalyticsResource $analytics;
    public SequencesResource $sequences;
    public AutomationsResource $automations;
    public SuppressionsResource $suppressions;
    public PushSuppressionsResource $pushSuppressions;
    public CustomDomainsResource $customDomains;
    public TemplatesResource $templates;
    public TemplatePreviewResource $templatePreview;
    public AccountResource $account;
    public AgencyResource $agency;
    public ApprovalsResource $approvals;
    public ArchiveResource $archive;
    public AssetsResource $assets;
    public AuditResource $audit;
    public AuditSinksResource $auditSinks;
    public AuthChecksResource $authChecks;
    public CampaignsABResource $campaignsAb;
    public CostResource $cost;
    public DiscountsResource $discounts;
    public DmarcResource $dmarc;
    public GiftSubscriptionsResource $giftSubscriptions;
    public InboundEmailsResource $inboundEmails;
    public InboundRoutesResource $inboundRoutes;
    public InboxRealityResource $inboxReality;
    public LandingPagesResource $landingPages;
    public LinkCheckResource $linkCheck;
    public MigrationsResource $migrations;
    public PreferencesResource $preferences;
    public ReferralsResource $referrals;
    public ReputationResource $reputation;
    public SafetyResource $safety;
    public SandboxResource $sandbox;
    public ScimResource $scim;
    public SendingResource $sending;
    public EmailsResource $emails;
    public SendingSettingsResource $sendingSettings;
    public SendTimeResource $sendTime;
    public SlackIntegrationsResource $slackIntegrations;
    public TagsResource $tags;
    public TopicsResource $topics;
    public TrackResource $track;
    public VoiceDriftResource $voiceDrift;
    public VoiceProfileResource $voiceProfile;

    private string $apiKey;
    private string $baseUrl;
    private int $timeout;
    /** @var array<string, string> */
    private array $extraHeaders;

    /** Bound the size of any response body we'll parse. 8 MiB matches
     *  the Go API's response cap so anything larger is malformed. */
    public const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    /**
     * @param string                $apiKey       Moosewave API key (pw_live_… or pw_test_…).
     * @param string                $baseUrl      Override the default https://api.moosewave.com.
     * @param int                   $timeout      Request timeout in seconds.
     * @param array<string, string> $extraHeaders Extra headers attached to every request.
     */
    public function __construct(
        string $apiKey,
        string $baseUrl = 'https://api.moosewave.com',
        int $timeout = 30,
        array $extraHeaders = []
    ) {
        if ($apiKey === '') {
            throw new \InvalidArgumentException('apiKey is required');
        }
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeout;
        $this->extraHeaders = $extraHeaders;

        $this->campaigns = new CampaignsResource($this);
        $this->campaignAssurance = new CampaignAssuranceResource($this);
        $this->campaignPolls = new CampaignPollsResource($this);
        $this->campaignTemplates = new CampaignTemplatesResource($this);
        $this->conversionIngestSecrets = new ConversionIngestSecretsResource($this);
        $this->subscribers = new SubscribersResource($this);
        $this->lists = new ListsResource($this);
        $this->segments = new SegmentsResource($this);
        $this->forms = new FormsResource($this);
        $this->integrations = new IntegrationsResource($this);
        $this->nativeIntegrations = new NativeIntegrationsResource($this);
        $this->audienceDestinations = new AudienceDestinationsResource($this);
        $this->audienceSyncs = new AudienceSyncsResource($this);
        $this->aiCompose = new AIComposeResource($this);
        $this->audiences = new AudiencesResource($this);
        $this->chatIntegrations = new ChatIntegrationsResource($this);
        $this->discordIntegrations = $this->chatIntegrations->discord;
        $this->teamsIntegrations = $this->chatIntegrations->teams;
        $this->sms = new SmsResource($this);
        $this->developerMarketplace = new DeveloperMarketplaceResource($this);
        $this->apiKeys = new APIKeysResource($this);
        $this->inboundWebhooks = new InboundWebhooksResource($this);
        $this->webhooks = new WebhooksResource($this);
        $this->events = new EventsResource($this);
        $this->status = new StatusResource($this);
        $this->analytics = new AnalyticsResource($this);
        $this->sequences = new SequencesResource($this);
        $this->automations = new AutomationsResource($this);
        $this->suppressions = new SuppressionsResource($this);
        $this->pushSuppressions = new PushSuppressionsResource($this);
        $this->customDomains = new CustomDomainsResource($this);
        $this->templates = new TemplatesResource($this);
        $this->templatePreview = new TemplatePreviewResource($this);
        $this->account = new AccountResource($this);
        $this->agency = new AgencyResource($this);
        $this->approvals = new ApprovalsResource($this);
        $this->archive = new ArchiveResource($this);
        $this->assets = new AssetsResource($this);
        $this->audit = new AuditResource($this);
        $this->auditSinks = new AuditSinksResource($this);
        $this->authChecks = new AuthChecksResource($this);
        $this->campaignsAb = new CampaignsABResource($this);
        $this->cost = new CostResource($this);
        $this->discounts = new DiscountsResource($this);
        $this->dmarc = new DmarcResource($this);
        $this->giftSubscriptions = new GiftSubscriptionsResource($this);
        $this->inboundEmails = new InboundEmailsResource($this);
        $this->inboundRoutes = new InboundRoutesResource($this);
        $this->inboxReality = new InboxRealityResource($this);
        $this->landingPages = new LandingPagesResource($this);
        $this->linkCheck = new LinkCheckResource($this);
        $this->migrations = new MigrationsResource($this);
        $this->preferences = new PreferencesResource($this);
        $this->referrals = new ReferralsResource($this);
        $this->reputation = new ReputationResource($this);
        $this->safety = new SafetyResource($this);
        $this->sandbox = new SandboxResource($this);
        $this->scim = new ScimResource($this);
        $this->sending = new SendingResource($this);
        $this->emails = new EmailsResource($this);
        $this->sendingSettings = new SendingSettingsResource($this);
        $this->sendTime = new SendTimeResource($this);
        $this->slackIntegrations = new SlackIntegrationsResource($this);
        $this->tags = new TagsResource($this);
        $this->topics = new TopicsResource($this);
        $this->track = new TrackResource($this);
        $this->voiceDrift = new VoiceDriftResource($this);
        $this->voiceProfile = new VoiceProfileResource($this);
    }

    /**
     * Low-level request. Used by every resource; safe to call directly
     * for endpoints that don't have a typed wrapper yet (the full
     * OpenAPI surface is large; the typed wrappers cover the most-
     * used paths).
     *
     * @param array<string, mixed>|\stdClass|null $body
     * @param array<int|string, mixed>  $query
     * @param array<string, string>     $headers
     * @return mixed Parsed JSON (array | scalar | null).
     */
    public function request(
        string $method,
        string $path,
        array|\stdClass|null $body = null,
        array $query = [],
        array $headers = []
    ): mixed {
        return $this->requestWithHeaders($method, $path, $body, $query, $headers)['data'];
    }

    /**
     * JSON request variant that also returns normalized response headers.
     * This is used by conditional-write resources whose next strong ETag is
     * part of the public success contract.
     *
     * @param array<string, mixed>|\stdClass|null $body
     * @param array<int|string, mixed>             $query
     * @param array<string, string>                $headers
     * @return array{data: mixed, headers: array<string, string>}
     */
    public function requestWithHeaders(
        string $method,
        string $path,
        array|\stdClass|null $body = null,
        array $query = [],
        array $headers = []
    ): array {
        [$status, $rawBody, $responseHeaders] = $this->rawRequest($method, $path, $body, $query, $headers);

        $parsed = null;
        $parseErr = null;
        if ($rawBody !== '') {
            $decoded = json_decode($rawBody, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $parseErr = json_last_error_msg();
            } else {
                $parsed = $decoded;
            }
        }
        if ($status >= 200 && $status < 300) {
            // 2xx with malformed JSON is suspicious; the legacy SDKs
            // surface this as a ParseError rather than silently
            // returning null.
            if ($parseErr !== null) {
                throw new ParseError("Invalid JSON response from Moosewave: $parseErr", $status);
            }
            return ['data' => $parsed, 'headers' => $responseHeaders];
        }
        throw self::buildError($status, $parsed, $rawBody, $responseHeaders);
    }

    /**
     * @internal Exact one-attempt transport for a reveal-once credential.
     * Idempotency-Key is stripped from both client-wide and request headers,
     * and only the contract's exact 201 response is accepted as success.
     *
     * @param array<string, mixed>|\stdClass|null $body
     */
    public function requestRevealOnce(string $path, array|\stdClass|null $body = null): mixed
    {
        if ($path !== '/api/v1/conversions/ingest-secrets') {
            throw new \InvalidArgumentException('Reveal-once transport is restricted to signing-key issuance.');
        }
        $preview = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($preview) || strlen($preview) > 1024) {
            throw new \InvalidArgumentException('Reveal-once signing-key body exceeds 1 KiB.');
        }
        [$status, $rawBody, $responseHeaders] = $this->rawRequest(
            'POST',
            $path,
            $body,
            [],
            [],
            null,
            null,
            true,
            true
        );
        $parsed = null;
        $parseErr = null;
        if ($rawBody !== '') {
            $decoded = json_decode($rawBody, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $parseErr = json_last_error_msg();
            } else {
                $parsed = $decoded;
            }
        }
        if ($status === 201) {
            if ($parseErr !== null || $rawBody === '') {
                throw new ParseError('Invalid reveal-once JSON response from Moosewave', $status);
            }
            return $parsed;
        }
        if ($status >= 200 && $status < 300) {
            throw new ParseError("Unexpected reveal-once HTTP status $status", $status);
        }
        throw self::buildError($status, $parsed, $rawBody, $responseHeaders);
    }

    /**
     * @internal Exact one-attempt transport for the outcome-ambiguous
     * sending-settings replacement. Idempotency-Key is stripped from both
     * client-wide and request headers, and only the contract's exact 200
     * response is accepted as a candidate success.
     *
     * @param array<string, mixed>|\stdClass $body
     * @return array{data: mixed, headers: array<string, string>}
     */
    public function requestSendingSettingsWrite(array|\stdClass $body): array
    {
        try {
            [$status, $rawBody, $responseHeaders] = $this->rawRequest(
                'PUT',
                '/api/v1/settings/sending',
                $body,
                [],
                [],
                null,
                null,
                true
            );
        } catch (NetworkError $error) {
            throw new ParseError(
                'Sending-settings transport outcome is unproven; wait at least 35 seconds ' .
                'from submission, then reconcile canonical settings and cap status before retrying.',
                $error->status,
                $error->requestId
            );
        }
        $parsed = null;
        $parseErr = null;
        if ($rawBody !== '') {
            $decoded = json_decode($rawBody, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $parseErr = json_last_error_msg();
            } else {
                $parsed = $decoded;
            }
        }
        if ($status === 200) {
            if ($parseErr !== null || $rawBody === '') {
                throw new ParseError(
                    'Invalid sending-settings JSON response from Moosewave; wait at least 35 seconds ' .
                    'from submission, then reconcile canonical settings and cap status before retrying.',
                    $status,
                    $responseHeaders['x-request-id'] ?? null
                );
            }
            return ['data' => $parsed, 'headers' => $responseHeaders];
        }
        if ($status >= 200 && $status < 300) {
            throw new ParseError(
                "Unexpected sending-settings HTTP status $status; wait at least 35 seconds " .
                'from submission, then reconcile canonical settings and cap status before retrying.',
                $status,
                $responseHeaders['x-request-id'] ?? null
            );
        }
        if (
            $status < 400
            || ($responseHeaders['x-postwave-sending-cap-outcome'] ?? '') !== 'not-committed'
        ) {
            throw new ParseError(
                'Sending-settings write returned no safe not-committed receipt; ' .
                'wait at least 35 seconds from submission, then reconcile canonical ' .
                'settings and cap status before retrying.',
                $status,
                $responseHeaders['x-request-id'] ?? null
            );
        }
        throw self::buildError($status, $parsed, $rawBody, $responseHeaders);
    }

    /**
     * Low-level request for CSV or plaintext export endpoints.
     *
     * @param array<string, mixed>|\stdClass|null $body
     * @param array<int|string, mixed>  $query
     * @param array<string, string>     $headers
     */
    public function requestText(
        string $method,
        string $path,
        array|\stdClass|null $body = null,
        array $query = [],
        array $headers = []
    ): string {
        [$status, $rawBody, $responseHeaders] = $this->rawRequest($method, $path, $body, $query, $headers);

        if ($status >= 200 && $status < 300) {
            return $rawBody;
        }

        $parsed = null;
        if ($rawBody !== '') {
            $decoded = json_decode($rawBody, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $parsed = $decoded;
            }
        }
        throw self::buildError($status, $parsed, $rawBody, $responseHeaders);
    }

    /**
     * Low-level request for endpoints that take a raw (non-JSON) request
     * body — e.g. CSV import. The body is sent verbatim with the supplied
     * Content-Type; the response is parsed as JSON exactly like request().
     *
     * @param array<int|string, mixed> $query
     * @param array<string, string>    $headers
     * @return mixed Parsed JSON (array | scalar | null).
     */
    public function requestRaw(
        string $method,
        string $path,
        string $rawBody,
        string $contentType,
        array $query = [],
        array $headers = []
    ): mixed {
        [$status, $responseBody, $responseHeaders] = $this->rawRequest(
            $method,
            $path,
            null,
            $query,
            $headers,
            $rawBody,
            $contentType
        );

        $parsed = null;
        $parseErr = null;
        if ($responseBody !== '') {
            $decoded = json_decode($responseBody, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $parseErr = json_last_error_msg();
            } else {
                $parsed = $decoded;
            }
        }
        if ($status >= 200 && $status < 300) {
            if ($parseErr !== null) {
                throw new ParseError("Invalid JSON response from Moosewave: $parseErr", $status);
            }
            return $parsed;
        }
        throw self::buildError($status, $parsed, $responseBody, $responseHeaders);
    }

    /**
     * @param array<string, mixed>|\stdClass|null $body
     * @param array<int|string, mixed>  $query
     * @param array<string, string>     $headers
     * @return array{0: int, 1: string, 2: array<string, string>}
     */
    private function rawRequest(
        string $method,
        string $path,
        array|\stdClass|null $body = null,
        array $query = [],
        array $headers = [],
        ?string $rawStringBody = null,
        ?string $rawStringContentType = null,
        bool $forbidIdempotencyKey = false,
        bool $unescapedJson = false
    ): array {
        $url = $this->baseUrl . $path;
        if ($query) {
            $url .= (str_contains($path, '?') ? '&' : '?') . http_build_query($query);
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new NetworkError('curl_init failed');
        }
        try {
            $extraHeaders = $this->extraHeaders;
            if ($forbidIdempotencyKey) {
                foreach (array_keys($extraHeaders) as $name) {
                    if (strtolower((string) $name) === 'idempotency-key') {
                        unset($extraHeaders[$name]);
                    }
                }
                foreach (array_keys($headers) as $name) {
                    if (strtolower((string) $name) === 'idempotency-key') {
                        unset($headers[$name]);
                    }
                }
            }
            $hasAcceptHeader = false;
            foreach (array_keys($extraHeaders + $headers) as $k) {
                if (strtolower((string) $k) === 'accept') {
                    $hasAcceptHeader = true;
                    break;
                }
            }
            $requestHeaders = [
                'Authorization: Bearer ' . $this->apiKey,
                'User-Agent: postwave-php/0.1.0',
            ];
            if (!$hasAcceptHeader) {
                $requestHeaders[] = 'Accept: application/json';
            }
            foreach ($extraHeaders as $k => $v) {
                $requestHeaders[] = $k . ': ' . $v;
            }
            foreach ($headers as $k => $v) {
                $requestHeaders[] = $k . ': ' . $v;
            }
            if ($rawStringBody !== null) {
                $requestHeaders[] = 'Content-Type: ' . ($rawStringContentType ?? 'application/octet-stream');
                curl_setopt($ch, CURLOPT_POSTFIELDS, $rawStringBody);
            } elseif ($body !== null) {
                $requestHeaders[] = 'Content-Type: application/json';
                $encoded = json_encode(
                    $body,
                    $unescapedJson ? JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE : 0
                );
                if ($encoded === false) {
                    throw new NetworkError('json_encode body: ' . json_last_error_msg());
                }
                curl_setopt($ch, CURLOPT_POSTFIELDS, $encoded);
            }
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CUSTOMREQUEST  => $method,
                CURLOPT_HTTPHEADER     => $requestHeaders,
                CURLOPT_TIMEOUT        => $this->timeout,
                CURLOPT_HEADER         => true,
                // Make the one wire exchange explicit. In particular, cURL
                // must never replay a PUT body while following 307/308.
                CURLOPT_FOLLOWLOCATION => false,
                // Cap downloaded bytes so a server bug or DoS can't
                // exhaust memory. Larger responses raise a NetworkError.
                CURLOPT_BUFFERSIZE     => 65536,
            ]);
            // Track response size; abort if it exceeds MAX_RESPONSE_BYTES.
            $received = 0;
            curl_setopt($ch, CURLOPT_NOPROGRESS, false);
            curl_setopt($ch, CURLOPT_PROGRESSFUNCTION,
                function ($_resource, $_dltotal, $dlnow, $_ultotal, $_ulnow) use (&$received) {
                    $received = (int) $dlnow;
                    return $received > self::MAX_RESPONSE_BYTES ? 1 : 0;
                });

            $raw = curl_exec($ch);
            if ($raw === false) {
                $err = curl_error($ch);
                if ($received > self::MAX_RESPONSE_BYTES) {
                    throw new NetworkError(
                        'response exceeded ' . self::MAX_RESPONSE_BYTES . ' bytes'
                    );
                }
                throw new NetworkError("curl: $err");
            }
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        } finally {
            // CurlHandle is an object on every supported PHP version and its
            // destructor releases the handle. curl_close() has had no effect
            // since PHP 8.0 and is deprecated in PHP 8.5.
            unset($ch);
        }

        $rawString = (string) $raw;
        $rawHeaders = substr($rawString, 0, $headerSize);
        $rawBody = substr($rawString, $headerSize);
        return [$status, $rawBody, self::parseHeaders($rawHeaders)];
    }

    /**
     * @param array<string, string> $headers
     */
    private static function buildError(int $status, mixed $parsed, string $rawBody, array $headers): PostwaveError
    {
        $envelope = is_array($parsed) && isset($parsed['error']) && is_array($parsed['error'])
            ? $parsed['error']
            : null;
        $message = (string) ($envelope['message']
            ?? (is_array($parsed) && isset($parsed['message']) ? $parsed['message'] : "HTTP $status"));
        $code = (string) ($envelope['code'] ?? "http_$status");
        $requestId = isset($envelope['request_id']) && is_string($envelope['request_id'])
            ? $envelope['request_id']
            : null;

        switch ($status) {
            case 401:
                return new AuthError($message, $code, $requestId);
            case 403:
                return new ForbiddenError($message, $code, $requestId);
            case 404:
            case 410:
                return new NotFoundError($message, $code, $requestId);
            case 409:
                return new ConflictError($message, $code, $requestId);
            case 421:
                $location = $headers['location']
                    ?? (is_array($envelope) && isset($envelope['correct_endpoint']) ? (string) $envelope['correct_endpoint'] : '');
                $region = $headers['x-postwave-region']
                    ?? (is_array($envelope) && isset($envelope['region']) ? (string) $envelope['region'] : '');
                return new WrongRegionError($message, $code, (string) $location, (string) $region, $requestId);
            case 422:
                $fields = is_array($envelope) && isset($envelope['fields']) && is_array($envelope['fields'])
                    ? $envelope['fields']
                    : [];
                return new ValidationError($message, $code, $fields, $requestId);
            case 429:
                $retryAfter = null;
                if (isset($headers['retry-after']) && ctype_digit($headers['retry-after'])) {
                    $retryAfter = (int) $headers['retry-after'];
                } elseif (is_array($envelope) && isset($envelope['retry_after_seconds']) && is_int($envelope['retry_after_seconds'])) {
                    $retryAfter = $envelope['retry_after_seconds'];
                }
                return new RateLimitError($message, $code, $retryAfter, $requestId);
        }
        if ($status >= 500) {
            return new ServerError($message, $code, $status, $requestId);
        }
        return new PostwaveError($message, $status, $code, $requestId);
    }

    /**
     * @return array<string, string>
     */
    private static function parseHeaders(string $rawHeaders): array
    {
        $out = [];
        foreach (preg_split("/\r?\n/", $rawHeaders) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || !str_contains($line, ':')) {
                continue;
            }
            [$k, $v] = explode(':', $line, 2);
            // Lowercase header names so callers don't need to know
            // about case sensitivity. Last-write-wins for duplicates
            // — same as the Go +Header.Get semantics.
            $out[strtolower(trim($k))] = trim($v);
        }
        return $out;
    }
}
