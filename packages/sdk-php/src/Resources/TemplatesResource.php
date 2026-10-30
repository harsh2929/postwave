<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * TemplatesResource wraps the voice/brand template CRUD surface. Mirrors
 * packages/sdk-ts/src/resources/templates.ts.
 */
final class TemplatesResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(?string $category = null): array
    {
        $q = $category !== null ? ['category' => $category] : [];
        $out = $this->client->request('GET', '/api/v1/voice/templates', null, $q);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $idOrSlug): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/templates/' . rawurlencode($idOrSlug));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $template
     * @return array<string, mixed>
     */
    public function create(array $template): array
    {
        $out = $this->client->request('POST', '/api/v1/voice/templates', $template);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $template
     * @return array<string, mixed>
     */
    public function update(string $idOrSlug, array $template): array
    {
        $out = $this->client->request('PATCH', '/api/v1/voice/templates/' . rawurlencode($idOrSlug), $template);
        return is_array($out) ? $out : [];
    }

    public function delete(string $idOrSlug): void
    {
        $this->client->request('DELETE', '/api/v1/voice/templates/' . rawurlencode($idOrSlug));
    }
}
