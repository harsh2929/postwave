/**
 * hooks/useSessions.ts — active sessions / trusted devices.
 *
 * "I lost my laptop" is a phone-first emergency: the phone is the device you
 * always have, so cutting every other session from it is the single highest
 * value security action a mobile app can offer. The backend has had all three
 * verbs since sessions_handler.go shipped — GET /api/v1/auth/sessions,
 * DELETE /api/v1/auth/sessions/{id} and POST /api/v1/auth/sessions/logout-all
 * — and nothing in apps/mobile ever called them.
 *
 * Deliberately NOT offline-capable: revocation is inherently an online action,
 * and a cached list of sessions is a security screen showing stale truth. The
 * query is gated, and the section renders a reconnect notice when the gate is
 * closed rather than serving a snapshot.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listSessions,
  logoutAllOtherSessions,
  revokeSession,
  type AuthSessionInfo,
} from "@/api/authSessions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { compareSessions } from "@/lib/sessionDevice";

export type { AuthSessionInfo };

/** Bound so one pathological account cannot page forever on a phone. */
const MAX_SESSION_PAGES = 5;

export const SESSIONS_QUERY_KEY = "auth-sessions" as const;

export class SessionsApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SessionsApiError";
    this.code = code;
  }
}

async function loadAllSessions(baseUrl: string): Promise<AuthSessionInfo[]> {
  const rows: AuthSessionInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const res = await listSessions(baseUrl, cursor);
    if (res.error || !res.data) {
      throw new SessionsApiError(
        res.error?.message ?? "Couldn't load your active sessions.",
        res.error?.code,
      );
    }
    rows.push(...res.data.sessions);
    cursor = res.data.nextCursor;
    if (!cursor) break;
  }
  return rows.sort(compareSessions);
}

export function useSessions() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SESSIONS_QUERY_KEY, gate.baseUrl, gate.tenantId, gate.userId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(gate.baseUrl),
    // Sessions are security state; never serve a stale list on re-focus.
    staleTime: 0,
    queryFn: (): Promise<AuthSessionInfo[]> => {
      if (!gate.baseUrl) {
        throw new SessionsApiError("No workspace is connected.");
      }
      return loadAllSessions(gate.baseUrl);
    },
  });
}

export function useRevokeSession() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!gate.baseUrl) throw new SessionsApiError("No workspace is connected.");
      const res = await revokeSession(gate.baseUrl, id);
      if (res.error) {
        throw new SessionsApiError(
          res.error.status === 404
            ? "That device was already signed out."
            : res.error.message,
          res.error.code,
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [SESSIONS_QUERY_KEY] });
    },
  });
}

export function useLogoutOtherSessions() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!gate.baseUrl) throw new SessionsApiError("No workspace is connected.");
      const res = await logoutAllOtherSessions(gate.baseUrl);
      if (res.error) {
        throw new SessionsApiError(res.error.message, res.error.code);
      }
      const count = res.data?.revoked_count;
      return typeof count === "number" && Number.isFinite(count) ? count : 0;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [SESSIONS_QUERY_KEY] });
    },
  });
}
