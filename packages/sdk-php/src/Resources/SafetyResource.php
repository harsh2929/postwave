<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SafetyResource — pre-send content safety check.
 * Mirrors packages/sdk-ts/src/resources/safety.ts.
 */
final class SafetyResource extends Resource
{
    /**
     * @param array{subject: string, body_html: string, body_text?: string, intended_audience_count: int} $input
     * @return array<string, mixed>
     */
    public function check(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/safety/check', $input);
        return is_array($out) ? $out : [];
    }
}
