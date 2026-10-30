<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class APIKeysResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/api-keys');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/api-keys/' . IntegrationsResource::pathSegment($id, 'api key id'));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{label: string, scopes: array<int, string>, expires_at?: string, allowed_ips?: array<int, string>, sandbox_only?: bool} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/api-keys', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function rotate(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/api-keys/' . IntegrationsResource::pathSegment($id, 'api key id') . '/rotate'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function revoke(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/api-keys/' . IntegrationsResource::pathSegment($id, 'api key id'));
        return is_array($out) ? $out : [];
    }

    /** Alias for revoke(). */
    public function delete(string $id): array
    {
        return $this->revoke($id);
    }
}
