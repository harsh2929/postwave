<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class WarehouseNativeIntegrationsResource extends Resource
{
    /** @return array<string, mixed> */
    public function providers(): array
    {
        $out = $this->client->request('GET', '/api/v1/warehouse/providers');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/warehouse/connections');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function create(array $payload): array
    {
        $out = $this->client->request('POST', '/api/v1/warehouse/connections', $payload);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id')
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function health(string $id, bool $providerCheck = false): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/health',
            null,
            $providerCheck ? ['provider_check' => 'true'] : []
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function sync(string $id, array $payload = []): array
    {
        $payload['run_mode'] = $payload['run_mode'] ?? 'manual';
        $out = $this->client->request(
            'POST',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/runs',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function backfill(string $id, array $payload = []): array
    {
        $payload['run_mode'] = $payload['run_mode'] ?? 'backfill';
        $out = $this->client->request(
            'POST',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/runs',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pause(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/pause'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function disconnect(string $id): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id')
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function acknowledgeProviderCleanup(string $id, array $payload): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/provider-cleanup/acknowledge',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function runs(string $id, int $limit = 25): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/warehouse/connections/' . IntegrationsResource::pathSegment($id, 'native warehouse connection id') . '/runs',
            null,
            ['limit' => $limit]
        );
        return is_array($out) ? $out : [];
    }
}
