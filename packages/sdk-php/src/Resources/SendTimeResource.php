<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SendTimeResource — per-subscriber send-time optimization.
 * Mirrors packages/sdk-ts/src/resources/send-time.ts.
 */
final class SendTimeResource extends Resource
{
    /** @return array<string, mixed> */
    public function getBestTime(string $subscriberId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/subscribers/' . rawurlencode($subscriberId) . '/best-send-time'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function scheduleCampaignByBestTime(string $campaignId, int $withinDays): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/schedule-by-best-time',
            ['within_days' => $withinDays]
        );
        return is_array($out) ? $out : [];
    }
}
