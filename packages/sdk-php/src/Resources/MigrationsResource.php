<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * MigrationsResource — ESP/CRM migration lifecycle: OAuth/credential
 * onboarding, discover/dry-run/commit, delta import, shadow/source-event
 * monitoring, pilot acceptance, cutover evidence, rollback rehearsal, and
 * rollback.
 * Mirrors packages/sdk-ts/src/resources/migrations.ts.
 */
final class MigrationsResource extends Resource
{
    /** @var array<int, string> */
    private const SOURCES = [
        'mailchimp', 'klaviyo', 'customerio', 'constant-contact', 'aweber',
        'drip', 'campaign-monitor', 'omnisend', 'loops', 'flodesk', 'bento',
        'activecampaign', 'hubspot', 'convertkit', 'brevo', 'substack',
        'beehiiv', 'mailerlite', 'sendy', 'csv',
    ];

    private static function sourceSegment(string $source): string
    {
        if (!in_array($source, self::SOURCES, true)) {
            throw new \InvalidArgumentException("Unsupported migration source: $source");
        }
        return rawurlencode($source);
    }

    private static function jobSegment(string $jobId): string
    {
        $trimmed = trim($jobId);
        if ($trimmed === '') {
            throw new \InvalidArgumentException('Migration job ID is required');
        }
        return rawurlencode($trimmed);
    }

    private static function sourceEventSegment(string $eventId): string
    {
        $trimmed = trim($eventId);
        if ($trimmed === '') {
            throw new \InvalidArgumentException('Migration source-event result ID is required');
        }
        return rawurlencode($trimmed);
    }

    /**
     * @param array<int, string>|null $selectedAudienceIds
     * @return array<string, mixed>
     */
    private static function migrationRunBody(
        string $source,
        string $jobId,
        ?array $selectedAudienceIds,
        bool $requireMailchimpScope
    ): array {
        if ($requireMailchimpScope && $source === 'mailchimp' && ($selectedAudienceIds === null || $selectedAudienceIds === [])) {
            throw new \InvalidArgumentException('Mailchimp dry-run and commit require at least one selected audience ID');
        }
        $body = ['job_id' => $jobId];
        if ($selectedAudienceIds !== null) {
            $normalized = array_map(static fn (string $id): string => trim($id), $selectedAudienceIds);
            if (in_array('', $normalized, true)) {
                throw new \InvalidArgumentException('Mailchimp audience IDs must not be empty');
            }
            $body['selected_audience_ids'] = array_values($normalized);
        }
        return $body;
    }

    private static function uploadSegment(string $uploadId): string
    {
        $trimmed = trim($uploadId);
        if ($trimmed === '') {
            throw new \InvalidArgumentException('Migration upload ID is required');
        }
        return rawurlencode($trimmed);
    }

