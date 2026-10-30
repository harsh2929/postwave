<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * TrackResource — product-event ingestion + listing.
 * Mirrors packages/sdk-ts/src/resources/track.ts.
 */
final class TrackResource extends Resource
{
    /**
     * Record a product event for a subscriber. Pass either subscriber_id
     * or email.
     *
     * @param array{subscriber_id?: string, email?: string, event_name: string, properties?: array<string, mixed>, occurred_at?: string} $input
     * @return array<string, mixed>
     */
    public function track(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/track', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{subscriber_id: string, limit?: int} $params
     * @return array<string, mixed>
     */
    public function listEvents(array $params): array
    {
        $out = $this->client->request('GET', '/api/v1/track/events', null, $params);
        return is_array($out) ? $out : [];
    }
}
