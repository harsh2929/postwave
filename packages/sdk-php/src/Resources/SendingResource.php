<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SendingResource — sending + warmup state reads.
 * Mirrors packages/sdk-ts/src/resources/sending.ts.
 */
final class SendingResource extends Resource
{
    /** @return array<string, mixed> */
    public function getState(): array
    {
        $out = $this->client->request('GET', '/api/v1/sending/state');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function getWarmup(): array
    {
        $out = $this->client->request('GET', '/api/v1/sending/warmup');
        return is_array($out) ? $out : [];
    }
}
