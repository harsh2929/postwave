/**
 * usePasskeys — read/rename/delete the passkeys that can sign in as this user.
 *
 * MANAGEMENT ONLY. Enrollment needs a platform authenticator and a WebAuthn
 * ceremony validated against the server's RPOrigins, and the Expo app bundles
 * no passkey module — so it is genuinely out of reach here. Listing, renaming
 * and deleting are ordinary authenticated JSON calls that need no authenticator
 * at all, and treating the whole surface as unavailable meant a user who lost
 * the device holding a passkey could not remove that passkey from their phone.
 *
 * Mirrors useSessions: security state, so `staleTime: 0` — a stale list on a
 * security screen is worse than no list, because it invites a user to believe a
 * credential they see is a credential that still exists (or worse, that one they
 * cannot see is gone).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deletePasskey,
  listPasskeys,
  renamePasskey,
  type PasskeyCredential,
} from "@/api/passkeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export const PASSKEYS_QUERY_KEY = "auth-passkeys";

export class PasskeysApiError extends Error {
  readonly code?: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "PasskeysApiError";
    this.code = code;
  }
}

export type { PasskeyCredential };

export function usePasskeys() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [PASSKEYS_QUERY_KEY, gate.baseUrl, gate.tenantId, gate.userId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(gate.baseUrl),
    staleTime: 0,
    queryFn: async (): Promise<PasskeyCredential[]> => {
      if (!gate.baseUrl) {
        throw new PasskeysApiError("No workspace is connected.");
      }
      const res = await listPasskeys(gate.baseUrl);
      if (res.error) {
        throw new PasskeysApiError(res.error.message, res.error.code);
      }
      return res.data ?? [];
    },
  });
}

export function useDeletePasskey() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!gate.baseUrl) {
        throw new PasskeysApiError("No workspace is connected.");
      }
      const res = await deletePasskey(gate.baseUrl, id);
      if (res.error) {
        throw new PasskeysApiError(
          res.error.status === 404
            ? "That passkey was already removed."
            : res.error.message,
          res.error.code,
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [PASSKEYS_QUERY_KEY] });
    },
  });
}

export function useRenamePasskey() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string }): Promise<void> => {
      if (!gate.baseUrl) {
        throw new PasskeysApiError("No workspace is connected.");
      }
      const res = await renamePasskey(gate.baseUrl, input.id, input.name);
      if (res.error) {
        throw new PasskeysApiError(res.error.message, res.error.code);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [PASSKEYS_QUERY_KEY] });
    },
  });
}
