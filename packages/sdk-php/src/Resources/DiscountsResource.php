<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * DiscountsResource — sanitized, tenant-scoped discount history.
 * Redeemable codes, tenant/provider identifiers, subscriber identities,
 * live checks, exports, and mutations are outside this public surface.
 * Mirrors packages/sdk-ts/src/resources/discounts.ts.
 */
final class DiscountsResource extends Resource
{
    /**
     * limit is 1-100 (default 50); offset is 0-10000 (default 0).
     * @return array{items: list<array<string, mixed>>, has_more: bool}
     */
    public function list(
        ?int $limit = null,
        ?int $offset = null,
        ?string $recordId = null
    ): array
    {
        $query = array_filter([
            'record_id' => $recordId === null
                ? null
                : self::canonicalRecordId($recordId),
            'limit' => self::boundedInteger('limit', $limit, 1, 100),
            'offset' => self::boundedInteger('offset', $offset, 0, 10000),
        ], static fn (mixed $value): bool => $value !== null);
        $out = $this->client->request('GET', '/api/v1/discounts', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * Return PII-free events for an opaque discount record UUID. limit is
     * 1-100 (default 50); offset is 0-10000 (default 0).
     *
     * @return array{items: list<array{redeemed_at: string, subscriber_linked: bool}>, has_more: bool}
     */
    public function redemptions(
        string $recordId,
        ?int $limit = null,
        ?int $offset = null
    ): array
    {
        $recordId = self::canonicalRecordId($recordId);
        $query = array_filter([
            'limit' => self::boundedInteger('limit', $limit, 1, 100),
            'offset' => self::boundedInteger('offset', $offset, 0, 10000),
        ], static fn (mixed $value): bool => $value !== null);
        $out = $this->client->request(
            'GET',
            '/api/v1/discounts/' . rawurlencode($recordId) . '/redemptions',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    private static function canonicalRecordId(string $recordId): string
    {
        if (!preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iD',
            $recordId
        )) {
            throw new \InvalidArgumentException(
                'Discount history record_id must be a canonical UUID'
            );
        }

        return strtolower($recordId);
    }

    private static function boundedInteger(
        string $name,
        ?int $value,
        int $minimum,
        int $maximum
    ): ?int
    {
        if ($value === null) {
            return null;
        }
        if ($value < $minimum || $value > $maximum) {
            throw new \InvalidArgumentException(sprintf(
                'Discount history %s must be between %d and %d',
                $name,
                $minimum,
                $maximum
            ));
        }

        return $value;
    }
}
