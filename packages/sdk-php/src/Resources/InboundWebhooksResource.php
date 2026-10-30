<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class InboundWebhooksResource extends Resource
{
    /** @return array<string, mixed> {items, next_cursor} */
    public function list(array $query = []): array
    {
        $out = $this->client->request('GET', '/api/v1/inbound-webhooks', null, $query);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> Includes one-shot secret. */
    public function create(array $input = []): array
    {
        $out = $this->client->request('POST', '/api/v1/inbound-webhooks', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/inbound-webhooks/' . IntegrationsResource::pathSegment($id, 'inbound webhook id')
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function update(string $id, array $patch): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/inbound-webhooks/' . IntegrationsResource::pathSegment($id, 'inbound webhook id'),
            $patch
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> Includes one-shot replacement secret. */
    public function rotate(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/rotate'
        );
        return is_array($out) ? $out : [];
    }

    public function delete(string $id): void
    {
        $this->client->request(
            'DELETE',
            '/api/v1/inbound-webhooks/' . IntegrationsResource::pathSegment($id, 'inbound webhook id')
        );
    }

    /** @return array<string, mixed> {items, next_cursor} */
    public function events(string $id, array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/events',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> Durable replay receipt. */
    public function replay(
        string $id,
        int|string $eventId,
        string $idempotencyKey
    ): array {
        $out = $this->client->request(
            'POST',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/events/' . rawurlencode((string) $eventId) .
                '/replay',
            null,
            [],
            ['Idempotency-Key' => $idempotencyKey]
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function triggers(string $id): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/triggers'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function createTrigger(string $id, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/triggers',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function updateTrigger(string $id, string $triggerId, array $patch): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/triggers/' .
                IntegrationsResource::pathSegment($triggerId, 'trigger id'),
            $patch
        );
        return is_array($out) ? $out : [];
    }

    public function deleteTrigger(string $id, string $triggerId): void
    {
        $this->client->request(
            'DELETE',
            '/api/v1/inbound-webhooks/' .
                IntegrationsResource::pathSegment($id, 'inbound webhook id') .
                '/triggers/' .
                IntegrationsResource::pathSegment($triggerId, 'trigger id')
        );
    }

    /** @return array<string, mixed> */
    public function previewTransform(string $transformJq, mixed $body): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/inbound-webhooks/transform/preview',
            ['transform_jq' => $transformJq, 'body' => $body]
        );
        return is_array($out) ? $out : [];
    }
}
