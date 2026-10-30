<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Exact-admin customer-device push suppression authority.
 *
 * Raw tokens are accepted only in mutation bodies. Every returned row is a
 * tenant-bound, minimized 16-character fingerprint projection.
 */
final class PushSuppressionsResource extends Resource
{
    /** @var list<string> */
    public const PLATFORMS = PushSuppressionsContract::PLATFORMS;
    /** @var list<string> */
    public const REASONS = PushSuppressionsContract::REASONS;
    /** @var list<string> */
    public const SOURCES = PushSuppressionsContract::SOURCES;
    /** @var list<string> */
    public const LOCKED_REASONS = PushSuppressionsContract::LOCKED_REASONS;

    /**
     * @param array{platform?: string, reason?: string, hash_prefix?: string, cursor?: string, limit?: int} $options
     * @return array<string, mixed>
     */
    public function list(string $expectedTenantId, array $options = []): array
    {
        $tenantId = PushSuppressionsContract::expectedTenant($expectedTenantId);
        $query = PushSuppressionsContract::listOptions($options);
        $raw = $this->client->request(
            'GET',
            '/api/v1/push/suppressions',
            null,
            $query
        );

        return PushSuppressionsContract::decodePage($raw, $tenantId, $query);
    }

    /**
     * @param array{device_token: string, platform: string, reason: 'manual'} $input
     * @return array<string, mixed>
     */
    public function add(array $input, string $expectedTenantId): array
    {
        $tenantId = PushSuppressionsContract::expectedTenant($expectedTenantId);
        $validated = PushSuppressionsContract::addInput($input);
        $row = PushSuppressionsContract::decodeRow(
            $this->client->request('POST', '/api/v1/push/suppressions', $validated),
            $tenantId
        );
        if (
            $row['platform'] !== $validated['platform'] || $row['reason'] !== 'manual' ||
            $row['source'] !== 'dashboard' || $row['reversible'] !== true
        ) {
            throw new \Moosewave\Errors\PostwaveError(
                'Push suppression creation receipt did not match the requested manual authority.',
                502,
                'invalid_push_suppression_response'
            );
        }

        return $row;
    }

    /**
     * @return array{ok: true, tenantId: string, id: string, version: int, stillSuppressed: bool}
     */
    public function remove(string $id, int $expectedVersion, string $expectedTenantId): array
    {
        $tenantId = PushSuppressionsContract::expectedTenant($expectedTenantId);
        $expected = PushSuppressionsContract::removeInput([
            'id' => $id,
            'expected_version' => $expectedVersion,
        ]);
        $raw = $this->client->request(
            'DELETE',
            '/api/v1/push/suppressions/' . rawurlencode($expected['id']),
            ['expected_version' => $expected['expected_version']]
        );

        return PushSuppressionsContract::decodeDelete($raw, $tenantId, $expected);
    }

    /**
     * Atomically import 1–100 exact manual authorities.
     *
     * @param array<int, array<string, mixed>> $inputs
     * @return array<string, mixed>
     */
    public function bulkImport(array $inputs, string $expectedTenantId): array
    {
        $tenantId = PushSuppressionsContract::expectedTenant($expectedTenantId);
        $validated = PushSuppressionsContract::bulkImportInputs($inputs);
        $raw = $this->client->request(
            'POST',
            '/api/v1/push/suppressions/bulk-import',
            ['items' => $validated]
        );

        return PushSuppressionsContract::decodeBulkImport($raw, $tenantId, $validated);
    }

    /**
     * Atomically remove 1–100 exact reviewed row versions.
     *
     * @param array<int, array<string, mixed>> $inputs
     * @return array<string, mixed>
     */
    public function bulkRemove(array $inputs, string $expectedTenantId): array
    {
        $tenantId = PushSuppressionsContract::expectedTenant($expectedTenantId);
        $validated = PushSuppressionsContract::bulkRemoveInputs($inputs);
        $raw = $this->client->request(
            'POST',
            '/api/v1/push/suppressions/bulk-remove',
            ['items' => $validated]
        );

        return PushSuppressionsContract::decodeBulkRemove($raw, $tenantId, $validated);
    }
}
