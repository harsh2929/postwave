<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class EventsResource extends Resource
{
    /**
     * Replay events past a cursor. Pair with the `next_cursor` in the
     * response to paginate. Empty `topics` matches everything.
     *
     * @param array<int, string> $topics
     * @return array{events: array<int, mixed>, next_cursor: int, has_more: bool}
     */
    public function replay(int $since = 0, array $topics = [], int $limit = 200): array
    {
        $query = ['since' => $since, 'limit' => $limit];
        if ($topics) {
            $query['topics'] = implode(',', $topics);
        }
        $out = $this->client->request('GET', '/api/v1/events/replay', null, $query);
        return is_array($out)
            ? [
                'events'      => is_array($out['events'] ?? null) ? $out['events'] : [],
                'next_cursor' => (int) ($out['next_cursor'] ?? 0),
                'has_more'    => (bool) ($out['has_more'] ?? false),
            ]
            : ['events' => [], 'next_cursor' => 0, 'has_more' => false];
    }
}
