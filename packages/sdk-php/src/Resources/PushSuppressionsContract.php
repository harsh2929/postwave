<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\PostwaveError;

/** @internal Strict Route43 request validation and minimized response decoding. */
final class PushSuppressionsContract
{
    /** @var list<string> */
    public const PLATFORMS = ['apns', 'fcm', 'web'];
    /** @var list<string> */
    public const REASONS = ['manual', 'unregistered', 'expired', 'complaint', 'user_opt_out'];
    /** @var list<string> */
    public const SOURCES = ['dashboard', 'provider', 'user', 'complaint', 'legacy'];
    /** @var list<string> */
    public const LOCKED_REASONS = [
        'provider_authority',
        'user_opt_out_authority',
        'complaint_authority',
        'legacy_authority_requires_review',
    ];

    private const UUID_V4 = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D';
    private const TENANT_UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D';
    private const FINGERPRINT = '/^[0-9a-f]{16}$/D';
    private const HASH_PREFIX = '/^[0-9a-f]{8,16}$/D';
    private const CURSOR = '/^[A-Za-z0-9_-]+$/D';
    private const UTC_TIMESTAMP = '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/D';

    public static function expectedTenant(mixed $value): string
    {
        if (!is_string($value) || preg_match(self::TENANT_UUID, $value) !== 1) {
            throw new \InvalidArgumentException(
                'Push suppression operations require an expected canonical tenant UUID'
            );
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $options
     * @return array{limit: int, platform?: string, reason?: string, hash_prefix?: string, cursor?: string}
     */
    public static function listOptions(array $options): array
    {
        $allowed = ['platform', 'reason', 'hash_prefix', 'cursor', 'limit'];
        if (array_is_list($options) && $options !== []) {
            throw new \InvalidArgumentException('Push suppression list options must be an object');
        }
        if (array_diff(array_keys($options), $allowed) !== []) {
            throw new \InvalidArgumentException('Push suppression list options contain an unsupported field');
        }

        $platform = $options['platform'] ?? null;
        if ($platform !== null && (!is_string($platform) || !in_array($platform, self::PLATFORMS, true))) {
            throw new \InvalidArgumentException('Push suppression platform is unsupported');
        }
        $reason = $options['reason'] ?? null;
        if ($reason !== null && (!is_string($reason) || !in_array($reason, self::REASONS, true))) {
            throw new \InvalidArgumentException('Push suppression reason is unsupported');
        }
        $hashPrefix = $options['hash_prefix'] ?? null;
        if ($hashPrefix !== null && (!is_string($hashPrefix) || preg_match(self::HASH_PREFIX, $hashPrefix) !== 1)) {
            throw new \InvalidArgumentException(
                'Push suppression hash_prefix must be 8–16 lowercase hexadecimal characters'
            );
        }
        $cursor = $options['cursor'] ?? null;
        if ($cursor !== null && !self::validCursor($cursor)) {
            throw new \InvalidArgumentException('Push suppression cursor is invalid');
        }
        $limit = $options['limit'] ?? 50;
        if (!is_int($limit) || $limit < 1 || $limit > 100) {
            throw new \InvalidArgumentException('Push suppression limit must be an integer from 1 to 100');
        }

        return [
            'limit' => $limit,
            ...($platform !== null ? ['platform' => $platform] : []),
            ...($reason !== null ? ['reason' => $reason] : []),
            ...($hashPrefix !== null ? ['hash_prefix' => $hashPrefix] : []),
            ...($cursor !== null ? ['cursor' => $cursor] : []),
        ];
    }

    /**
     * @param array<string, mixed> $input
     * @return array{device_token: string, platform: string, reason: 'manual'}
     */
    public static function addInput(array $input): array
    {
        self::exactInputKeys($input, ['device_token', 'platform', 'reason'], 'add');
        $token = self::rawToken($input['device_token'] ?? null);
        $platform = $input['platform'] ?? null;
        if (
            !is_string($platform) || !in_array($platform, self::PLATFORMS, true) ||
            ($input['reason'] ?? null) !== 'manual'
        ) {
            throw new \InvalidArgumentException(
                'Push suppression add requires a supported platform and reason=manual'
            );
        }

        return ['device_token' => $token, 'platform' => $platform, 'reason' => 'manual'];
    }

    /**
     * @param array<string, mixed> $input
     * @return array{id: string, expected_version: int}
     */
    public static function removeInput(array $input): array
    {
        self::exactInputKeys($input, ['id', 'expected_version'], 'removal');
        $id = $input['id'] ?? null;
        $version = $input['expected_version'] ?? null;
        if (
            !is_string($id) || preg_match(self::UUID_V4, $id) !== 1 ||
            !is_int($version) || $version < 1
        ) {
            throw new \InvalidArgumentException(
                'Push suppression removal requires a canonical lowercase UUIDv4 id and positive expected_version'
            );
        }

        return ['id' => $id, 'expected_version' => $version];
    }

    /**
     * @param array<int, array<string, mixed>> $inputs
     * @return list<array{device_token: string, platform: string, reason: 'manual'}>
     */
    public static function bulkImportInputs(array $inputs): array
    {
        self::boundedList($inputs, 'Push suppression bulk import');
        $result = [];
        $seen = [];
        foreach ($inputs as $input) {
            if (!is_array($input)) {
                throw new \InvalidArgumentException('Every push suppression bulk import entry must be an object');
            }
            $item = self::addInput($input);
            $key = $item['platform'] . "\0" . $item['device_token'];
            if (isset($seen[$key])) {
                throw new \InvalidArgumentException(
                    'Push suppression bulk import cannot repeat a platform and token'
                );
            }
            $seen[$key] = true;
            $result[] = $item;
        }

        return $result;
    }

    /**
     * @param array<int, array<string, mixed>> $inputs
     * @return list<array{id: string, expected_version: int}>
     */
    public static function bulkRemoveInputs(array $inputs): array
    {
        self::boundedList($inputs, 'Push suppression bulk removal');
        $result = [];
        $ids = [];
        foreach ($inputs as $input) {
            if (!is_array($input)) {
                throw new \InvalidArgumentException('Every push suppression bulk removal entry must be an object');
            }
            $item = self::removeInput($input);
            if (isset($ids[$item['id']])) {
                throw new \InvalidArgumentException('Push suppression bulk removal cannot repeat ids');
            }
            $ids[$item['id']] = true;
            $result[] = $item;
        }

        return $result;
    }

    /** @return array<string, mixed> */
    public static function decodeRow(mixed $value, string $expectedTenant): array
    {
        self::decodeTenant($expectedTenant);
        $row = self::exactObject(
            $value,
            [
                'id',
                'tenant_id',
                'device_token_hash',
                'platform',
                'reason',
                'source',
                'created_at',
                'updated_at',
                'version',
                'reversible',
            ],
            ['locked_reason']
        );
        $id = $row['id'];
        $fingerprint = $row['device_token_hash'];
        $platform = $row['platform'];
        $reason = $row['reason'];
        $source = $row['source'];
        $version = $row['version'];
        $reversible = $row['reversible'];
        $createdAt = self::timestamp($row['created_at']);
        $updatedAt = self::timestamp($row['updated_at']);
        if (
            !is_string($id) || preg_match(self::UUID_V4, $id) !== 1 ||
            $row['tenant_id'] !== $expectedTenant ||
            !is_string($fingerprint) || preg_match(self::FINGERPRINT, $fingerprint) !== 1 ||
            !is_string($platform) || !in_array($platform, self::PLATFORMS, true) ||
            !is_string($reason) || !in_array($reason, self::REASONS, true) ||
            !is_string($source) || !in_array($source, self::SOURCES, true) ||
            !is_int($version) || $version < 1 || !is_bool($reversible) ||
            strcmp(self::timestampKey($updatedAt), self::timestampKey($createdAt)) < 0
        ) {
            throw self::contractError();
        }

        $manualDashboard = $reason === 'manual' && $source === 'dashboard';
        $hasLock = array_key_exists('locked_reason', $row);
        $lockedReason = $hasLock ? $row['locked_reason'] : null;
        if (
            $reversible !== $manualDashboard ||
            ($manualDashboard && $hasLock) ||
            (!$manualDashboard && (!is_string($lockedReason) || !in_array($lockedReason, self::LOCKED_REASONS, true)))
        ) {
            throw self::contractError();
        }

        return [
            'id' => $id,
            'tenant_id' => $expectedTenant,
            'device_token_hash' => $fingerprint,
            'platform' => $platform,
            'reason' => $reason,
            'source' => $source,
            'created_at' => $createdAt,
            'updated_at' => $updatedAt,
            'version' => $version,
            'reversible' => $reversible,
            ...($hasLock ? ['locked_reason' => $lockedReason] : []),
        ];
    }

    /**
     * @param array<string, mixed> $criteria Normalized list options.
     * @return array<string, mixed>
     */
    public static function decodePage(mixed $value, string $expectedTenant, array $criteria): array
    {
        self::decodeTenant($expectedTenant);
        $limit = $criteria['limit'] ?? null;
        if (!is_int($limit) || $limit < 1 || $limit > 100) {
            throw self::contractError();
        }
        $page = self::exactObject(
            $value,
            ['tenantId', 'items', 'total', 'snapshotAt'],
            ['nextCursor']
        );
        $itemsValue = $page['items'];
        $total = $page['total'];
        if (
            $page['tenantId'] !== $expectedTenant || !is_array($itemsValue) || !array_is_list($itemsValue) ||
            count($itemsValue) > $limit || !is_int($total) || $total < count($itemsValue)
        ) {
            throw self::contractError();
        }
        $snapshotAt = self::timestamp($page['snapshotAt']);
        $hasNext = array_key_exists('nextCursor', $page);
        $nextCursor = $hasNext ? $page['nextCursor'] : null;
        if ($hasNext && !self::validCursor($nextCursor)) {
            throw self::contractError();
        }

        $items = [];
        $ids = [];
        $priorTimestamp = null;
        $priorId = null;
        foreach ($itemsValue as $candidate) {
            $item = self::decodeRow($candidate, $expectedTenant);
            $createdKey = self::timestampKey($item['created_at']);
            if (
                isset($ids[$item['id']]) ||
                (isset($criteria['platform']) && $item['platform'] !== $criteria['platform']) ||
                (isset($criteria['reason']) && $item['reason'] !== $criteria['reason']) ||
                (isset($criteria['hash_prefix']) &&
                    !str_starts_with($item['device_token_hash'], $criteria['hash_prefix'])) ||
                ($priorTimestamp !== null && (
                    strcmp($createdKey, $priorTimestamp) > 0 ||
                    ($createdKey === $priorTimestamp && $priorId !== null && strcmp($item['id'], $priorId) >= 0)
                ))
            ) {
                throw self::contractError();
            }
            $ids[$item['id']] = true;
            $priorTimestamp = $createdKey;
            $priorId = $item['id'];
            $items[] = $item;
        }

        if ($hasNext && (count($items) !== $limit || $total <= count($items))) {
            throw self::contractError();
        }
        if (!array_key_exists('cursor', $criteria) && !$hasNext && $total !== count($items)) {
            throw self::contractError();
        }

        return [
            'tenantId' => $expectedTenant,
            'items' => $items,
            'total' => $total,
            'snapshotAt' => $snapshotAt,
            ...($hasNext ? ['nextCursor' => $nextCursor] : []),
        ];
    }

    /**
     * @param array{id: string, expected_version: int} $expected
     * @return array{ok: true, tenantId: string, id: string, version: int, stillSuppressed: bool}
     */
    public static function decodeDelete(mixed $value, string $expectedTenant, array $expected): array
    {
        self::decodeTenant($expectedTenant);
        $receipt = self::exactObject(
            $value,
            ['ok', 'tenantId', 'id', 'version', 'stillSuppressed']
        );
        if (
            $receipt['ok'] !== true || $receipt['tenantId'] !== $expectedTenant ||
            $receipt['id'] !== $expected['id'] ||
            $receipt['version'] !== $expected['expected_version'] + 1 ||
            !is_bool($receipt['stillSuppressed'])
        ) {
            throw self::contractError();
        }

        return [
            'ok' => true,
            'tenantId' => $expectedTenant,
            'id' => $expected['id'],
            'version' => $receipt['version'],
            'stillSuppressed' => $receipt['stillSuppressed'],
        ];
    }

    /**
     * @param list<array{device_token: string, platform: string, reason: 'manual'}> $inputs
     * @return array<string, mixed>
     */
    public static function decodeBulkImport(mixed $value, string $expectedTenant, array $inputs): array
    {
        self::decodeTenant($expectedTenant);
        $receipt = self::exactObject(
            $value,
            ['ok', 'tenantId', 'created', 'existing', 'items']
        );
        $created = $receipt['created'];
        $existing = $receipt['existing'];
        $itemsValue = $receipt['items'];
        if (
            $receipt['ok'] !== true || $receipt['tenantId'] !== $expectedTenant ||
            !is_int($created) || $created < 0 || !is_int($existing) || $existing < 0 ||
            $created + $existing !== count($inputs) ||
            !is_array($itemsValue) || !array_is_list($itemsValue) || count($itemsValue) !== count($inputs)
        ) {
            throw self::contractError();
        }

        $rows = [];
        $ids = [];
        foreach ($itemsValue as $index => $candidate) {
            $row = self::decodeRow($candidate, $expectedTenant);
            $input = $inputs[$index] ?? null;
            if (
                isset($ids[$row['id']]) || !is_array($input) ||
                $row['platform'] !== $input['platform'] || $row['reason'] !== 'manual' ||
                $row['source'] !== 'dashboard' || $row['reversible'] !== true
            ) {
                throw self::contractError();
            }
            $ids[$row['id']] = true;
            $rows[] = $row;
        }

        return [
            'ok' => true,
            'tenantId' => $expectedTenant,
            'created' => $created,
            'existing' => $existing,
            'items' => $rows,
        ];
    }

    /**
     * @param list<array{id: string, expected_version: int}> $inputs
     * @return array<string, mixed>
     */
    public static function decodeBulkRemove(mixed $value, string $expectedTenant, array $inputs): array
    {
        self::decodeTenant($expectedTenant);
        $receipt = self::exactObject(
            $value,
            ['ok', 'tenantId', 'removed', 'stillSuppressed', 'items']
        );
        $removed = $receipt['removed'];
        $stillSuppressed = $receipt['stillSuppressed'];
        $itemsValue = $receipt['items'];
        if (
            $receipt['ok'] !== true || $receipt['tenantId'] !== $expectedTenant ||
            $removed !== count($inputs) || !is_int($stillSuppressed) ||
            $stillSuppressed < 0 || $stillSuppressed > count($inputs) ||
            !is_array($itemsValue) || !array_is_list($itemsValue) || count($itemsValue) !== count($inputs)
        ) {
            throw self::contractError();
        }

        $decoded = [];
        $countStillSuppressed = 0;
        foreach ($itemsValue as $index => $candidate) {
            $expected = $inputs[$index] ?? null;
            if (!is_array($expected)) {
                throw self::contractError();
            }
            $item = self::decodeDelete($candidate, $expectedTenant, $expected);
            if ($item['stillSuppressed']) {
                $countStillSuppressed++;
            }
            $decoded[] = $item;
        }
        if ($countStillSuppressed !== $stillSuppressed) {
            throw self::contractError();
        }

        return [
            'ok' => true,
            'tenantId' => $expectedTenant,
            'removed' => $removed,
            'stillSuppressed' => $stillSuppressed,
            'items' => $decoded,
        ];
    }

    private static function contractError(): PostwaveError
    {
        return new PostwaveError(
            'Invalid push suppression response.',
            502,
            'invalid_push_suppression_response'
        );
    }

    private static function decodeTenant(string $value): void
    {
        if (preg_match(self::TENANT_UUID, $value) !== 1) {
            throw self::contractError();
        }
    }

    /** @param list<string> $required @param list<string> $optional @return array<string, mixed> */
    private static function exactObject(mixed $value, array $required, array $optional = []): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw self::contractError();
        }
        $keys = array_keys($value);
        if (array_diff($required, $keys) !== [] || array_diff($keys, [...$required, ...$optional]) !== []) {
            throw self::contractError();
        }

        return $value;
    }

