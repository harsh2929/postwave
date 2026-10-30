<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Strict, identity-minimizing decoder for the F04 campaign evidence page.
 * Summary fields are counts only; currency-scoped amounts remain item-level.
 */
final class CampaignDirectAttributionEvidenceContract
{
    /** @var list<string> */
    private const SUMMARY_FIELDS = [
        'code_allocations',
        'code_redemptions',
        'code_linked_outcomes',
        'no_click_redemptions',
        'with_click_redemptions',
        'click_evidence_unavailable',
        'vanity_visits',
        'vanity_linked_outcomes',
    ];

    /** @var list<string> */
    private const ITEM_FIELDS = [
        'kind',
        'evidence_id',
        'occurred_at',
        'status',
        'expires_at',
        'redeemed_at',
        'redemption_id',
        'conversion_id',
        'amount_cents',
        'currency',
        'attributed_via',
        'attribution_scope',
        'linked_without_recorded_assignment_click',
        'readership_proven',
    ];

    /** @param array<string, mixed> $options @return array{limit: int, offset: int} */
    public static function listQuery(array $options): array
    {
        self::closedObject($options, ['limit', 'offset'], [], 'list options');
        $limit = $options['limit'] ?? 25;
        $offset = $options['offset'] ?? 0;
        if (!is_int($limit) || $limit < 1 || $limit > 100) {
            throw new \InvalidArgumentException(
                'campaign direct-attribution evidence limit must be an integer from 1 to 100'
            );
        }
        if (!is_int($offset) || $offset < 0 || $offset > 10_000) {
            throw new \InvalidArgumentException(
                'campaign direct-attribution evidence offset must be an integer from 0 to 10000'
            );
        }
        return ['limit' => $limit, 'offset' => $offset];
    }

    public static function campaignSegment(string $campaignId): string
    {
        if ($campaignId === '' || trim($campaignId) === '' || preg_match('//u', $campaignId) !== 1) {
            throw new \InvalidArgumentException(
                'campaign direct-attribution evidence campaign ID is required'
            );
        }
        return rawurlencode($campaignId);
    }

    /**
     * @return array{
     *   campaign_id: string,
     *   summary: array<string, int>,
     *   items: list<array{
     *     kind: 'code_allocation'|'vanity_visit', evidence_id: string,
     *     occurred_at: string, status: string, expires_at: ?string,
     *     redeemed_at: ?string, redemption_id: ?int, conversion_id: ?int,
     *     amount_cents: ?int, currency: string,
     *     attributed_via: 'code_redemption'|'campaign_vanity_path',
     *     attribution_scope: 'campaign_assignment'|'campaign',
     *     linked_without_recorded_assignment_click: ?bool,
     *     readership_proven: false
     *   }>,
     *   page_info: array{limit: int, offset: int, total: int, has_more: bool}
     * }
     */
    public static function decodePage(mixed $value): array
    {
        $root = self::object($value, 'page');
        self::closedObject(
            $root,
            ['campaign_id', 'summary', 'items', 'page_info'],
            ['campaign_id', 'summary', 'items', 'page_info'],
            'page'
        );

        $summaryRaw = self::object($root['summary'], 'summary');
        self::closedObject($summaryRaw, self::SUMMARY_FIELDS, self::SUMMARY_FIELDS, 'summary');
        $summary = [];
        foreach (self::SUMMARY_FIELDS as $field) {
            $summary[$field] = self::integer($summaryRaw[$field], "summary.$field", 0);
        }
        $remainingClickStates = $summary['code_redemptions'];
        if (
            $summary['code_redemptions'] > $summary['code_allocations']
            || $summary['code_linked_outcomes'] > $summary['code_allocations']
            || $summary['no_click_redemptions'] > $remainingClickStates
        ) {
            throw new \UnexpectedValueException(
                'inconsistent campaign direct-attribution evidence summary'
            );
        }
        $remainingClickStates -= $summary['no_click_redemptions'];
        if ($summary['with_click_redemptions'] > $remainingClickStates) {
            throw new \UnexpectedValueException(
                'inconsistent campaign direct-attribution evidence summary'
            );
        }
        $remainingClickStates -= $summary['with_click_redemptions'];
        if (
            $summary['click_evidence_unavailable'] !== $remainingClickStates
            || $summary['vanity_linked_outcomes'] > $summary['vanity_visits']
        ) {
            throw new \UnexpectedValueException(
                'inconsistent campaign direct-attribution evidence summary'
            );
        }

        if (!is_array($root['items']) || !array_is_list($root['items']) || count($root['items']) > 100) {
            throw new \UnexpectedValueException(
                'invalid campaign direct-attribution evidence items'
            );
        }
        $items = [];
        foreach ($root['items'] as $index => $candidate) {
            $item = self::object($candidate, "item $index");
            self::closedObject($item, self::ITEM_FIELDS, self::ITEM_FIELDS, "item $index");
            $kind = self::oneOf($item['kind'], ['code_allocation', 'vanity_visit'], 'item kind');
            $via = self::oneOf(
                $item['attributed_via'],
                ['code_redemption', 'campaign_vanity_path'],
                'item attributed_via'
            );
            $scope = self::oneOf(
                $item['attribution_scope'],
                ['campaign_assignment', 'campaign'],
                'item attribution_scope'
            );
            $expected = $kind === 'code_allocation'
                ? ['code_redemption', 'campaign_assignment']
                : ['campaign_vanity_path', 'campaign'];
            if ([$via, $scope] !== $expected) {
                throw new \UnexpectedValueException(
                    'inconsistent campaign direct-attribution evidence provenance'
                );
            }
            if ($item['readership_proven'] !== false) {
                throw new \UnexpectedValueException(
                    'campaign direct-attribution evidence cannot prove readership'
                );
            }
            $click = $item['linked_without_recorded_assignment_click'];
            if ($click !== null && !is_bool($click)) {
                throw new \UnexpectedValueException(
                    'invalid campaign direct-attribution evidence click observation'
                );
            }
            $amountCents = self::nullableInteger($item['amount_cents'], 'item amount_cents');
            $currency = self::string($item['currency'], 'item currency', true);
            if ($currency !== '' && preg_match('/^[A-Z]{3}$/D', $currency) !== 1) {
                throw new \UnexpectedValueException(
                    'invalid campaign direct-attribution evidence currency provenance'
                );
            }
            $items[] = [
                'kind' => $kind,
                'evidence_id' => self::uuid($item['evidence_id'], 'item evidence_id'),
                'occurred_at' => self::timestamp($item['occurred_at'], 'item occurred_at'),
                'status' => self::string($item['status'], 'item status'),
                'expires_at' => self::nullableTimestamp($item['expires_at'], 'item expires_at'),
                'redeemed_at' => self::nullableTimestamp($item['redeemed_at'], 'item redeemed_at'),
                'redemption_id' => self::nullableInteger($item['redemption_id'], 'item redemption_id', 1),
                'conversion_id' => self::nullableInteger($item['conversion_id'], 'item conversion_id', 1),
                'amount_cents' => $amountCents,
                'currency' => $currency,
                'attributed_via' => $via,
                'attribution_scope' => $scope,
                'linked_without_recorded_assignment_click' => $click,
                'readership_proven' => false,
            ];
        }

        $pageRaw = self::object($root['page_info'], 'page_info');
        self::closedObject(
            $pageRaw,
            ['limit', 'offset', 'total', 'has_more'],
            ['limit', 'offset', 'total', 'has_more'],
            'page_info'
        );
        $limit = self::integer($pageRaw['limit'], 'page_info.limit', 1);
        $offset = self::integer($pageRaw['offset'], 'page_info.offset', 0);
        $total = self::integer($pageRaw['total'], 'page_info.total', 0);
        if (
            $limit > 100
            || $offset > 10_000
            || !is_bool($pageRaw['has_more'])
            || count($items) > $limit
            || $summary['code_allocations'] > $total
            || $summary['vanity_visits'] !== $total - $summary['code_allocations']
            || $pageRaw['has_more'] !== ($offset + count($items) < $total)
        ) {
            throw new \UnexpectedValueException(
                'inconsistent campaign direct-attribution evidence page_info'
            );
        }

        return [
            'campaign_id' => self::uuid($root['campaign_id'], 'campaign_id'),
            'summary' => $summary,
            'items' => $items,
            'page_info' => [
                'limit' => $limit,
                'offset' => $offset,
                'total' => $total,
                'has_more' => $pageRaw['has_more'],
            ],
        ];
    }

