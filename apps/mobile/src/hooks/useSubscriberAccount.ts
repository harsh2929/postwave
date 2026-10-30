/**
 * useSubscriberAccount — the account directory (lazy, viewer) and the two
 * writes (set/clear the link; create-and-link). Online-only: the FK edit is
 * conditional on the profile revision and must 412 rather than replay.
 * Settling invalidates the subscriber root — account_id lives on the
 * detail row this card reads it from.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAccount,
  listAccounts,
  setSubscriberAccount,
} from "@/api/subscribersAccount";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import { parseAccounts, type AccountRow } from "@/lib/subscriberAccount";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";

export function accountsDirectoryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["accounts-directory", tenantId ?? null];
}

export function useAccountsDirectory(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: accountsDirectoryKey(gate.tenantId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<AccountRow[]> =>
      parseAccounts(await listAccounts()),
  });
}

export function useSubscriberAccountWrites(subscriberId: string) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();

  const settle = () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({
      queryKey: subscriberQueryRootKey(tenantId),
    });
    void queryClient.invalidateQueries({
      queryKey: accountsDirectoryKey(tenantId),
    });
  };

  const setAccount = useMutation({
    mutationFn: (input: { accountId: string | null; version: string }) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        setSubscriberAccount(subscriberId, input.accountId, input.version),
      ),
    onSettled: settle,
  });

  /** Desktop's create-and-link-in-one-go, as two conditional steps. */
  const createAndLink = useMutation({
    mutationFn: async (input: {
      body: Record<string, string>;
      version: string;
    }) => {
      const created = await createAccount(input.body);
      return subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        setSubscriberAccount(subscriberId, created.id, input.version),
      );
    },
    onSettled: settle,
  });

  return { setAccount, createAndLink };
}
