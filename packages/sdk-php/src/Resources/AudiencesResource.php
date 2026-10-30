<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Audiences surface — first-party lookalike audiences (SUB-033).
 *
 * Distinct from SubscribersResource::lookalike* (SUB-068) which target the
 * /api/v1/subscribers/lookalike endpoints.
 */
final class AudiencesResource extends Resource
{
    /**
     * Generate a lookalike audience from a seed segment.
     *
     * @param array{seed_segment_id: string, name?: string, size?: int, confidence_threshold?: float|null} $input
     * @return array<string, mixed>
     */
    public function generate(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/audiences/lookalike', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/audiences/lookalike/' . IntegrationsResource::pathSegment($id, 'lookalike audience id')
        );
        return is_array($out) ? $out : [];
    }

    /**
     * List the ranked members of a lookalike audience, paginated.
     *
     * @return array<string, mixed>
     */
    public function members(string $id, ?int $page = null, ?int $perPage = null): array
    {
        $query = [];
        if ($page !== null) {
            $query['page'] = $page;
        }
        if ($perPage !== null) {
            $query['per_page'] = $perPage;
        }
        $out = $this->client->request(
            'GET',
            '/api/v1/audiences/lookalike/' . IntegrationsResource::pathSegment($id, 'lookalike audience id') . '/members',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function discard(string $id): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/audiences/lookalike/' . IntegrationsResource::pathSegment($id, 'lookalike audience id')
        );
        return is_array($out) ? $out : [];
    }
}
