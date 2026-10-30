<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class ListsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/lists');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/lists', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array{items: array<int, array{id: string, name: string}>, count: int} */
    public function forSubscriber(string $subscriberId): array
    {
        $id = trim($subscriberId);
        if ($id === '') {
            throw new \InvalidArgumentException('Subscriber ID is required');
        }
        $out = $this->client->request(
            'GET',
            '/api/v1/lists/for-subscriber/' . rawurlencode($id)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch): array
    {
        $out = $this->client->request('PATCH', '/api/v1/lists/' . rawurlencode($id), $patch);
        return is_array($out) ? $out : [];
    }

    public function delete(string $id): void
    {
        $this->client->request('DELETE', '/api/v1/lists/' . rawurlencode($id));
    }
}
