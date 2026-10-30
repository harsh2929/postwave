/**
 * hooks/useInboxRealityTests.ts — running seed-list tests, and the brake.
 *
 * List is `viewer`, cancel is `editor` (both reviewed). Only LIVE tests are worth a
 * phone's attention: a finished placement report is a desk read, while a test still
 * holding seed-mailbox capacity is a resource somebody may need to release.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  inboxRealityTestIsLive,
  parseInboxRealityTests,
  type InboxRealityTest,
} from "@/lib/inboxRealityTests";

const KEY = "inbox-reality-tests";

export function useInboxRealityTests() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 10_000,
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (!Array.isArray(rows)) return false;
      return rows.some((row) => inboxRealityTestIsLive(row.status)) ? 10_000 : false;
    },
    queryFn: async (): Promise<InboxRealityTest[]> => {
      const res = await rawRequest<unknown>(
        "GET",
        "/api/v1/inbox-reality/tests?limit=25",
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseInboxRealityTests(res.data);
    },
  });
}

export function useCancelInboxRealityTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const testId = id.trim();
      if (!testId) throw new Error("test id is required");
      const res = await rawRequest<unknown>(
        "POST",
        `/api/v1/inbox-reality/tests/${encodeURIComponent(testId)}/cancel`,
        {},
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
