<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * ArchiveResource — public campaign archive list + publish toggles.
 * Mirrors packages/sdk-ts/src/resources/archive.ts.
 */
final class ArchiveResource extends Resource
{
    /**
     * @param array{limit?: int, cursor?: string} $opts
     * @return array<string, mixed>
     */
    public function list(array $opts = []): array
    {
        $query = [];
        if (isset($opts['limit'])) {
            $query['limit'] = $opts['limit'];
        }
        if (isset($opts['cursor']) && $opts['cursor'] !== '') {
            $query['cursor'] = $opts['cursor'];
        }
        $out = $this->client->request('GET', '/api/v1/archive', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{slug?: string, excerpt?: string} $input
     * @return array<string, mixed>
     */
    public function publish(string $campaignId, array $input = []): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/publish-archive',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function unpublish(string $campaignId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/campaigns/' . rawurlencode($campaignId) . '/unpublish-archive'
        );
        return is_array($out) ? $out : [];
    }
}
