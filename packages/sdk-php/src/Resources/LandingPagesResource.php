<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * LandingPagesResource — landing-page CRUD + soft archive.
 * Mirrors packages/sdk-ts/src/resources/landing-pages.ts.
 */
final class LandingPagesResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/landing-pages');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/landing-pages/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/landing-pages', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/landing-pages/' . rawurlencode($id),
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Soft archive — flips status to "archived". Hard-delete is
     * intentionally not exposed.
     *
     * @return array<string, mixed>
     */
    public function archive(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/landing-pages/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
