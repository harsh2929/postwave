<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class AudienceDestinationsResource extends Resource
{
    /** @return array<string, mixed> */
    public function providers(): array
    {
        $out = $this->client->request('GET', '/api/v1/audience-destinations/providers');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function list(?string $provider = null): array
    {
        $query = $provider === null ? [] : ['provider' => $provider];
        $out = $this->client->request('GET', '/api/v1/audience-destinations', null, $query);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id')
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{provider: string, list_id?: string|null, segment_id?: string|null, external_audience_id?: string, config?: array<string, mixed>} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/audience-destinations', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{status?: string, external_audience_id?: string, config?: array<string, mixed>} $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id'),
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function readiness(string $provider, array $config = []): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($provider, 'audience destination provider') . '/readiness',
            ['config' => $config]
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function preview(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id') . '/preview'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function sync(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id') . '/sync',
            []
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function jobs(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id') . '/jobs'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function disconnect(string $id): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/audience-destinations/' . IntegrationsResource::pathSegment($id, 'audience destination id')
        );
        return is_array($out) ? $out : [];
    }
}