    /** @return array<string, mixed> */
    private static function object(mixed $value, string $label): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $value;
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     * @param list<string> $required
     */
    private static function closedObject(
        array $value,
        array $allowed,
        array $required,
        string $label
    ): void {
        foreach (array_keys($value) as $field) {
            if (!is_string($field) || !in_array($field, $allowed, true)) {
                throw new \UnexpectedValueException(
                    "invalid campaign direct-attribution evidence $label fields"
                );
            }
        }
        foreach ($required as $field) {
            if (!array_key_exists($field, $value)) {
                throw new \UnexpectedValueException(
                    "invalid campaign direct-attribution evidence $label fields"
                );
            }
        }
    }

    private static function integer(mixed $value, string $label, ?int $minimum = null): int
    {
        if (!is_int($value) || ($minimum !== null && $value < $minimum)) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $value;
    }

    private static function nullableInteger(
        mixed $value,
        string $label,
        ?int $minimum = null
    ): ?int {
        return $value === null ? null : self::integer($value, $label, $minimum);
    }

    private static function string(mixed $value, string $label, bool $allowEmpty = false): string
    {
        if (!is_string($value) || (!$allowEmpty && trim($value) === '')) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $value;
    }

    /** @param list<string> $allowed */
    private static function oneOf(mixed $value, array $allowed, string $label): string
    {
        $result = self::string($value, $label);
        if (!in_array($result, $allowed, true)) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $result;
    }

    private static function uuid(mixed $value, string $label): string
    {
        $result = self::string($value, $label);
        if (
            preg_match(
                '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/Di',
                $result
            ) !== 1
        ) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $result;
    }

    private static function timestamp(mixed $value, string $label): string
    {
        $result = self::string($value, $label);
        $parts = [];
        if (
            preg_match(
                '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/D',
                $result,
                $parts
            ) !== 1
            || (int) $parts[1] < 1
            || (int) $parts[2] < 1
            || (int) $parts[2] > 12
            || (int) $parts[3] < 1
            || (int) $parts[4] > 23
            || (int) $parts[5] > 59
            || (int) $parts[6] > 59
            || (($parts[7] ?? '') !== '' && (int) $parts[7] > 23)
            || (($parts[8] ?? '') !== '' && (int) $parts[8] > 59)
        ) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        try {
            new \DateTimeImmutable($result);
        } catch (\Exception) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        $errors = \DateTimeImmutable::getLastErrors();
        if (
            $errors !== false
            && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)
        ) {
            throw new \UnexpectedValueException(
                "invalid campaign direct-attribution evidence $label"
            );
        }
        return $result;
    }

    private static function nullableTimestamp(mixed $value, string $label): ?string
    {
        return $value === null ? null : self::timestamp($value, $label);
    }
}
