<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class CommerceNativeIntegrationsResource extends Resource
{
    /** @return array<string, mixed> */
    public function providers(): array
    {
        $out = $this->client->request('GET', '/api/v1/commerce/providers');
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/commerce/integrations');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function create(array $payload): array
    {
        $out = $this->client->request('POST', '/api/v1/commerce/integrations', $payload);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/commerce/integrations/' . IntegrationsResource::pathSegment($id, 'commerce integration id')
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function sync(string $id, array $payload): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/commerce/integrations/' . IntegrationsResource::pathSegment($id, 'commerce integration id') . '/sync',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function backfill(string $id, array $payload): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/commerce/integrations/' . IntegrationsResource::pathSegment($id, 'commerce integration id') . '/backfill',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pause(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/commerce/integrations/' . IntegrationsResource::pathSegment($id, 'commerce integration id') . '/pause'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function disconnect(string $id): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/commerce/integrations/' . IntegrationsResource::pathSegment($id, 'commerce integration id')
        );
        return is_array($out) ? $out : [];
    }
}
