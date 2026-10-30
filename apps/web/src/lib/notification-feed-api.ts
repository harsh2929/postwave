// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export interface NotificationFeedItem {
  id: string;
  kind: string;
  title: string;
  body?: string;
  deep_link?: string;
  seen_at?: string;
  read_at?: string;
  created_at: string;
}

export interface NotificationFeedResponse {
  items: NotificationFeedItem[];
  unread_count: number;
}

const EMPTY_FEED: NotificationFeedResponse = { items: [], unread_count: 0 };

// The notifications endpoint isn't served in the mock/dev environment, where it
// 500s on every 60s poll — a failed-network storm plus a browser console error
// on every dashboard load (MIGR-002). In mock mode we resolve to an empty feed
// so the bell renders its empty state without ever making the failing request.
export const notificationFeedApi = {
  list: (limit = 20) =>
    isMockModeEnabled()
      ? Promise.resolve(EMPTY_FEED)
      : api.get<NotificationFeedResponse>(
          `/api/v1/notifications?limit=${encodeURIComponent(String(limit))}`,
        ),
  markSeen: () =>
    isMockModeEnabled()
      ? Promise.resolve({ ok: true as const })
      : api.post<{ ok: true }>("/api/v1/notifications/seen"),
  markReadAll: () =>
    isMockModeEnabled()
      ? Promise.resolve({ ok: true as const })
      : api.post<{ ok: true }>("/api/v1/notifications/read-all"),
  markRead: (id: string) =>
    isMockModeEnabled()
      ? Promise.resolve({ ok: true as const })
      : api.post<{ ok: true }>(
          `/api/v1/notifications/${encodeURIComponent(id)}/read`,
        ),
};
