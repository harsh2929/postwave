<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AccountResource — tenant account (me) read + update.
 * Mirrors packages/sdk-ts/src/resources/account.ts.
 */
final class AccountResource extends Resource
{
    /** @return array<string, mixed> */
    public function me(): array
    {
        $out = $this->client->request('GET', '/api/v1/me');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{sending_domain?: string, from_name?: string, from_email?: string} $input
     * @return array<string, mixed>
     */
    public function update(array $input): array
    {
        $out = $this->client->request('PATCH', '/api/v1/me', $input);
        return is_array($out) ? $out : [];
    }
}
