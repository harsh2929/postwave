<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * DmarcResource — aggregate DMARC report list.
 * Mirrors packages/sdk-ts/src/resources/dmarc.ts.
 */
final class DmarcResource extends Resource
{
    /**
     * @param array{domain?: string, from?: string, to?: string, limit?: int} $params
     * @return array<string, mixed>
     */
    public function list(array $params = []): array
    {
        $out = $this->client->request('GET', '/api/v1/deliverability/dmarc-reports', null, $params);
        return is_array($out) ? $out : [];
    }
}
