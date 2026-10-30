// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the user session ("active devices") API. Mirrors
// apps/api/internal/auth/sessions_handler.go (GET/DELETE /auth/sessions +
// logout-all). The backend shipped these endpoints with no client consumer —
// this is the dashboard surface.

import { api } from "./api";

export interface SessionInfo {
  id: string;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
  ip?: string;
  user_agent?: string;
  /** Server-normalised device identity; do not re-parse the user agent. */
  device_label?: string;
  device_type?: string;
  device_os?: string;
  device_client?: string;
  auth_method: string;
  current: boolean;
}

export interface SessionsEnvelope {
  sessions: SessionInfo[];
  nextCursor?: string;
}

interface AccountRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  cursor?: string;
  limit?: number;
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    Number.isFinite(Date.parse(value))
  );
}

function optionalText(
  value: unknown,
  max: number,
): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

function parseSession(value: unknown): SessionInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Active-device response contained an invalid session.");
  }
  const row = value as Record<string, unknown>;
  if (
    !isBoundedText(row.id, 512) ||
    !isTimestamp(row.issued_at) ||
    !isTimestamp(row.last_seen_at) ||
    !isTimestamp(row.expires_at) ||
    Date.parse(row.issued_at) > Date.parse(row.expires_at) ||
    !isBoundedText(row.auth_method, 128) ||
    typeof row.current !== "boolean" ||
    !optionalText(row.ip, 256) ||
    !optionalText(row.user_agent, 4096) ||
    !optionalText(row.device_label, 256) ||
    !optionalText(row.device_type, 64) ||
    !optionalText(row.device_os, 128) ||
    !optionalText(row.device_client, 128)
  ) {
    throw new Error("Active-device response contained an invalid session.");
  }
  return {
    id: row.id,
    issued_at: row.issued_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    auth_method: row.auth_method,
    current: row.current,
    ...(row.ip !== undefined ? { ip: row.ip } : {}),
    ...(row.user_agent !== undefined ? { user_agent: row.user_agent } : {}),
    ...(row.device_label !== undefined
      ? { device_label: row.device_label }
      : {}),
    ...(row.device_type !== undefined ? { device_type: row.device_type } : {}),
    ...(row.device_os !== undefined ? { device_os: row.device_os } : {}),
    ...(row.device_client !== undefined
      ? { device_client: row.device_client }
      : {}),
  };
}

export function parseSessionsEnvelope(
  value: unknown,
  maxSessions = 1_000,
): SessionsEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Active-device response was malformed.");
  }
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.sessions) ||
    body.sessions.length > maxSessions ||
    (body.nextCursor !== undefined && !isBoundedText(body.nextCursor, 8 * 1024))
  ) {
    throw new Error("Active-device response was malformed.");
  }
  const sessions = body.sessions.map(parseSession);
  if (new Set(sessions.map((row) => row.id)).size !== sessions.length) {
    throw new Error("Active-device response repeated a session.");
  }
  if (sessions.filter((row) => row.current).length > 1) {
    throw new Error(
      "Active-device response identified multiple current sessions.",
    );
  }
  return {
    sessions,
    ...(typeof body.nextCursor === "string"
      ? { nextCursor: body.nextCursor }
      : {}),
  };
}

function confirmedCount(value: unknown): number {
  const count =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).revoked_count
      : undefined;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error(
      "The server did not confirm how many sessions were signed out.",
    );
  }
  return Number(count);
}

export const sessionsApi = {
  async list(
    options: Pick<AccountRequestOptions, "signal" | "cursor" | "limit"> = {},
  ) {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    const payload = await api.get<unknown>(
      `/api/v1/auth/sessions${query ? `?${query}` : ""}`,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      },
    );
    return parseSessionsEnvelope(payload);
  },
  async listAll(options: Pick<AccountRequestOptions, "signal"> = {}) {
    const sessions: SessionInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 25; page += 1) {
      const result = await sessionsApi.list({
        signal: options.signal,
        cursor,
        limit: 200,
      });
      sessions.push(...result.sessions);
      if (sessions.length > 5_000) {
        throw new Error("Active-device response exceeded the safe list limit.");
      }
      if (!result.nextCursor) {
        const parsed = parseSessionsEnvelope({ sessions }, 5_000);
        return parsed;
      }
      if (cursors.has(result.nextCursor)) {
        throw new Error("Active-device pagination repeated a cursor.");
      }
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Active-device pagination exceeded the safe page limit.");
  },
  async revoke(id: string, options: AccountRequestOptions = {}) {
    const payload = await api.delete<unknown>(
      `/api/v1/auth/sessions/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      },
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).revoked !== true
    ) {
      throw new Error(
        "The server did not confirm that session was signed out.",
      );
    }
    return { revoked: true as const };
  },
  async logoutAllOthers(options: AccountRequestOptions = {}) {
    const payload = await api.post<unknown>(
      "/api/v1/auth/sessions/logout-all",
      undefined,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      },
    );
    return { revoked_count: confirmedCount(payload) };
  },
};
