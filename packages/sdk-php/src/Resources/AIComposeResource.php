<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AI compose surface — turns a 1-line brief into a campaign draft plus
 * subject-line variants. Both endpoints require the write:campaigns scope.
 */
final class AIComposeResource extends Resource
{
    /**
     * Generate a primary draft + subject variants from a brief.
     *
     * @param array{brief: string, variant_count?: int, tone?: string, audience?: string} $input
     * @return array<string, mixed>
     */
    public function composeBroadcast(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/ai/compose/broadcast', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Generate additional subject variants for an existing draft.
     *
     * @param array{subject: string, body?: string, variant_count?: int} $input
     * @return array<string, mixed>
     */
    public function composeVariants(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/ai/compose/variants', $input);
        return is_array($out) ? $out : [];
    }
}
