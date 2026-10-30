<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AuthChecksResource — email-auth (SPF/DKIM/DMARC) readiness checks.
 * Mirrors packages/sdk-ts/src/resources/auth-checks.ts.
 */
final class AuthChecksResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/auth-checks');
        return is_array($out) ? $out : [];
    }
}
