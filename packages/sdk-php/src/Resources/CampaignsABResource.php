<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * CampaignsABResource — per-campaign A/B testing API.
 * Mirrors packages/sdk-ts/src/resources/campaigns-ab.ts.
 */
final class CampaignsABResource extends Resource
{
    /**
     * Replace/upsert the variant set for a campaign.
     *
     * @param array<int, array<string, mixed>> $variants
     * @return array<int, mixed>
     */
    public function createVariants(string $campaignId, array $variants): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/variants',
            $variants
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function listVariants(string $campaignId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/variants'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function getAB(string $campaignId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/ab'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{winner_metric: string, evaluation_window_hours: int, winner_recipients_pct: int} $input
     * @return array<string, mixed>
     */
    public function setABSettings(string $campaignId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/ab/settings',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function evaluateAB(string $campaignId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/ab/evaluate'
        );
        return is_array($out) ? $out : [];
    }
}
