<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/** Strict closed decoders for the private signed-conversion key lifecycle. */
final class ConversionIngestSecretsContract
{
    public const NOTICE = 'This is the only time the secret is shown. Store it now; '
        . 'it cannot be recovered, only replaced.';

    private const KEY_ID = '/^[0-9a-f]{32}$/D';
    private const SECRET = '/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/D';
    private const RFC3339 = '/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T'
        . '(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?'
        . '(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/D';

    /**
     * @return array{
     *   items: list<array<string, mixed>>,
     *   next_cursor?: string
     * }
     */
    public static function decodePage(mixed $value, ?string $requestCursor = null): array
    {
        $page = self::object($value, 'signing-key page');
        self::keys($page, ['items', 'next_cursor'], ['items'], 'signing-key page');
        if (!is_array($page['items']) || !array_is_list($page['items']) || count($page['items']) > 100) {
            throw new \UnexpectedValueException('Signing-key page items are not a bounded list.');
        }
        $items = [];
        $ids = [];
        foreach ($page['items'] as $item) {
            $decoded = self::decodeMetadata($item, false);
            if (isset($ids[$decoded['key_id']])) {
                throw new \UnexpectedValueException('Signing-key page contains duplicate key IDs.');
            }
            $ids[$decoded['key_id']] = true;
            $items[] = $decoded;
        }
        $out = ['items' => $items];
        if (array_key_exists('next_cursor', $page)) {
            $cursor = self::cursor($page['next_cursor'], 'next_cursor');
            if ($cursor === $requestCursor) {
                throw new \UnexpectedValueException('Signing-key page repeated its request cursor.');
            }
            $out['next_cursor'] = $cursor;
        }
        return $out;
    }

    /**
     * @return array{
     *   secret: array<string, mixed>,
     *   notice: string
     * }
     */
    public static function decodeIssue(mixed $value): array
    {
        $envelope = self::object($value, 'reveal-once signing-key envelope');
        self::keys($envelope, ['secret', 'notice'], ['secret', 'notice'], 'issue envelope');
        if ($envelope['notice'] !== self::NOTICE) {
            throw new \UnexpectedValueException('Reveal-once notice did not match the contract.');
        }
        $issued = self::decodeMetadata($envelope['secret'], true);
        if (
            $issued['identity_projection_status'] !== 'pending'
            || array_key_exists('identity_projection_error_code', $issued)
        ) {
            throw new \UnexpectedValueException('A newly issued key must start pending without an error code.');
        }
        return ['secret' => $issued, 'notice' => self::NOTICE];
    }

    /** @return array{revoked: true} */
    public static function decodeRevoked(mixed $value): array
    {
        $receipt = self::object($value, 'signing-key revocation receipt');
        self::keys($receipt, ['revoked'], ['revoked'], 'revocation receipt');
        if ($receipt['revoked'] !== true) {
            throw new \UnexpectedValueException('Signing-key revocation receipt was not true.');
        }
        return ['revoked' => true];
    }

    public static function label(mixed $value): string
    {
        if (
            !is_string($value)
            || preg_match('//u', $value) !== 1
            || self::unicodeTrim($value) !== $value
            || preg_match('/\p{Cc}/u', $value) === 1
            || self::codePoints($value) > 128
        ) {
            throw new \InvalidArgumentException(
                'Signing-key label must be at most 128 Unicode characters without controls or surrounding whitespace.'
            );
        }
        return $value;
    }

    public static function keyId(mixed $value): string
    {
        if (!is_string($value) || preg_match(self::KEY_ID, $value) !== 1) {
            throw new \InvalidArgumentException(
                'Signing-key ID must be exactly 32 lowercase hexadecimal characters.'
            );
        }
        return $value;
    }

    public static function cursor(mixed $value, string $field = 'cursor'): string
    {
        if (
            !is_string($value)
            || $value === ''
            || strlen($value) > 512
            || preg_match('//u', $value) !== 1
            || self::unicodeTrim($value) !== $value
            || preg_match('/\p{Cc}/u', $value) === 1
        ) {
            throw new \InvalidArgumentException("$field must be a bounded opaque cursor.");
        }
        return $value;
    }

