<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class IntegrationsResource extends Resource
{
    public static function pathSegment(string $value, string $label = 'integration slug'): string
    {
        $trimmed = trim($value);
        if ($trimmed === '') {
            throw new \InvalidArgumentException($label . ' is required');
        }
        return rawurlencode($trimmed);
    }

    /**
     * Search the honest public catalog.
     *
     * @param array{q?: string, category?: string, badge?: string, capability?: string} $query
     * @return array<string, mixed>
     */
    public function catalog(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/catalog', null, $query);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function connections(): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/connections');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function coverage(): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/coverage');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function stacks(): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/stacks');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function readiness(): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/readiness');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{q?: string, source?: string, target?: string, provider?: string, badge?: string, capability?: string, available?: bool} $query
     * @return array<string, mixed>
     */
    public function recipes(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/recipes', null, $query);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function recipe(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/integrations/recipes/' . self::pathSegment($id, 'recipe id')
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function applyRecipe(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/integrations/recipes/' . self::pathSegment($id, 'recipe id') . '/apply'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function detail(string $slug): array
    {
        $out = $this->client->request('GET', '/api/v1/integrations/' . self::pathSegment($slug));
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function contract(string $slug): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/integrations/' . self::pathSegment($slug) . '/contract'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function health(string $slug): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/integrations/' . self::pathSegment($slug) . '/health'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function startConnect(string $slug): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/integrations/' . self::pathSegment($slug) . '/connect/start'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function finishConnect(string $slug): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/integrations/' . self::pathSegment($slug) . '/connect/callback'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function sync(string $slug): array
    {
        $out = $this->client->request('POST', '/api/v1/integrations/' . self::pathSegment($slug) . '/sync');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function backfill(string $slug): array
    {
        $out = $this->client->request('POST', '/api/v1/integrations/' . self::pathSegment($slug) . '/backfill');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pause(string $slug): array
    {
        $out = $this->client->request('POST', '/api/v1/integrations/' . self::pathSegment($slug) . '/pause');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function disconnect(string $slug): array
    {
        $out = $this->client->request('DELETE', '/api/v1/integrations/' . self::pathSegment($slug));
        return is_array($out) ? $out : [];
    }
}
