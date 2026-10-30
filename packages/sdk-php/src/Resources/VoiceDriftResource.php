<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * VoiceDriftResource — pre-send voice-fidelity check.
 * Mirrors packages/sdk-ts/src/resources/voice-drift.ts.
 */
final class VoiceDriftResource extends Resource
{
    /**
     * @param array{html: string, text?: string, profile_id?: string} $input
     * @return array<string, mixed>
     */
    public function check(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/voice/drift', $input);
        return is_array($out) ? $out : [];
    }
}
