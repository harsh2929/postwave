<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * TagsResource — tenant tag list/create/versioned-update contract.
 * Mirrors packages/sdk-ts/src/resources/tags.ts.
 */
final class TagsResource extends Resource
{
    /** @return array<string, mixed> */
    public function list(
        ?string $query = null,
        ?string $groupId = null,
        bool $includeArchived = false
    ): array
    {
        $out = $this->client->request('GET', '/api/v1/tags', null, array_filter([
            'query' => $query,
            'group_id' => $groupId,
            'include_archived' => $includeArchived,
        ], static fn (mixed $value): bool => $value !== null));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{color?: string, description?: string, group_id?: string, pii?: bool} $options
     * @return array<string, mixed>
     */
    public function create(string $name, array $options = []): array
    {
        $body = ['name' => $name];
        foreach (['color', 'description', 'group_id', 'pii'] as $field) {
            if (array_key_exists($field, $options)) {
                $body[$field] = $options[$field];
            }
        }
        $out = $this->client->request('POST', '/api/v1/tags', $body);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{name?: string, color?: string, description?: string, group_id?: string, pii?: bool} $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch, string $etag): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/tags/' . rawurlencode($id),
            $patch,
            [],
            ['If-Match' => $etag]
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @deprecated Permanent deletion is deliberately disabled server-side;
     * this compatibility method always throws unsafe_mutation_disabled.
     * @return array<string, mixed>
     */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/tags/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
