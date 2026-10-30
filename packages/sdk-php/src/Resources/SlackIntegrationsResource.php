<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SlackIntegrationsResource — Slack incoming-webhook integrations.
 * Mirrors packages/sdk-ts/src/resources/slack-integrations.ts.
 */
final class SlackIntegrationsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/slack');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{url: string, channel_hint?: string, events: array<int, string>} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/integrations/slack', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/integrations/slack/' . rawurlencode($id),
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/integrations/slack/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
