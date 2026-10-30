<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Client;

final class ChatIntegrationChannelResource extends Resource
{
    public function __construct(Client $client, private string $provider)
    {
        parent::__construct($client);
    }

    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', $this->basePath());
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{url: string, events: array<int, string>, channel_hint?: string} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', $this->basePath(), $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{url?: string, events?: array<int, string>, channel_hint?: string, enabled?: bool} $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            $this->basePath() . '/' . IntegrationsResource::pathSegment($id, 'chat integration id'),
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request(
            'DELETE',
            $this->basePath() . '/' . IntegrationsResource::pathSegment($id, 'chat integration id')
        );
        return is_array($out) ? $out : [];
    }

    private function basePath(): string
    {
        return '/api/v1/integrations/' . IntegrationsResource::pathSegment($this->provider, 'chat integration provider');
    }
}
