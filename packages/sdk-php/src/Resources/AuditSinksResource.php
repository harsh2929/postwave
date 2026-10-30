<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AuditSinksResource — audit-log streaming destinations, DLQ replay, and
 * circuit-breaker control. Mirrors packages/sdk-ts/src/resources/audit-sinks.ts.
 */
final class AuditSinksResource extends Resource
{
    /** @return array<string, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/audit-sinks');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/audit-sinks', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Toggle enabled, rename, edit config, or rotate credentials.
     *
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function patch(string $id, array $patch): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/audit-sinks/' . rawurlencode($id),
            $patch
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function delete(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/audit-sinks/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * Preflight test: ship one canary event using the supplied config +
     * credentials. Does not persist.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function test(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/audit-sinks/test', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Probe an existing sink using its stored credentials.
     *
     * @return array<string, mixed>
     */
    public function testExisting(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/audit-sinks/' . rawurlencode($id) . '/test'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function dlqList(): array
    {
        $out = $this->client->request('GET', '/api/v1/audit-sinks/dlq');
        return is_array($out) ? $out : [];
    }

    /**
     * Synchronously re-ship the audit_log range captured by this DLQ entry.
     *
     * @return array<string, mixed>
     */
    public function dlqReplay(int $id): array
    {
        $out = $this->client->request('POST', '/api/v1/audit-sinks/dlq/' . $id . '/replay');
        return is_array($out) ? $out : [];
    }

    /**
     * Force-close the breaker without waiting for the cooldown.
     *
     * @return array<string, mixed>
     */
    public function circuitReset(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/audit-sinks/' . rawurlencode($id) . '/circuit/reset'
        );
        return is_array($out) ? $out : [];
    }
}
