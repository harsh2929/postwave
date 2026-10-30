<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * CustomDomainsResource manages custom sending/forms/links domains and
 * their DNS verification. Mirrors packages/sdk-ts/src/resources/custom-domains.ts.
 */
final class CustomDomainsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/custom-domains');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{domain: string, purpose: string} $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/custom-domains', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function verify(string $id): array
    {
        $out = $this->client->request('POST', '/api/v1/custom-domains/' . rawurlencode($id) . '/verify');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/custom-domains/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
