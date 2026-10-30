<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Client;

final class ChatIntegrationsResource
{
    public ChatIntegrationChannelResource $slack;
    public ChatIntegrationChannelResource $discord;
    public ChatIntegrationChannelResource $teams;

    public function __construct(Client $client)
    {
        $this->slack = new ChatIntegrationChannelResource($client, 'slack');
        $this->discord = new ChatIntegrationChannelResource($client, 'discord');
        $this->teams = new ChatIntegrationChannelResource($client, 'teams');
    }

    public function forProvider(string $provider): ChatIntegrationChannelResource
    {
        return match ($provider) {
            'slack' => $this->slack,
            'discord' => $this->discord,
            'teams' => $this->teams,
            default => throw new \InvalidArgumentException('unsupported chat integration provider'),
        };
    }
}
