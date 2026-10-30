<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class FormsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/forms');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/forms', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @return array{snippet: string, language: string, instructions: string, flavor: string}
     */
    public function embedSnippet(string $id, string $flavor = 'script'): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/forms/' . rawurlencode($id) . '/embed/' . rawurlencode($flavor)
        );
        return is_array($out) ? $out : ['snippet' => '', 'language' => '', 'instructions' => '', 'flavor' => $flavor];
    }
}
