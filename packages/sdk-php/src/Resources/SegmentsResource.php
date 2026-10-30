<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SegmentsResource wraps the segment CRUD + AST-preview + NL-compile
 * surface. Mirrors packages/sdk-ts/src/resources/segments.ts.
 */
final class SegmentsResource extends Resource
{
    /**
     * @param array<string, mixed> $query cursor.
     * @return array<string, mixed>
     */
    public function list(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/segments', null, $query);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/segments/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/segments', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request('PATCH', '/api/v1/segments/' . rawurlencode($id), $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/segments/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * Preview the recipient count for an ad-hoc segment AST.
     *
     * @param array<string, mixed> $ast
     * @return array<string, mixed>
     */
    public function preview(array $ast): array
    {
        $out = $this->client->request('POST', '/api/v1/segments/preview', ['query_ast' => $ast]);
        return is_array($out) ? $out : [];
    }

    /**
     * Compile a natural-language description into a segment AST via the
     * server-side AI-backed compiler.
     *
     * @return array<string, mixed>
     */
    public function compileFromNaturalLanguage(string $text): array
    {
        $out = $this->client->request('POST', '/api/v1/segments/compile-from-text', ['text' => $text]);
        return is_array($out) ? $out : [];
    }
}
