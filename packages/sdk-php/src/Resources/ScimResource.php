<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * ScimResource — SCIM tokens + SAML JIT role-mapping CRUD.
 * Mirrors packages/sdk-ts/src/resources/scim.ts.
 */
final class ScimResource extends Resource
{
    /** @return array<string, mixed> */
    public function listTokens(): array
    {
        $out = $this->client->request('GET', '/api/v1/scim/tokens');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{description?: string} $input
     * @return array<string, mixed>
     */
    public function createToken(array $input = []): array
    {
        $out = $this->client->request('POST', '/api/v1/scim/tokens', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function revokeToken(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/scim/tokens/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function listRoleMappings(): array
    {
        $out = $this->client->request('GET', '/api/v1/scim/role-mappings');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{group_name: string, role: string, precedence?: int} $input
     * @return array<string, mixed>
     */
    public function upsertRoleMapping(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/scim/role-mappings', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function deleteRoleMapping(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/scim/role-mappings/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
