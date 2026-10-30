<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * TopicsResource — topic management + per-subscriber subscribe/unsubscribe.
 * Mirrors packages/sdk-ts/src/resources/topics.ts.
 */
final class TopicsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/topics');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{slug: string, name: string, description?: string, default_opt_in?: bool, display_order?: int} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/topics', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/topics/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function subscribe(string $subscriberEmail, string $topicId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/subscribers/' . rawurlencode($subscriberEmail)
                . '/topics/' . rawurlencode($topicId) . '/subscribe'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function unsubscribe(string $subscriberEmail, string $topicId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/subscribers/' . rawurlencode($subscriberEmail)
                . '/topics/' . rawurlencode($topicId) . '/unsubscribe'
        );
        return is_array($out) ? $out : [];
    }
}
