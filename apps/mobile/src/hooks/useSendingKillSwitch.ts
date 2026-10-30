/**
 * hooks/useSendingKillSwitch.ts — read and flip the tenant-wide email pause.
 *
 * Routes (apps/api/internal/server/sending_forms_routes.go:56,58,59):
 *   GET  /api/v1/sending/controls          ScopeReadReports  → any role may LOOK
 *   POST /api/v1/sending/controls/pause    ScopeAdmin        → admin may HALT
 *   POST /api/v1/sending/controls/resume   ScopeAdmin
 *
 * The read/write split is deliberate and worth preserving in the UI: a viewer
 * should be able to see that sending is held — otherwise they file a bug about a
 * campaign that "isn't going out" — while only an admin may change it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseSendingControl,
  type SendingControl,
  type SendingControlWire,
} from "@/lib/sendingKillSwitch";

const KEY = "sending-controls";

export function useSendingControls() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Short, because this is the answer to "is anything going out right now?" and a
    // stale "active" during an incident is the worst thing this card could show.
    staleTime: 10_000,
    queryFn: async (): Promise<SendingControl> => {
      const res = await rawRequest<SendingControlWire>(
        "GET",
        "/api/v1/sending/controls",
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseSendingControl(res.data);
    },
  });
}

export function useSetSendingPaused() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      paused: boolean;
      reason: string;
    }): Promise<SendingControl> => {
      const res = await rawRequest<SendingControlWire>(
        "POST",
        input.paused
          ? "/api/v1/sending/controls/pause"
          : "/api/v1/sending/controls/resume",
        { reason: input.reason.trim() },
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseSendingControl(res.data);
    },
    onSuccess: (control) => {
      // Seed rather than only invalidate: the operator has just halted a workspace
      // and needs the card to say so immediately, not after a refetch round trip.
      queryClient.setQueryData([KEY, gate.tenantId], control);
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      // The sending-settings screen's other reads describe the same subsystem.
      void queryClient.invalidateQueries({ queryKey: ["sending-status"] });
    },
  });
}
