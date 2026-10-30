<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * LinkCheckResource — pre-send link checker.
 * Mirrors packages/sdk-ts/src/resources/link-check.ts.
 */
final class LinkCheckResource extends Resource
{
    /** @return array<int, mixed> */
    public function check(string $campaignId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/check-links'
        );
        return is_array($out) ? $out : [];
    }
}
