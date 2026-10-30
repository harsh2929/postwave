<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\AgencyReleaseHeldError;
use Moosewave\Errors\ParseError;

/**
 * Admin-only Agency surface. Only the bounded roster and current tenant's
 * stored audit-portal branding record perform transport in this release.
 */
final class AgencyResource extends Resource
{
    public const CHILD_CREATE_RELEASE_HELD_CODE = 'agency_child_create_release_hold';
    public const CHILD_UNLINK_RELEASE_HELD_CODE = 'agency_child_unlink_release_hold';
    public const BRANDING_UPDATE_RELEASE_HELD_CODE = 'agency_branding_update_release_hold';
    public const BILLING_MODE_RELEASE_HELD_CODE = 'agency_billing_mode_release_hold';
    public const INVOICE_PREVIEW_RELEASE_HELD_CODE = 'agency_invoice_preview_release_hold';

    /**
     * `count` is this page's row count, not a portfolio total.
     *
     * @return array{children: list<array<string, mixed>>, count: int, has_more: bool, next_cursor?: string}
     */
    public function listChildren(?int $limit = null, ?string $cursor = null): array
    {
        $query = [];
        if ($limit !== null) {
            if ($limit < 1 || $limit > 200) {
                throw new \InvalidArgumentException(
                    'Agency roster limit must be an integer from 1 through 200'
                );
            }
            $query['limit'] = $limit;
        }
        if ($cursor !== null) {
            if (preg_match('/^[A-Za-z0-9_-]{1,512}$/D', $cursor) !== 1) {
                throw new \InvalidArgumentException(
                    'Agency roster cursor must be an opaque base64url value of at most 512 characters'
                );
            }
            $query['cursor'] = $cursor;
        }

        $page = self::decodeChildrenPage(
            $this->client->request('GET', '/api/v1/agency/children', null, $query)
        );
        if (count($page['children']) > ($limit ?? 100)) {
            throw new ParseError('Agency child roster exceeded the requested page bound.', 200);
        }
        return $page;
    }

    /** @param array<string, mixed> $input */
    public function createChild(array $input): never
    {
        unset($input);
        throw self::held(
            self::CHILD_CREATE_RELEASE_HELD_CODE,
            'Agency child creation is release-held until ownership, invitation, regional bootstrap, and billing provisioning commit atomically; no tenant was created.'
        );
    }

    public function unlinkChild(string $id): never
    {
        unset($id);
        throw self::held(
            self::CHILD_UNLINK_RELEASE_HELD_CODE,
            'Agency child unlink is release-held until independent ownership and active payer authority can be proven atomically; no relationship changed.'
        );
    }

    /**
     * Returns the safe projection. Legacy updated_at values begin at the
     * security-migration baseline rather than unknown historical authorship.
     *
     * @return array<string, mixed>
     */
    public function getBranding(): array
    {
        return self::decodeBranding(
            $this->client->request('GET', '/api/v1/agency/branding')
        );
    }

    /** @param array<string, mixed> $patch */
    public function updateBranding(array $patch): never
    {
        unset($patch);
        throw self::held(
            self::BRANDING_UPDATE_RELEASE_HELD_CODE,
            'Agency branding updates are release-held until publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding changed.'
        );
    }

    /** @param array{target_tenant_id: string, mode: string, reason: string} $input */
    public function setBillingMode(array $input): never
    {
        unset($input);
        throw self::held(
            self::BILLING_MODE_RELEASE_HELD_CODE,
            'Agency billing-mode changes are release-held until payer authority and consolidated invoicing are durable; no billing state changed.'
        );
    }

    public function invoicePreview(int $days = 30): never
    {
        unset($days);
        throw self::held(
            self::INVOICE_PREVIEW_RELEASE_HELD_CODE,
            'Agency invoice preview is release-held until a fixed rated ledger, temporal cutoff, payer authority, and consolidated invoice processor exist; no estimate was generated.'
        );
    }

    private static function held(string $code, string $message): AgencyReleaseHeldError
    {
        return new AgencyReleaseHeldError($message, $code);
    }

    /**
     * @param mixed $payload
     * @return array{children: list<array<string, mixed>>, count: int, has_more: bool, next_cursor?: string}
     */
    private static function decodeChildrenPage(mixed $payload): array
    {
        $allowed = ['children', 'count', 'has_more', 'next_cursor'];
        $valid = is_array($payload)
            && self::onlyKeys($payload, $allowed)
            && isset($payload['children'], $payload['count'], $payload['has_more'])
            && is_array($payload['children'])
            && array_is_list($payload['children'])
            && count($payload['children']) <= 200
            && is_int($payload['count'])
            && $payload['count'] === count($payload['children'])
            && is_bool($payload['has_more']);

        if ($valid) {
            foreach ($payload['children'] as $child) {
                if (!self::validChild($child)) {
                    $valid = false;
                    break;
                }
            }
        }
        if ($valid && $payload['has_more']) {
            $valid = isset($payload['next_cursor'])
                && is_string($payload['next_cursor'])
                && preg_match('/^[A-Za-z0-9_-]{1,512}$/D', $payload['next_cursor']) === 1;
        } elseif ($valid) {
            $valid = !array_key_exists('next_cursor', $payload);
        }
        if (!$valid) {
            throw new ParseError('Agency child roster returned an invalid bounded response.', 200);
        }
        /** @var array{children: list<array<string, mixed>>, count: int, has_more: bool, next_cursor?: string} $payload */
        return $payload;
    }

