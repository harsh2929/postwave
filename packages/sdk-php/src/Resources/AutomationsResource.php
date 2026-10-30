<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * AutomationsResource wraps the automation flow surface: CRUD, trigger,
 * pause/resume, execution history, and behavioral triggers. Mirrors
 * packages/sdk-ts/src/resources/automations.ts.
 */
final class AutomationsResource extends Resource
{
    /**
     * @param array<string, mixed> $query status/cursor.
     * @return array<string, mixed>
     */
    public function list(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/automations', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/automations', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch): array
    {
        $out = $this->client->request('PATCH', '/api/v1/automations/' . rawurlencode($id), $patch);
        return is_array($out) ? $out : [];
    }

    /**
     * Fire an automation trigger event.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function trigger(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/automations/trigger', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pause(string $automationId): array
    {
        $out = $this->client->request('POST', '/api/v1/automations/' . rawurlencode($automationId) . '/pause');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function resume(string $automationId): array
    {
        $out = $this->client->request('POST', '/api/v1/automations/' . rawurlencode($automationId) . '/resume');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function listExecutions(string $automationId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/automations/' . rawurlencode($automationId) . '/executions'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createBehavioralTrigger(string $automationId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/automations/' . rawurlencode($automationId) . '/behavioral-triggers',
            $input
        );
        return is_array($out) ? $out : [];
    }
}
