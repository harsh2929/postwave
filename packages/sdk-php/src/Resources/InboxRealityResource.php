<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * InboxRealityResource — inbox-placement report, predict, diagnose, render.
 * Mirrors packages/sdk-ts/src/resources/inbox-reality.ts.
 */
final class InboxRealityResource extends Resource
{
    /** @return array<string, mixed> */
    public function getCampaignReport(string $campaignId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/inbox-reality/campaigns/' . rawurlencode($campaignId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function predict(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/predict', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $signals
     * @return array<string, mixed>
     */
    public function diagnose(string $campaignId, array $signals = []): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/diagnose/' . rawurlencode($campaignId),
            $signals
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function render(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/render', $input);
        return is_array($out) ? $out : [];
    }
}
