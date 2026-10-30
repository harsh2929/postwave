<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * InboundEmailsResource — inbound email list + per-tenant endpoint.
 * Mirrors packages/sdk-ts/src/resources/inbound-emails.ts.
 */
final class InboundEmailsResource extends Resource
{
    /**
     * @param array{subscriber_id?: string, campaign_id?: string, limit?: int} $params
     * @return array<string, mixed>
     */
    public function list(array $params = []): array
    {
        $out = $this->client->request('GET', '/api/v1/inbound-emails', null, $params);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function getEndpoint(): array
    {
        $out = $this->client->request('GET', '/api/v1/inbound-emails/endpoint');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function rotateEndpoint(): array
    {
        $out = $this->client->request('POST', '/api/v1/inbound-emails/endpoint/rotate');
        return is_array($out) ? $out : [];
    }
}
