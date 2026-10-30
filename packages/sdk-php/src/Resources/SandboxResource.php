<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SandboxResource — sandbox campaign send status.
 * Mirrors packages/sdk-ts/src/resources/sandbox.ts.
 */
final class SandboxResource extends Resource
{
    /** @return array<string, mixed> */
    public function status(string $campaignId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/sandbox/campaigns/' . rawurlencode($campaignId) . '/status'
        );
        return is_array($out) ? $out : [];
    }
}
