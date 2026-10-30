<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * InboundRoutesResource — inbound-route CRUD (Mailgun-Routes killer).
 * Mirrors packages/sdk-ts/src/resources/inbound-routes.ts.
 */
final class InboundRoutesResource extends Resource
{
    /** @return array<string, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/inbound-routes');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/inbound-routes', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function patch(string $id, array $patch): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/inbound-routes/' . rawurlencode($id),
            $patch
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/inbound-routes/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