    private static function validChild(mixed $child): bool
    {
        $keys = [
            'id',
            'slug',
            'name',
            'tier',
            'parent_tenant_id',
            'billing_mode',
            'reseller_markup_bps',
            'whitelabel_enabled',
            'created_at',
            'updated_at',
        ];
        return is_array($child)
            && self::exactKeys($child, $keys)
            && self::canonicalUuid($child['id'])
            && is_string($child['slug'])
            && preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $child['slug']) === 1
            && self::boundedString($child['name'], 1, 120)
            && in_array($child['tier'], ['studio', 'sending', 'pro'], true)
            && self::canonicalUuid($child['parent_tenant_id'])
            && in_array($child['billing_mode'], ['self', 'parent'], true)
            && is_int($child['reseller_markup_bps'])
            && $child['reseller_markup_bps'] >= 0
            && $child['reseller_markup_bps'] <= 100000
            && is_bool($child['whitelabel_enabled'])
            && self::timestamp($child['created_at'])
            && self::timestamp($child['updated_at']);
    }

    /** @param mixed $payload @return array<string, mixed> */
    private static function decodeBranding(mixed $payload): array
    {
        $keys = [
            'whitelabel_enabled',
            'brand_name',
            'custom_domain',
            'logo_url',
            'primary_color',
            'support_email',
            'legal_entity',
            'updated_at',
            'etag',
        ];
        $valid = is_array($payload)
            && self::exactKeys($payload, $keys)
            && is_bool($payload['whitelabel_enabled'])
            && self::boundedString($payload['brand_name'], 0, 120)
            && self::boundedString($payload['custom_domain'], 0, 253)
            && self::publicHostname($payload['custom_domain'], true)
            && self::boundedString($payload['logo_url'], 0, 2048)
            && self::safeLogoUrl($payload['logo_url'])
            && self::boundedString($payload['primary_color'], 0, 7)
            && preg_match('/^(?:|#[0-9A-Fa-f]{6})$/D', $payload['primary_color']) === 1
            && self::boundedString($payload['support_email'], 0, 254)
            && self::boundedString($payload['legal_entity'], 0, 200)
            && self::timestamp($payload['updated_at'])
            && is_string($payload['etag'])
            && preg_match(
                '/^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:v(?:0|[1-9][0-9]*)"$/D',
                $payload['etag']
            ) === 1;
        if (!$valid) {
            throw new ParseError('Agency branding returned an invalid bounded response.', 200);
        }
        /** @var array<string, mixed> $payload */
        return $payload;
    }

    /** @param array<mixed> $value @param list<string> $keys */
    private static function exactKeys(array $value, array $keys): bool
    {
        $actual = array_keys($value);
        sort($actual);
        sort($keys);
        return $actual === $keys;
    }

    /** @param array<mixed> $value @param list<string> $keys */
    private static function onlyKeys(array $value, array $keys): bool
    {
        return array_diff(array_keys($value), $keys) === [];
    }

    private static function canonicalUuid(mixed $value): bool
    {
        return is_string($value)
            && preg_match(
                '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D',
                $value
            ) === 1;
    }

    private static function boundedString(mixed $value, int $minimum, int $maximum): bool
    {
        if (!is_string($value)) {
            return false;
        }
        $codePoints = preg_match_all('/./us', $value);
        return $codePoints !== false
            && preg_match('/^\s|\s$/u', $value) === 0
            && preg_match(
                '/[\x{0000}-\x{001F}\x{007F}-\x{009F}\x{061C}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{206F}\x{FEFF}]/u',
                $value
            ) === 0
            && $codePoints >= $minimum
            && $codePoints <= $maximum;
    }

    private static function timestamp(mixed $value): bool
    {
        if (
            !is_string($value)
            || preg_match(
                '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/D',
                $value
            ) !== 1
        ) {
            return false;
        }
        try {
            new \DateTimeImmutable($value);
            $errors = \DateTimeImmutable::getLastErrors();
            return $errors === false
                || ($errors['warning_count'] === 0 && $errors['error_count'] === 0);
        } catch (\Exception) {
            return false;
        }
    }

    private static function publicHostname(mixed $value, bool $allowEmpty = false): bool
    {
        if ($value === '') {
            return $allowEmpty;
        }
        if (
            !is_string($value)
            || strlen($value) > 253
            || strtolower($value) !== $value
            || preg_match('/[\s\/\\\\:@%*?#\[\]]/u', $value) === 1
        ) {
            return false;
        }
        $labels = explode('.', $value);
        if (count($labels) < 2) {
            return false;
        }
        foreach ($labels as $label) {
            if (preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $label) !== 1) {
                return false;
            }
        }
        if (count($labels) <= 4) {
            $allNumeric = true;
            foreach ($labels as $label) {
                if (preg_match('/^(?:0x[0-9a-f]+|[0-9]+)$/D', $label) !== 1) {
                    $allNumeric = false;
                    break;
                }
            }
            if ($allNumeric) {
                return false;
            }
        }
        foreach (['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'arpa', 'onion', 'test', 'invalid', 'example'] as $suffix) {
            if ($value === $suffix || str_ends_with($value, '.' . $suffix)) {
                return false;
            }
        }
        return true;
    }

    private static function safeLogoUrl(mixed $value): bool
    {
        if ($value === '') {
            return true;
        }
        if (!is_string($value)) {
            return false;
        }
        $parsed = parse_url($value);
        if (
            !is_array($parsed)
            || ($parsed['scheme'] ?? '') !== 'https'
            || isset($parsed['user'])
            || isset($parsed['pass'])
            || isset($parsed['port'])
            || isset($parsed['query'])
            || isset($parsed['fragment'])
            || !self::publicHostname($parsed['host'] ?? null)
        ) {
            return false;
        }
        return preg_match('/\\\\|%00|%0a|%0d|%5c/i', (string) ($parsed['path'] ?? '')) !== 1;
    }
}
