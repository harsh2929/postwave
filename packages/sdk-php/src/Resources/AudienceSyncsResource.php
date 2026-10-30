<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class AudienceSyncsResource extends Resource
{
    /** @return array<string, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/audience-syncs');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audience-syncs/' . IntegrationsResource::pathSegment($id, 'audience sync id')
        );
        return is_array($out) ? $out : [];
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/audience-syncs', $input);
        return is_array($out) ? $out : [];
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/audience-syncs/' . IntegrationsResource::pathSegment($id, 'audience sync id'),
            $input
        );
        return is_array($out) ? $out : [];
    }

    public function delete(string $id): mixed
    {
        return $this->client->request(
            'DELETE',
            '/api/v1/audience-syncs/' . IntegrationsResource::pathSegment($id, 'audience sync id')
        );
    }

    /** @return array<string, mixed> */
    public function run(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/audience-syncs/' . IntegrationsResource::pathSegment($id, 'audience sync id') . '/run'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function runs(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audience-syncs/' . IntegrationsResource::pathSegment($id, 'audience sync id') . '/runs'
        );
        return is_array($out) ? $out : [];
    }
}
