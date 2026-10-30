<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SuppressionsResource manages the tenant suppression list. Mirrors
 * packages/sdk-ts/src/resources/suppressions.ts.
 */
final class SuppressionsResource extends Resource
{
    /**
     * Add a single email to the suppression list.
     *
     * @param array{email: string, reason?: string} $input
     * @return array<string, mixed>
     */
    public function add(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/suppressions', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Bulk-import emails onto the suppression list.
     *
     * @param array{emails: array<int, string>, reason?: string} $input
     * @return array<string, mixed>
     */
    public function bulkImport(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/suppressions/bulk', $input);
        return is_array($out) ? $out : [];
    }
}
