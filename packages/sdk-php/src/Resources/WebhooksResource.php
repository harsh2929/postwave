<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Canonical outbound-webhooks API.
 *
 * Receiver-auth credential values supplied to create/update are write-only.
 * Read responses contain only value-free metadata and auth_config_status.
 */
final class WebhooksResource extends Resource
{
    /** @return array<string, mixed> {webhooks, next_cursor} */
    public function list(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/outbound-webhooks', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{
     *   url: string,
     *   events: array<int, string>,
     *   description?: string,
     *   algorithm?: 'hmac_sha256'|'ecdsa_p256'|'ed25519',
     *   list_id?: string,
     *   auth_config?: array<string, mixed>
     * } $input
     * @return array<string, mixed> Includes one-shot signing material.
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/outbound-webhooks', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Omit auth_config to preserve credentials, pass null/type=none to clear,
     * or pass a complete credential object to replace atomically.
     *
     * @param array{
     *   url?: string,
     *   events?: array<int, string>,
     *   description?: string,
     *   active?: bool,
     *   auth_config?: array<string, mixed>|null
     * } $input
     * @return array<string, mixed>
     */
    public function update(string $id, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/outbound-webhooks/' . IntegrationsResource::pathSegment($id, 'outbound webhook id'),
            $input
        );
        return is_array($out) ? $out : [];
    }

    public function delete(string $id, bool $soft = false): void
    {
        $this->client->request(
            'DELETE',
            '/api/v1/outbound-webhooks/' . IntegrationsResource::pathSegment($id, 'outbound webhook id'),
            null,
            $soft ? ['soft' => 1] : []
        );
    }

    /** @return array<string, mixed> Canonical webhook.test result. */
    public function test(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/outbound-webhooks/' . IntegrationsResource::pathSegment($id, 'outbound webhook id') . '/test'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> {deliveries, next_cursor} */
    public function deliveries(string $id, array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/outbound-webhooks/' . IntegrationsResource::pathSegment($id, 'outbound webhook id') . '/deliveries',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Creates a new pending child delivery while preserving the original.
     * Reuse $idempotencyKey when retrying the logical replay.
     *
     * @return array<string, mixed>
     */
    public function replay(string $deliveryId, string $idempotencyKey): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/outbound-webhooks/deliveries/' .
                IntegrationsResource::pathSegment($deliveryId, 'delivery id') .
                '/replay',
            null,
            [],
            ['Idempotency-Key' => $idempotencyKey]
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Rotate signing material with a grace window (default 24h).
     * @return array<string, mixed> One-shot signing material.
     */
    public function rotateSecret(string $id, int $graceMinutes = 1440): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/outbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'outbound webhook id') .
                '/rotate-secret',
            null,
            ['grace_minutes' => $graceMinutes]
        );
        return is_array($out) ? $out : [];
    }
}
