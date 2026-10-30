<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * ApprovalsResource — change-approval queue list + decision.
 * Mirrors packages/sdk-ts/src/resources/approvals.ts.
 */
final class ApprovalsResource extends Resource
{
    /**
     * @param array{status?: string, cursor?: string} $params
     * @return array<string, mixed>
     */
    public function list(array $params = []): array
    {
        $out = $this->client->request('GET', '/api/v1/approvals', null, $params);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{decision: string, notes?: string} $input
     * @return array<string, mixed>
     */
    public function decide(string $id, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/approvals/' . rawurlencode($id) . '/decision',
            $input
        );
        return is_array($out) ? $out : [];
    }
}
