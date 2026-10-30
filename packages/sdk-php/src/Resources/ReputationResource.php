<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * ReputationResource — sender reputation snapshot.
 * Mirrors packages/sdk-ts/src/resources/reputation.ts.
 */
final class ReputationResource extends Resource
{
    /** @return array<string, mixed> */
    public function get(): array
    {
        $out = $this->client->request('GET', '/api/v1/reputation');
        return is_array($out) ? $out : [];
    }
}
