/**
 * hooks/useStoreConnectionActions.ts — the consequential half of the Stores
 * screen: confirm, write, say what happened.
 *
 * Split out of CommerceScreen the way useAssetActions is split out of the
 * assets route — the screen is a list with three reads under it, and the two
 * verbs here are the ones that change what the list SAYS about a store. Both
 * ask first (ConfirmSheet), because neither can be undone from the phone:
 * there is no un-pause route, and reconnecting a disconnected store is a
 * web-admin job.
 *
 * NOTHING HERE IS OPTIMISTIC OR QUEUED. A commerce write is never journalled
 * for later replay — the caller hides the buttons offline — and the card only
 * changes when the invalidated list comes back with the server's status.
 */
import { useCallback, useState } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  useDisconnectCommerceStore,
  usePauseCommerceStore,
} from "@/hooks/useCommerceConnection";
import {
  commerceDisconnectErrorMessage,
  commercePauseErrorMessage,
  disconnectConfirmCopy,
  pauseConfirmCopy,
  storeConnectionName,
  type DisconnectOutcome,
} from "@/lib/commerceConnection";
import type { CommerceStore } from "@/lib/commerceRollup";
import { haptics } from "@/lib/haptics";

export interface StoreDisconnectReceipt {
  store: CommerceStore;
  result: DisconnectOutcome;
}

export interface StoreConnectionActions {
  pausingId: string | null;
  disconnectingId: string | null;
  pause: (store: CommerceStore) => Promise<void>;
  disconnect: (store: CommerceStore) => Promise<void>;
  /** The server's answer to the most recent disconnect, until dismissed. */
  receipt: StoreDisconnectReceipt | null;
  dismissReceipt: () => void;
}

export function useStoreConnectionActions(): StoreConnectionActions {
  const { toast } = useToast();
  const confirm = useConfirm();
  const pauseAsync = usePauseCommerceStore().mutateAsync;
  const disconnectAsync = useDisconnectCommerceStore().mutateAsync;
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StoreDisconnectReceipt | null>(null);

  const pause = useCallback(
    async (store: CommerceStore) => {
      const copy = pauseConfirmCopy(store);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        consequence: copy.consequence,
      });
      if (!ok) return;
      setPausingId(store.id);
      haptics.tap();
      try {
        await pauseAsync(store.id);
        haptics.success();
        toast({
          kind: "success",
          message: `${storeConnectionName(store)} paused.`,
        });
      } catch (err) {
        haptics.error();
        toast({ kind: "error", message: commercePauseErrorMessage(err) });
      } finally {
        setPausingId(null);
      }
    },
    [confirm, pauseAsync, toast],
  );

  const disconnect = useCallback(
    async (store: CommerceStore) => {
      const copy = disconnectConfirmCopy(store);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        consequence: copy.consequence,
        destructive: true,
      });
      if (!ok) return;
      setDisconnectingId(store.id);
      haptics.tap();
      try {
        const result = await disconnectAsync(store.id);
        haptics.success();
        toast({
          kind: "success",
          message: `${storeConnectionName(store)} marked disconnected.`,
        });
        setReceipt({ store, result });
      } catch (err) {
        haptics.error();
        toast({ kind: "error", message: commerceDisconnectErrorMessage(err) });
      } finally {
        setDisconnectingId(null);
      }
    },
    [confirm, disconnectAsync, toast],
  );

  const dismissReceipt = useCallback(() => setReceipt(null), []);

  return {
    pausingId,
    disconnectingId,
    pause,
    disconnect,
    receipt,
    dismissReceipt,
  };
}
