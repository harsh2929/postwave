<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * PreferencesResource — topic + per-subscriber preference management,
 * including the public token-gated preference page endpoints.
 * Mirrors packages/sdk-ts/src/resources/preferences.ts.
 */
final class PreferencesResource extends Resource
{
    /** @return array<int, mixed> */
    public function listTopics(): array
    {
        $out = $this->client->request('GET', '/api/v1/topics');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createTopic(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/topics', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function updateTopic(string $id, array $patch): array
    {
        $out = $this->client->request('PATCH', '/api/v1/topics/' . rawurlencode($id), $patch);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function deleteTopic(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/topics/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function listSubscriberTopics(string $email): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/subscribers/' . rawurlencode($email) . '/topics'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<int, array{topicId: string, optedIn: bool}> $topics
     * @return array<string, mixed>
     */
    public function setSubscriberTopics(string $email, array $topics): array
    {
        $out = $this->client->request(
            'PUT',
            '/api/v1/subscribers/' . rawurlencode($email) . '/topics',
            ['topics' => $topics]
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Public token-gated lookup used by the hosted preference page.
     *
     * @return array<string, mixed>
     */
    public function publicLookup(string $token): array
    {
        $out = $this->client->request(
            'GET',
            '/api/public/preferences/' . rawurlencode($token)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Public token-gated update used by the hosted preference page.
     *
     * @param array<int, array{topicId: string, optedIn: bool}> $topics
     * @return array<string, mixed>
     */
    public function publicUpdate(string $token, array $topics): array
    {
        $out = $this->client->request(
            'POST',
            '/api/public/preferences/' . rawurlencode($token),
            ['topics' => $topics]
        );
        return is_array($out) ? $out : [];
    }
}
