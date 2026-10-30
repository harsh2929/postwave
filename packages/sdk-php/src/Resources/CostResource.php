<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * CostResource — metered cost aggregation.
 * Mirrors packages/sdk-ts/src/resources/cost.ts.
 */
final class CostResource extends Resource
{
    /**
     * @param array{since: string, group_by: string} $input
     * @return array<string, mixed>
     */
    public function aggregate(array $input): array
    {
        $out = $this->client->request('GET', '/api/v1/cost/aggregate', null, [
            'since' => $input['since'],
            'group_by' => $input['group_by'],
        ]);
        return is_array($out) ? $out : [];
    }
}
