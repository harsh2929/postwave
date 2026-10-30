<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Tenant-scoped immutable Campaign Assurance receipts and governed actions.
 *
 * Modeled results are predictions, not observations from a private inbox.
 * Controlled observations apply only to explicitly named seed environments.
 */
final class CampaignAssuranceResource extends Resource
{
    /** @var list<string> */
    public const PROFILES = CampaignAssuranceContract::PROFILES;
    /** @var list<string> */
    public const APPEAL_DECISIONS = CampaignAssuranceContract::APPEAL_DECISIONS;

    /**
     * Replace the complete sender-authored Fact Contract on the reviewed
     * mutable campaign version. The payload is the direct closed v1 object;
     * pass [] to transmit the API's explicit empty JSON object `{}` state.
     *
     * @param array{
     *   schema_version?: 1,
     *   primary_intent?: array{kind: string, statement: string},
     *   audience_context?: array{description: string, targeting_reference?: string},
     *   core_claim?: array{statement: string, source_block_ids?: list<string>},
     *   primary_action?: array{action_id: string, block_id: string, role: string, label: string, canonical_url?: string},
     *   required_facts?: list<array<string, mixed>>,
     *   forbidden_claims?: list<array{id: string, statement: string}>,
     *   allowed_secondary_actions?: list<string>,
     *   language?: string
     * } $contract Fact Contract v1, or [] to clear it.
     * @return array{campaign: array<string, mixed>, etag: string}
     */
    public function setFactContract(
        string $campaignId,
        array $contract,
        string $ifMatch,
        ?string $idempotencyKey = null
    ): array {
        $validated = CampaignAssuranceContract::factContract($contract);
        // PHP encodes [] as a JSON array. The API's no-contract state is the
        // direct empty JSON object, so deliberately use stdClass here.
        $body = $validated === [] ? new \stdClass() : $validated;
        $headers = CampaignAssuranceContract::mutationHeaders($idempotencyKey);
        $headers['If-Match'] = CampaignAssuranceContract::strongETag($ifMatch);

        $response = $this->client->requestWithHeaders(
            'PUT',
            '/api/v1/campaigns/' . self::segment($campaignId, 'campaign ID') . '/fact-contract',
            $body,
            [],
            $headers
        );
        if (!is_array($response['data']) || array_is_list($response['data'])) {
            throw new \UnexpectedValueException('setFactContract response campaign must be a JSON object');
        }
        $nextETag = $response['headers']['etag'] ?? '';
        try {
            $nextETag = CampaignAssuranceContract::strongETag($nextETag);
        } catch (\InvalidArgumentException $error) {
            throw new \UnexpectedValueException(
                'setFactContract response did not include a valid strong campaign ETag',
                0,
                $error
            );
        }

        /** @var array<string, mixed> $campaign */
        $campaign = $response['data'];
        return ['campaign' => $campaign, 'etag' => $nextETag];
    }