    /** @return array{upload_id: string, received: int, total: int, updated_at: string} */
    public function uploadStatus(string $source, string $uploadId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/uploads/' . self::uploadSegment($uploadId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Begin OAuth handshake; pass an existing non-running job ID to reconnect
     * OAuth to that same migration job.
     *
     * @return array<string, mixed>
     */
    public function start(string $source, ?string $jobId = null): array
    {
        $query = [];
        if ($jobId !== null) {
            $jobId = trim($jobId);
            if ($jobId === '') {
                throw new \InvalidArgumentException('Migration job ID is required for OAuth reconnect');
            }
            $query['job_id'] = $jobId;
        }
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/oauth/start',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /** Complete OAuth — typically called by the gateway, exposed for tests. */
    /** @return array<string, mixed> */
    public function callback(string $source, string $code, string $state): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/oauth/callback',
            null,
            ['code' => $code, 'state' => $state]
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Create a migration job for credential-based sources.
     *
     * For ActiveCampaign, pass the API token as api_key and the account API URL
     * from Settings -> Developer as account_id or extra['api_url'].
     * For HubSpot, pass the private app token as api_key and optionally pass
     * the hub ID as account_id or extra['hub_id'].
     * For Beehiiv, pass the API key and optionally select the publication as
     * account_id or extra['publication_id']; selection is required when the
     * key can access multiple publications.
     * For Klaviyo, pass a private API key as api_key, or a caller-managed bearer
     * credential as access_token with an optional refresh_token; account_id is
     * required only when the credential exposes more than one account. This raw
     * handoff is separate from managed native-integration OAuth. An unrolled-back
     * tenant/account lineage must refresh and run deltas on its original job; a
     * second same-account job is rejected.
     * For Customer.io, pass an App API key (not a Track API site key), set
     * extra['region'] to us or eu, and pass the numeric workspace ID as
     * account_id when the key exposes multiple workspaces. Reuse the same
     * unrolled-back region/workspace job lineage for refreshes and deltas.
     *
     * @param array{api_key?: string, access_token?: string, refresh_token?: string, account_id?: string, extra?: array<string, string>} $input
     * @return array<string, mixed>
     */
    public function credentials(string $source, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/credentials',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Pre-flight inventory of what's in the source account.
     * HubSpot's segments_count combines list snapshots with one targeting
     * boundary for each active email subscription definition.
     *
     * @param array<int, string>|null $selectedAudienceIds
     * @return array{
     *     source?: string,
     *     subscribers_count?: int,
     *     profiles_without_email_count?: int,
     *     additional_email_identities_count?: int,
     *     segments_count?: int,
     *     automations_count?: int,
     *     paid_subs_count?: int,
     *     archive_count?: int,
     *     source_archive_count?: int,
     *     templates_count?: int,
     *     campaigns_count?: int,
     *     reports_count?: int,
     *     groups_count?: int,
     *     forms_count?: int,
     *     landing_pages_count?: int,
     *     ecommerce_count?: int,
     *     custom_objects_count?: int,
     *     subscription_channels_count?: int,
     *     sms_campaigns_count?: int,
     *     push_campaigns_count?: int,
     *     resource_metadata?: array<int, array<string, mixed>>,
     *     custom_fields?: array<int, string>,
     *     warnings?: array<int, string>,
     *     audiences?: array<int, array<string, mixed>>,
     *     capabilities?: array<string, mixed>
     * }
     */
    public function discover(string $source, string $jobId, ?array $selectedAudienceIds = null): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/discover',
            self::migrationRunBody($source, $jobId, $selectedAudienceIds, false)
        );
        return is_array($out) ? $out : [];
    }

    /** Kick off a dry-run migration (verification report only). */
    /**
     * @param array<int, string>|null $selectedAudienceIds
     * @return array<string, mixed>
     */
    public function dryRun(string $source, string $jobId, ?array $selectedAudienceIds = null): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/dry-run',
            self::migrationRunBody($source, $jobId, $selectedAudienceIds, true)
        );
        return is_array($out) ? $out : [];
    }

    /** Run the full migration into Moosewave. */
    /**
     * @param array<int, string>|null $selectedAudienceIds
     * @return array<string, mixed>
     */
    public function commit(string $source, string $jobId, ?array $selectedAudienceIds = null): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/commit',
            self::migrationRunBody($source, $jobId, $selectedAudienceIds, true)
        );
        return is_array($out) ? $out : [];
    }

    /** Replay an authenticated job to import source-side changes since the last run. */
    /** @return array<string, mixed> */
    public function deltaImport(string $source, string $jobId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/delta-import',
            ['job_id' => $jobId]
        );
        return is_array($out) ? $out : [];
    }

    /** Compare current source inventory with the latest verification report. */
    /** @return array<string, mixed> */
    public function shadowCheck(string $source, string $jobId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::sourceSegment($source) . '/shadow-check',
            ['job_id' => $jobId]
        );
        return is_array($out) ? $out : [];
    }

    /** Enable periodic shadow checks during a customer pilot overlap window. */
    /** @return array<string, mixed> */
    public function startShadowMonitor(string $source, string $jobId, int $intervalSeconds = 3600): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/sources/' . self::sourceSegment($source) . '/shadow-monitor',
            ['job_id' => $jobId, 'interval_seconds' => $intervalSeconds]
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function shadowMonitor(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/shadow-monitor'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function stopShadowMonitor(string $jobId): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/shadow-monitor'
        );
        return is_array($out) ? $out : [];
    }

    /** Enable incremental source-event polling during a migration overlap window. */
    /** @return array<string, mixed> */
    public function startSourceEvents(string $source, string $jobId, int $intervalSeconds = 3600): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/sources/' . self::sourceSegment($source) . '/source-events',
            ['job_id' => $jobId, 'interval_seconds' => $intervalSeconds]
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function sourceEvents(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/source-events'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function stopSourceEvents(string $jobId, bool $postPilotCleanup = false): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/source-events',
            null,
            $postPilotCleanup ? ['post_pilot_cleanup' => '1'] : []
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Attach auditable evidence to an intentionally unapplied manual-review
     * event, or reopen that review. Reviewed requests accept 1-50 non-secret
     * references of at most 500 Unicode characters each and detail of at most
     * 1,000 Unicode characters. This never changes the applied flag.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function updateSourceEventReview(string $jobId, string $eventId, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/source-events/' . self::sourceEventSegment($eventId) . '/review',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** Poll a migration job. */
    /** @return array<string, mixed> */
    public function get(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Refresh the encrypted source session for an existing job without creating a new migration.
     *
     * @param array{api_key?: string, access_token?: string, refresh_token?: string, account_id?: string, extra?: array<string, string>} $input
     * @return array<string, mixed>
     */
    public function refreshSourceSession(string $jobId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/source-session',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** List recent migration jobs for the tenant. */
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/migrations');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function verification(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/verification'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pilotAcceptance(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/pilot-acceptance'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Record reviewed cutover evidence for pilot acceptance gates.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function recordCutoverEvidence(string $jobId, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/cutover-evidence',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function rollbackRehearsal(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/rollback-rehearsal'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function automationRebuilds(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/automation-rebuilds'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $item
     * @return array<string, mixed>
     */
    public function updateAutomationRebuild(string $jobId, array $item): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/automation-rebuilds',
            $item
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Start rollback for an eligible completed, cancelled, or partially
     * failed migration within its rollback window.
     *
     * @return array{job_id: string, state: string}
     */
    public function rollback(string $jobId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/rollback'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function rollbackStatus(string $jobId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/migrations/' . self::jobSegment($jobId) . '/rollback-status'
        );
        return is_array($out) ? $out : [];
    }

    /** Adapter capability matrix. */
    /** @return array<int, mixed> */
    public function listSources(): array
    {
        $out = $this->client->request('GET', '/api/v1/migrations/sources');
        return is_array($out) ? $out : [];
    }
}