    /** @param array<string, mixed> $input @param list<string> $required */
    private static function exactInputKeys(array $input, array $required, string $operation): void
    {
        if (
            array_is_list($input) || array_diff($required, array_keys($input)) !== [] ||
            array_diff(array_keys($input), $required) !== []
        ) {
            throw new \InvalidArgumentException("Push suppression $operation must contain only its required fields");
        }
    }

    /** @param array<int, mixed> $items */
    private static function boundedList(array $items, string $label): void
    {
        if (!array_is_list($items) || count($items) < 1 || count($items) > 100) {
            throw new \InvalidArgumentException("$label requires 1–100 entries");
        }
    }

    private static function rawToken(mixed $value): string
    {
        if (
            !is_string($value) || preg_match('//u', $value) !== 1 ||
            strlen($value) < 20 || strlen($value) > 4096 || trim($value) !== $value ||
            preg_match('/[\s\p{Cc}]/u', $value) === 1
        ) {
            throw new \InvalidArgumentException(
                'device_token must be exact 20–4096 UTF-8 bytes without whitespace or controls'
            );
        }

        return $value;
    }

    private static function validCursor(mixed $value): bool
    {
        return is_string($value) && strlen($value) >= 1 && strlen($value) <= 2048 &&
            preg_match(self::CURSOR, $value) === 1;
    }

    private static function timestamp(mixed $value): string
    {
        if (
            !is_string($value) || strlen($value) > 64 ||
            preg_match(self::UTC_TIMESTAMP, $value, $parts) !== 1 ||
            (int) $parts[1] < 2000 || (int) $parts[1] >= 2100 ||
            !checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1]) ||
            (int) $parts[4] > 23 || (int) $parts[5] > 59 || (int) $parts[6] > 59
        ) {
            throw self::contractError();
        }

        return $value;
    }

    private static function timestampKey(string $value): string
    {
        if (preg_match(self::UTC_TIMESTAMP, $value, $parts) !== 1) {
            throw self::contractError();
        }
        $fraction = str_pad($parts[7] ?? '', 9, '0');

        return sprintf(
            '%04d%02d%02d%02d%02d%02d%s',
            (int) $parts[1],
            (int) $parts[2],
            (int) $parts[3],
            (int) $parts[4],
            (int) $parts[5],
            (int) $parts[6],
            $fraction
        );
    }
}
