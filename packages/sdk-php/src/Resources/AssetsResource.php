<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AssetsResource — public image asset lifecycle methods.
 * Mirrors packages/sdk-ts/src/resources/assets.ts.
 */
final class AssetsResource extends Resource
{
    /**
     * Upload an image. Pass raw bytes as a binary string along with the
     * desired filename and MIME. Server enforces image-only content and a
     * 10 MiB cap.
     *
     * @return array<string, mixed>
     */
    public function upload(string $filename, string $bytes, string $mime): array
    {
        $out = $this->client->request('POST', '/api/v1/assets', [
            'filename' => $filename,
            'mime' => $mime,
            'content_base64' => base64_encode($bytes),
        ]);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{limit?: int, before?: string, q?: string, sort?: string, filter?: string, tag?: string, folder_id?: string} $params
     * @return array<string, mixed>
     */
    public function list(array $params = []): array
    {
        $out = $this->client->request('GET', '/api/v1/assets', null, $params);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/assets/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function update(string $id, string $altText): array
    {
        $out = $this->client->request('PATCH', '/api/v1/assets/' . rawurlencode($id), [
            'alt_text' => $altText,
        ]);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function usage(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/assets/' . rawurlencode($id) . '/usage');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id, bool $force = false): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/assets/' . rawurlencode($id),
            null,
            ['force' => $force]
        );
        return is_array($out) ? $out : [];
    }
}
