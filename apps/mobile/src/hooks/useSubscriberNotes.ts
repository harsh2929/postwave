/**
 * useSubscriberNotes — operator memos on a subscriber (SUB-097).
 *
 *   GET    /api/v1/subscribers/{id}/notes           viewer
 *   POST   /api/v1/subscribers/{id}/notes           editor
 *   DELETE /api/v1/subscribers/{id}/notes/{note}    editor
 *
 * (Role floors from apps/api/internal/routeauth/manifest.json — the
 * package's own `apikeys.RequireScope(ScopeAdmin)` guards API-KEY auth
 * only; a mobile SESSION follows the manifest.)
 *
 * Jotting "met at SaaStr, wants enterprise pricing" the minute the
 * conversation ends is the canonical reason to open a CRM on a phone, and
 * it was the one profile feature mobile had no code for at all.
 *
 * The server model is APPEND-ONLY: add and delete, never edit. Mobile
 * keeps that — a note is a dated statement of fact, and silently rewriting
 * one destroys the trail it exists to be.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  orderSubscriberNotes,
  parseSubscriberNotes,
  type SubscriberNote,
} from "@/lib/subscriberNotes";

export function subscriberNotesKey(
  tenantId: string | null | undefined,
  id: string | null | undefined,
): readonly unknown[] {
  return ["sub-notes", tenantId ?? null, id ?? null];
}

function notesPath(subscriberId: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/notes`;
}

export function useSubscriberNotes(id: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberNotesKey(gate.tenantId, id),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    queryFn: async (): Promise<SubscriberNote[]> => {
      const { client } = getClient();
      return orderSubscriberNotes(
        parseSubscriberNotes(
          await client.request<unknown>("GET", notesPath(id!)),
        ),
      );
    },
  });
}

export function useCreateSubscriberNote() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { id: string; body: string }) => {
      const { client } = getClient();
      // `markdown_body` is the field the server treats as the rich source;
      // it derives the plain `body` projection itself. Sending only `body`
      // would work but would store the note as legacy plain text.
      return client.request<unknown>("POST", notesPath(input.id), {
        body: { markdown_body: input.body.trim() },
      });
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: subscriberNotesKey(tenantId, input.id),
      });
    },
  });
}

export function useDeleteSubscriberNote() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { id: string; noteId: string }) => {
      const { client } = getClient();
      return client.request<unknown>(
        "DELETE",
        `${notesPath(input.id)}/${encodeURIComponent(input.noteId)}`,
      );
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: subscriberNotesKey(tenantId, input.id),
      });
    },
  });
}
