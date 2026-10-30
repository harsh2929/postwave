<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AnalyticsResource owns the read-side reporting surface: per-campaign
 * reports, dashboard rollups, link/geography/device/bounce/revenue/cohort
 * breakdowns, side-by-side comparison, and the CSV lifecycle export.
 * Mirrors packages/sdk-ts/src/resources/analytics.ts.
 */
final class AnalyticsResource extends Resource
{
    /** @return array<string, mixed> */
    public function campaignReport(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/report');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function dashboardStats(): array
    {
        $out = $this->client->request('GET', '/api/v1/dashboard/stats');
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function linkReport(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/link-report');
        return is_array($out) ? $out : [];
    }

    /**
     * Stream the per-subscriber lifecycle CSV.
     *
     * @param array<string, mixed> $query offset/limit pagination.
     */
    public function reportCSV(string $campaignId, array $query = []): string
    {
        return $this->client->requestText(
            'GET',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/report.csv',
            null,
            $query,
            ['Accept' => 'text/csv']
        );
    }

    /**
     * Side-by-side comparison across campaigns.
     *
     * @param array<int, string> $campaignIds
     * @return array<int, mixed>
     */
    public function compare(array $campaignIds): array
    {
        $out = $this->client->request('GET', '/api/v1/analytics/campaigns/compare', null, [
            'ids' => implode(',', $campaignIds),
        ]);
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function geography(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/geography');
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function devices(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/devices');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function bounces(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/bounces');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $query bucket/metric/weeks.
     * @return array<int, mixed>
     */
    public function cohorts(array $query = []): array
    {
        $q = $query + ['bucket' => 'month', 'metric' => 'open_rate'];
        $out = $this->client->request('GET', '/api/v1/analytics/cohorts', null, $q);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function revenue(string $campaignId): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($campaignId) . '/revenue');
        return is_array($out) ? $out : [];
    }

    /**
     * Event-level human/machine/unknown summary with exact classifier coverage.
     *
     * @param array<string, string> $query campaign_id/since/until.
     * @return array<string, mixed>
     */
    public function engagementClassificationSummary(array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/analytics/engagement-classification/summary',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Recipient-level human-engaged reach floor plus its unknown-only band.
     *
     * @param array<string, string> $query campaign_id/since/until.
     * @return array<string, mixed>
     */
    public function humanEngagedReach(array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/analytics/human-engaged-reach',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Fixed-window evidence artifact with embedded SHA-256 metadata.
     *
     * @param array<string, string> $query Required campaign_id/since/until.
     * @return array<string, mixed>
     */
    public function exportHumanEngagedReachEvidence(array $query): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/analytics/human-engaged-reach/export',
            null,
            $query,
            ['Accept' => 'application/vnd.postwave.human-engaged-reach-evidence+json']
        );
        return is_array($out) ? $out : [];
    }
}
