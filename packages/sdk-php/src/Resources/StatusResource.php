<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class StatusResource extends Resource
{
    /** @return array<string, mixed> */
    public function public(): array
    {
        $out = $this->client->request('GET', '/api/v1/status/public');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function subscribe(string $channel, string $address): array
    {
        $out = $this->client->request('POST', '/api/status/subscribers', [
            'channel' => $channel,
            'address' => $address,
        ]);
        return is_array($out) ? $out : [];
    }
}
