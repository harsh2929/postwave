<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Authenticated campaign-poll authoring and aggregate-report operations.
 * Signed recipient preview/confirmation links are deliberately not SDK calls.
 */
final class CampaignPollsResource extends Resource
{
    private const STABLE_REFERENCE = '/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/D';
    private const OPAQUE_CURSOR = '/^[A-Za-z0-9._-]+$/D';
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/Di';

    /**
     * Materialize one poll already present in the exact immutable semantic-v2
     * AST. Question and options are never accepted from the caller.
     *
     * @param array{
     *   content_revision_id: string,
     *   poll_key: string,
     *   two_step_required?: bool,
     *   closes_at?: string
     * } $input
     * @return array<string, mixed> Immutable CampaignPollDefinition.
     */
    public function materialize(string $campaignId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . self::campaignSegment($campaignId) . '/polls',
            self::materializationInput($input)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{limit?: int, cursor?: string} $options
     * @return array<string, mixed> One bounded CampaignPollList keyset page.
     */
    public function list(string $campaignId, array $options = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaigns/' . self::campaignSegment($campaignId) . '/polls',
            null,
            self::listQuery($options)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Read counted human confirmations and all explicitly excluded populations
     * (`machine_excluded`, `unclassified_excluded`, `voided_multi_option`,
     * `superseded_choices`, and `previewed_only`).
     *
     * @return array<string, mixed> CampaignPollTally.
     */
    public function tally(string $campaignId, string $pollKey): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaigns/'
                . self::campaignSegment($campaignId)
                . '/polls/'
                . rawurlencode(self::stableReference($pollKey, 'poll key'))
                . '/tally'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array{content_revision_id: string, poll_key: string, two_step_required?: bool, closes_at?: string}
     */
    private static function materializationInput(array $input): array
    {
        $allowed = ['content_revision_id', 'poll_key', 'two_step_required', 'closes_at'];
        foreach (array_keys($input) as $field) {
            if (!is_string($field) || !in_array($field, $allowed, true)) {
                throw new \InvalidArgumentException(
                    'campaign poll materialization accepts runtime settings only; question and options come from the semantic AST'
                );
            }
        }
        foreach (['content_revision_id', 'poll_key'] as $required) {
            if (!array_key_exists($required, $input)) {
                throw new \InvalidArgumentException("campaign poll materialization requires $required");
            }
        }
        if (
            !is_string($input['content_revision_id'])
            || preg_match(self::UUID, $input['content_revision_id']) !== 1
        ) {
            throw new \InvalidArgumentException('campaign poll content revision ID must be a canonical UUID');
        }
        $pollKey = self::stableReference($input['poll_key'], 'poll key');
        if (array_key_exists('two_step_required', $input) && !is_bool($input['two_step_required'])) {
            throw new \InvalidArgumentException('campaign poll two_step_required must be a boolean');
        }
        if (array_key_exists('closes_at', $input)) {
            self::rfc3339($input['closes_at']);
        }

        $body = [
            'content_revision_id' => $input['content_revision_id'],
            'poll_key' => $pollKey,
        ];
        if (array_key_exists('two_step_required', $input)) {
            $body['two_step_required'] = $input['two_step_required'];
        }
        if (array_key_exists('closes_at', $input)) {
            $body['closes_at'] = $input['closes_at'];
        }
        return $body;
    }

    /**
     * @param array<string, mixed> $options
     * @return array{limit?: int, cursor?: string}
     */
    private static function listQuery(array $options): array
    {
        foreach (array_keys($options) as $field) {
            if (!is_string($field) || !in_array($field, ['limit', 'cursor'], true)) {
                throw new \InvalidArgumentException('campaign poll list options contain an unknown field');
            }
        }
        $query = [];
        if (array_key_exists('limit', $options)) {
            if (!is_int($options['limit']) || $options['limit'] < 1 || $options['limit'] > 100) {
                throw new \InvalidArgumentException(
                    'campaign poll list limit must be an integer from 1 to 100'
                );
            }
            $query['limit'] = $options['limit'];
        }
        if (array_key_exists('cursor', $options)) {
            $cursor = $options['cursor'];
            if (
                !is_string($cursor)
                || strlen($cursor) < 1
                || strlen($cursor) > 512
                || preg_match(self::OPAQUE_CURSOR, $cursor) !== 1
            ) {
                throw new \InvalidArgumentException(
                    'campaign poll list cursor must be a 1-512 byte opaque ASCII cursor'
                );
            }
            $query['cursor'] = $cursor;
        }
        return $query;
    }

    private static function campaignSegment(string $campaignId): string
    {
        if ($campaignId === '' || trim($campaignId) === '' || preg_match('//u', $campaignId) !== 1) {
            throw new \InvalidArgumentException('campaign poll campaign ID is required');
        }
        return rawurlencode($campaignId);
    }

    private static function stableReference(mixed $value, string $label): string
    {
        if (!is_string($value) || preg_match(self::STABLE_REFERENCE, $value) !== 1) {
            throw new \InvalidArgumentException(
                "campaign poll $label must be a 1-128 byte stable ASCII reference"
            );
        }
        return $value;
    }

    private static function rfc3339(mixed $value): void
    {
        if (
            !is_string($value)
            || preg_match(
                '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D',
                $value
            ) !== 1
        ) {
            throw new \InvalidArgumentException('campaign poll closes_at must be an RFC3339 timestamp');
        }
        try {
            new \DateTimeImmutable($value);
        } catch (\Exception) {
            throw new \InvalidArgumentException('campaign poll closes_at must be an RFC3339 timestamp');
        }
    }
}
