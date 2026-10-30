<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AuditResource — tenant audit-log query.
 * Mirrors packages/sdk-ts/src/resources/audit.ts.
 */
final class AuditResource extends Resource
{
    /**
     * @param array{actor_type?: string, actor_label?: string, action?: string, resource_type?: string, since?: string, cursor?: string} $params
     * @return array<string, mixed>
     */
    public function query(array $params = []): array
    {
        $out = $this->client->request('GET', '/api/v1/audit', null, $params);
        return is_array($out) ? $out : [];
    }
}
