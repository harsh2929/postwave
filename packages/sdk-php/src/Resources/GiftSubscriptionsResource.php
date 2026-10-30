<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Read-only access to the identity-minimized historical Gift archive.
 *
 * Mirrors packages/sdk-ts/src/resources/gift-subscriptions.ts.
 *
 * @phpstan-type GiftHistoryRecord array{
 *   id: string,
 *   label: string,
 *   plan_label: string,
 *   duration_months: int,
 *   status: 'pending'|'paid'|'redeemed'|'cancelled'|'expired'|'refunded'|'unclassified',
 *   created_at: string,
 *   redeemed_at: string|null,
 *   expires_at: string|null,
 *   canceled_at: string|null,
 *   message_recorded: bool,
 *   provider_invoice_linked: bool,
 *   gifter_member_linked: bool,
 *   recipient_member_linked: bool
 * }
 * @phpstan-type GiftHistoryPage array{
 *   items: list<GiftHistoryRecord>,
 *   total: int,
 *   limit: int,
 *   offset: int,
 *   snapshot_at: string
 * }
 * @phpstan-type GiftHistoryStats array{
 *   total: int,
 *   pending: int,
 *   paid: int,
 *   granted: int,
 *   canceled: int,
 *   expired: int,
 *   refunded: int,
 *   conversionRate: float,
 *   generated_at: string
 * }
 */
final class GiftSubscriptionsResource extends Resource
{
    private const SEARCH_PATTERN = '/\A[0-9A-Fa-f]{8,32}\z/D';
    private const ID_PATTERN = '/\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\z/D';
    private const FILTERS = [
        'all', 'open', 'pending', 'redeemed', 'closed', 'cancelled', 'expired', 'refunded',
    ];
    private const SORTS = ['newest', 'oldest', 'duration', 'status'];

    /**
     * `q` may be a copied `Gift record XXXXXXXX` label or hyphenated UUID
     * prefix; the transport receives only compact lowercase hexadecimal.
     *
     * @param array{
     *   limit?: int<1, 100>,
     *   offset?: int<0, 10000>,
     *   q?: non-empty-string,
     *   filter?: 'all'|'open'|'pending'|'redeemed'|'closed'|'cancelled'|'expired'|'refunded',
     *   sort?: 'newest'|'oldest'|'duration'|'status'
     * } $params
     * @return GiftHistoryPage
     */
    public function list(array $params = []): array
    {
        $query = self::normalizeListQuery($params);

        $out = $this->client->request('GET', '/api/v1/gift-subscriptions', null, $query);
        return self::requireArrayEnvelope($out, 'list');
    }

    /**
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    private static function normalizeListQuery(array $params): array
    {
        $query = array_intersect_key(
            $params,
            array_fill_keys(['limit', 'offset', 'q', 'filter', 'sort'], true)
        );

        foreach ([['limit', 1, 100], ['offset', 0, 10000]] as [$name, $minimum, $maximum]) {
            if (!array_key_exists($name, $query)) {
                continue;
            }
            $value = $query[$name];
            if (!is_int($value) || $value < $minimum || $value > $maximum) {
                throw new \InvalidArgumentException(
                    "Gift history $name must be an integer between $minimum and $maximum"
                );
            }
        }

        if (array_key_exists('q', $query)) {
            if (!is_string($query['q'])) {
                throw new \InvalidArgumentException('Gift history q must be a string');
            }
            $trimmed = trim($query['q']);
            if ($trimmed === '') {
                unset($query['q']);
            } else {
                $withoutLabel = preg_replace('/\Agift record\s+/i', '', $trimmed, 1);
                $compact = strtolower(str_replace('-', '', $withoutLabel ?? ''));
                if (preg_match(self::SEARCH_PATTERN, $compact) !== 1) {
                    throw new \InvalidArgumentException(
                        'Gift history q must be an 8-32 character hexadecimal record prefix'
                    );
                }
                $query['q'] = $compact;
            }
        }
        foreach ([['filter', self::FILTERS], ['sort', self::SORTS]] as [$name, $allowed]) {
            if (!array_key_exists($name, $query)) {
                continue;
            }
            if (!is_string($query[$name]) || !in_array($query[$name], $allowed, true)) {
                throw new \InvalidArgumentException("Unsupported Gift history $name");
            }
        }
        if (($query['filter'] ?? null) === 'all') {
            unset($query['filter']);
        }
        if (($query['sort'] ?? null) === 'newest') {
            unset($query['sort']);
        }

        return $query;
    }

    /** @return GiftHistoryStats */
    public function stats(): array
    {
        $out = $this->client->request('GET', '/api/v1/gift-subscriptions/stats');
        return self::requireArrayEnvelope($out, 'stats');
    }

    /** @return GiftHistoryRecord */
    public function get(string $id): array
    {
        $giftId = self::canonicalGiftId($id);
        $out = $this->client->request(
            'GET',
            '/api/v1/gift-subscriptions/' . rawurlencode($giftId)
        );
        return self::requireArrayEnvelope($out, 'detail');
    }

    private static function canonicalGiftId(string $id): string
    {
        if (preg_match(self::ID_PATTERN, $id) !== 1) {
            throw new \InvalidArgumentException('Gift history id must be a canonical UUID');
        }
        return strtolower($id);
    }

    /** @return array<string, mixed> */
    private static function requireArrayEnvelope(mixed $value, string $operation): array
    {
        if (!is_array($value)) {
            throw new \UnexpectedValueException(
                "Moosewave Gift history $operation response must be a JSON object"
            );
        }
        return $value;
    }
}