    /**
     * Create a durable run for a frozen snapshot. A 202 receipt means only
     * that processing was accepted; it is not a pass result.
     *
     * `include_seed_test=true` and `observed_surfaces` express a request for
     * named controlled observations. They do not claim provider execution.
     * Until a controlled-client adapter is configured, the API fails such a
     * request closed with `controlled_observation_unavailable` before it
     * creates a snapshot or run.
     *
     * @param array{
     *   profile: 'fast'|'full'|'calibration',
     *   request_id: string,
     *   content_revision_id?: string,
     *   send_plan_id?: string,
     *   include_seed_test?: bool,
     *   observed_surfaces?: list<string>
     * } $input
     * @return array<string, mixed> Versioned Campaign Assurance envelope.
     */
    public function createRun(
        string $campaignId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaigns/' . self::segment($campaignId, 'campaign ID') . '/assurance-runs',
            CampaignAssuranceContract::createRunInput($input),
            [],
            CampaignAssuranceContract::mutationHeaders($idempotencyKey)
        ));
    }

    /** Blueprint-compatible spelling for createRun(). */
    public function run(
        string $campaignId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return $this->createRun($campaignId, $input, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function getLatest(string $campaignId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaigns/' . self::segment($campaignId, 'campaign ID') . '/assurance'
        ));
    }

    /** @return array<string, mixed> */
    public function getRun(string $campaignId, string $runId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            self::runPath($campaignId, $runId)
        ));
    }

    /** @return array<string, mixed> */
    public function getManifest(string $campaignId, string $runId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            self::runPath($campaignId, $runId) . '/manifest'
        ));
    }

    /**
     * Every collection in the evidence envelope uses the same limit/offset
     * and reports its own total and next_offset.
     *
     * @param array{limit?: int, offset?: int} $options
     * @return array<string, mixed>
     */
    public function getEvidence(
        string $campaignId,
        string $runId,
        array $options = []
    ): array {
        return self::arrayResult($this->client->request(
            'GET',
            self::runPath($campaignId, $runId) . '/evidence',
            null,
            CampaignAssuranceContract::evidenceQuery($options)
        ));
    }

    /**
     * Return the current aggregate progress snapshot. Despite the compatibility
     * route name, this is neither SSE nor durable event history.
     *
     * @return array<string, mixed>
     */
    public function getEvents(string $campaignId, string $runId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            self::runPath($campaignId, $runId) . '/events'
        ));
    }

    /**
     * @param array{request_id: string, decision: 'allow_send'|'reject', reason: string, expires_at?: string} $input
     * @return array<string, mixed>
     */
    public function appealFinding(
        string $campaignId,
        string $runId,
        string $findingId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            self::findingPath($campaignId, $runId, $findingId) . '/appeals',
            CampaignAssuranceContract::appealInput($input),
            [],
            CampaignAssuranceContract::mutationHeaders($idempotencyKey)
        ));
    }

    /** Convenience spelling for appealFinding(). */
    public function appeal(
        string $campaignId,
        string $runId,
        string $findingId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return $this->appealFinding($campaignId, $runId, $findingId, $input, $idempotencyKey);
    }

    /**
     * Compatibility alias exposed by the API. It records the same governed
     * decision and does not apply a content patch.
     *
     * @param array{request_id: string, decision: 'allow_send'|'reject', reason: string, expires_at?: string} $input
     * @return array<string, mixed>
     */
    public function overrideFinding(
        string $campaignId,
        string $runId,
        string $findingId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            self::findingPath($campaignId, $runId, $findingId) . '/overrides',
            CampaignAssuranceContract::appealInput($input),
            [],
            CampaignAssuranceContract::mutationHeaders($idempotencyKey)
        ));
    }

    /** Blueprint-compatible spelling for overrideFinding(). */
    public function override(
        string $campaignId,
        string $runId,
        string $findingId,
        array $input,
        ?string $idempotencyKey = null
    ): array {
        return $this->overrideFinding($campaignId, $runId, $findingId, $input, $idempotencyKey);
    }

    /**
     * Apply only the server-stored deterministic patch as a new immutable
     * revision. Caller-supplied patch instructions are never transported.
     *
     * @param array{request_id: string} $input
     * @return array<string, mixed>
     */
    public function applyFinding(
        string $campaignId,
        string $runId,
        string $findingId,
        array $input,
        string $ifMatch,
        ?string $idempotencyKey = null
    ): array {
        $headers = CampaignAssuranceContract::mutationHeaders($idempotencyKey);
        $headers['If-Match'] = CampaignAssuranceContract::strongETag($ifMatch);
        return self::arrayResult($this->client->request(
            'POST',
            self::findingPath($campaignId, $runId, $findingId) . '/apply',
            CampaignAssuranceContract::applyFindingInput($input),
            [],
            $headers
        ));
    }

    /** @return array<string, mixed> */
    public function cancelRun(
        string $campaignId,
        string $runId,
        ?string $idempotencyKey = null
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            self::runPath($campaignId, $runId) . '/cancel',
            null,
            [],
            CampaignAssuranceContract::mutationHeaders($idempotencyKey)
        ));
    }

    private static function runPath(string $campaignId, string $runId): string
    {
        return '/api/v1/campaigns/'
            . self::segment($campaignId, 'campaign ID')
            . '/assurance-runs/'
            . self::segment($runId, 'run ID');
    }

    private static function findingPath(
        string $campaignId,
        string $runId,
        string $findingId
    ): string {
        return self::runPath($campaignId, $runId)
            . '/findings/'
            . self::segment($findingId, 'finding ID');
    }

    private static function segment(string $value, string $label): string
    {
        return CampaignAssuranceContract::pathSegment($value, $label);
    }

    /** @return array<string, mixed> */
    private static function arrayResult(mixed $value): array
    {
        return is_array($value) ? $value : [];
    }
}