    /** @return array<string, mixed> */
    private static function decodeMetadata(mixed $value, bool $issued): array
    {
        $row = self::object($value, $issued ? 'issued signing key' : 'signing-key metadata');
        $allowed = [
            'key_id',
            'label',
            'created_at',
            'identity_projection_status',
            'identity_projection_error_code',
            'identity_projection_updated_at',
        ];
        if ($issued) {
            $allowed[] = 'secret';
        } else {
            $allowed[] = 'revoked_at';
        }
        self::keys(
            $row,
            $allowed,
            [
                'key_id',
                'label',
                'created_at',
                'identity_projection_status',
                'identity_projection_updated_at',
            ],
            'signing-key object'
        );
        if (preg_match(self::KEY_ID, is_string($row['key_id']) ? $row['key_id'] : '') !== 1) {
            throw new \UnexpectedValueException('Signing-key ID is invalid.');
        }
        try {
            self::label($row['label']);
        } catch (\InvalidArgumentException $error) {
            throw new \UnexpectedValueException($error->getMessage());
        }
        self::timestamp($row['created_at'], 'created_at');
        self::timestamp($row['identity_projection_updated_at'], 'identity_projection_updated_at');
        $status = $row['identity_projection_status'];
        if (!in_array($status, ['pending', 'ready', 'failed'], true)) {
            throw new \UnexpectedValueException('Identity projection status is invalid.');
        }
        $hasError = array_key_exists('identity_projection_error_code', $row);
        if ($status === 'failed') {
            if (
                !$hasError
                || !in_array(
                    $row['identity_projection_error_code'],
                    ['secret_unavailable', 'projection_failed'],
                    true
                )
            ) {
                throw new \UnexpectedValueException('Failed projection requires its bounded error code.');
            }
        } elseif ($hasError) {
            throw new \UnexpectedValueException('Non-failed projection must omit its error code.');
        }
        if (array_key_exists('revoked_at', $row)) {
            self::timestamp($row['revoked_at'], 'revoked_at');
        }
        if ($issued) {
            if (!is_string($row['secret']) || preg_match(self::SECRET, $row['secret']) !== 1) {
                throw new \UnexpectedValueException('Reveal-once signing secret is invalid.');
            }
        }
        return $row;
    }

    /** @return array<string, mixed> */
    private static function object(mixed $value, string $field): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new \UnexpectedValueException("$field must be a JSON object.");
        }
        return $value;
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     * @param list<string> $required
     */
    private static function keys(array $value, array $allowed, array $required, string $field): void
    {
        foreach (array_keys($value) as $key) {
            if (!in_array($key, $allowed, true)) {
                throw new \UnexpectedValueException("$field contains an unknown field.");
            }
        }
        foreach ($required as $key) {
            if (!array_key_exists($key, $value)) {
                throw new \UnexpectedValueException("$field omits $key.");
            }
        }
    }

    private static function timestamp(mixed $value, string $field): string
    {
        if (
            !is_string($value)
            || strlen($value) > 128
            || preg_match(self::RFC3339, $value) !== 1
        ) {
            throw new \UnexpectedValueException("$field is not RFC3339.");
        }
        try {
            new \DateTimeImmutable($value);
            $errors = \DateTimeImmutable::getLastErrors();
        } catch (\Exception) {
            throw new \UnexpectedValueException("$field is not RFC3339.");
        }
        if (is_array($errors) && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) {
            throw new \UnexpectedValueException("$field is not a real RFC3339 instant.");
        }
        return $value;
    }

    private static function codePoints(string $value): int
    {
        $count = preg_match_all('/./us', $value, $matches);
        return $count === false ? PHP_INT_MAX : $count;
    }

    private static function unicodeTrim(string $value): string
    {
        $trimmed = preg_replace('/^\s+|\s+$/u', '', $value);
        return is_string($trimmed) ? $trimmed : "\0";
    }
}
