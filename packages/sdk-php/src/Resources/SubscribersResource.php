<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class SubscribersResource extends Resource
{
    /** @return array{items: array<int, array<string, mixed>>, total: int} */
    public function transformRules(): array
    {
        $out = $this->client->request('GET', '/api/v1/profile-transform-rules');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{name: string, source_path: string, target_key: string, transform?: string, status?: string} $input
     * @return array<string, mixed>
     */
    public function upsertTransformRule(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/profile-transform-rules', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array{ok: bool} */
    public function deleteTransformRule(string $ruleId): array
    {
        $id = trim($ruleId);
        if ($id === '') {
            throw new \InvalidArgumentException('Profile transform rule ID is required');
        }
        $out = $this->client->request('DELETE', '/api/v1/profile-transform-rules/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function list(?string $query = null, int $limit = 100): array
    {
        $q = ['limit' => $limit];
        if ($query !== null) {
            $q['query'] = $query;
        }
        $out = $this->client->request('GET', '/api/v1/subscribers', null, $q);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/subscribers', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch): array
    {
        $out = $this->client->request('PATCH', '/api/v1/subscribers/' . rawurlencode($id), $patch);
        return is_array($out) ? $out : [];
    }

    public function delete(string $id): void
    {
        $this->client->request('DELETE', '/api/v1/subscribers/' . rawurlencode($id));
    }

    /**
     * Full-text search across subscribers.
     *
     * @return array<string, mixed>
     */
    public function search(string $q): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/search', null, ['q' => $q]);
        return is_array($out) ? $out : [];
    }

    public function suppress(string $id): void
    {
        $this->client->request('POST', '/api/v1/subscribers/' . rawurlencode($id) . '/suppress');
    }

    /**
     * Import subscribers from a CSV payload. The CSV is sent as a raw
     * text/csv body with the original filename surfaced via the
     * X-Postwave-Filename header (mirrors the TS SDK importCsv).
     *
     * @return array<string, mixed>
     */
    public function importCsv(string $filename, string $csv): array
    {
        $out = $this->client->requestRaw(
            'POST',
            '/api/v1/subscribers/import',
            $csv,
            'text/csv; charset=utf-8',
            [],
            ['X-Postwave-Filename' => $filename]
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Stream the subscriber CSV export.
     *
     * @param array<string, mixed> $query
     */
    public function exportCsv(array $query = []): string
    {
        return $this->client->requestText(
            'GET',
            '/api/v1/subscribers/export.csv',
            null,
            $query,
            ['Accept' => 'text/csv']
        );
    }

    /**
     * Merge a duplicate subscriber into a primary record.
     *
     * @param array{primary_id: string, duplicate_id: string} $input
     * @return array<string, mixed>
     */
    public function merge(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/subscribers/merge', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Per-subscriber engagement event log.
     *
     * @param array<string, mixed> $query
     * @return array<string, mixed>
     */
    public function activity(string $id, array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/subscribers/' . rawurlencode($id) . '/activity',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Computed engagement score for one subscriber.
     *
     * @return array<string, mixed>
     */
    public function engagement(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/' . rawurlencode($id) . '/engagement');
        return is_array($out) ? $out : [];
    }

    /**
     * Create a tenant-scoped custom field (schema slot for subscriber records).
     *
     * @param array{key: string, label: string, type: string} $input
     * @return array<string, mixed>
     */
    public function customFieldCreate(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/custom-fields', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Inferred trait (gender|age_group|interests) for a subscriber.
     *
     * @return array<string, mixed>
     */
    public function inferredTrait(string $id, string $trait): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/' . rawurlencode($id) . '/traits/inferred_' . rawurlencode($trait));
        return is_array($out) ? $out : [];
    }

    /**
     * List saved first-party lookalike audiences (SUB-068).
     *
     * @return array<string, mixed>
     */
    public function lookalikeList(): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/lookalike');
        return is_array($out) ? $out : [];
    }

    /**
     * Generate a first-party lookalike audience from a seed segment.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function lookalikeGenerate(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/subscribers/lookalike', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Fetch one lookalike audience header plus a page of ranked members.
     *
     * @param array<string, mixed> $query
     * @return array<string, mixed>
     */
    public function lookalikeGet(string $id, int $page = 1, int $perPage = 50): array
    {
        $out = $this->client->request('GET', '/api/v1/subscribers/lookalike/' . rawurlencode($id), null, ['page' => $page, 'per_page' => $perPage]);
        return is_array($out) ? $out : [];
    }
}
