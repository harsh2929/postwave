/**
 * hooks/useChatIntegrations.ts — the three notification channels, as one list.
 *
 * Every route is ScopeAdmin (collaboration_integrations.go:36-61), so the query is
 * role-gated: asking as a viewer spends three requests to collect three 403s and
 * then renders "no channels", which is a different and wrong claim.
 *
 * The three providers are fetched together and flattened, because the operator's
 * question is "are my alerts getting through", not "how is Discord specifically".
 * A provider that errors contributes nothing rather than failing the whole list —
 * one broken provider must not hide the other two.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  CHAT_PROVIDERS,
  fetchChatChannels,
  setChatChannelActive,
  testChatChannel,
  type ChatChannel,
} from "@/api/chatIntegrations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { foldChatChannelResults } from "@/lib/chatChannels";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const KEY = "chat-integrations";

export function useChatChannels() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      canAccessMinimumRole("admin", gate.effectiveRole),
    staleTime: 60_000,
    queryFn: async (): Promise<ChatChannel[]> => {
      const settled = await Promise.allSettled(
        CHAT_PROVIDERS.map((provider) => fetchChatChannels(provider)),
      );
      // Partial failure is absorbed; a TOTAL failure is rethrown so the query
      // reports isError instead of a successful empty list. See
      // `foldChatChannelResults` for why that difference matters.
      return foldChatChannelResults(settled);
    },
  });
}

export function useTestChatChannel() {
  return useMutation({
    mutationFn: (channel: ChatChannel) => testChatChannel(channel),
  });
}

export function useSetChatChannelActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { channel: ChatChannel; active: boolean }) =>
      setChatChannelActive(input.channel, input.active),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
