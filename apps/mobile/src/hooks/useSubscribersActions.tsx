/**
 * useSubscribersActions — everything the subscribers LIST can *do*, in one
 * place: who may bulk-act, who may create, the multi-select controller, and
 * the create flow with its receipt.
 *
 * It exists because the two capabilities have DIFFERENT authorization and
 * putting them side by side is the only way that stays visible:
 *
 *   bulk verbs  POST /subscribers/bulk/*  RequireScope(ScopeAdmin)
 *               → owner|admin only (ScopeAdmin is in neither readOnlyScopes
 *                 nor editorWriteScopes)
 *   create      POST /subscribers         RequireScope(ScopeWriteSubscribers)
 *               → owner|admin|editor (write:subscribers IS an editor scope)
 *
 * An earlier version of this screen would have gated both on one flag, which
 * either hides create from the editors who are allowed it or offers bulk to
 * editors who will get a 403.
 */
import { useCallback, useMemo, useState } from "react";
import type { ListRenderItem } from "react-native";

import { useToast } from "@/components/Toast";
import { useCreateSubscriber } from "@/hooks/useCreateSubscriber";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useSubscriberBulkPaste } from "@/hooks/useSubscriberBulkPaste";
import { useSubscriberSelection } from "@/hooks/useSubscriberSelection";
import {
  SubscriberRow,
  type SubscriberListRow,
} from "@/components/subscriber/SubscriberRow";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  bulkPasteFailedRows,
  bulkPasteReceipt,
  type BulkPasteResult,
} from "@/lib/subscriberBulkPaste";
import {
  UNCONFIRMED_CREATE_NOTICE,
  type SubscriberDraft,
} from "@/lib/subscriberDraft";
import { BULK_MINIMUM_ROLE } from "@/lib/subscriberSelection";
import { useAuthStore } from "@/store/auth";

export function useSubscribersActions(input: {
  rows: readonly SubscriberListRow[];
  /** True when the session is cached/stale — no writes at all. */
  gated: boolean;
  effectiveRole: string | null;
  /** The current search term; seeds the create sheet when it is an address. */
  searchTerm: string;
  /** Row swipe action. Withdrawn automatically while selecting. */
  onSuppress: (row: SubscriberListRow) => void;
}) {
  const { toast } = useToast();
  const online = useIsOnline();
  const authMode = useAuthStore((s) => s.mode);

  // Rows the server sent without an id cannot join a bulk audience, so they
  // are excluded here as well as in the row component.
  const loadedIds = useMemo(
    () => input.rows.map((row) => row.id).filter((id): id is string => Boolean(id)),
    [input.rows],
  );

  const hasBulkRole = canAccessMinimumRole(
    BULK_MINIMUM_ROLE,
    input.effectiveRole,
    authMode,
  );
  const canCreate =
    canAccessMinimumRole("editor", input.effectiveRole, authMode) && !input.gated;

  // The Validate verb works on ADDRESSES; the selection holds ids. Resolve
  // against the rows on screen — the same rows the ids were picked from.
  const rows = input.rows;
  const emailsForIds = useCallback(
    (ids: readonly string[]) => {
      const byId = new Map(
        rows.flatMap((row) => (row.id ? [[row.id, row.email] as const] : [])),
      );
      const emails: string[] = [];
      let skipped = 0;
      for (const id of ids) {
        const email = byId.get(id);
        if (email) emails.push(email);
        else skipped += 1;
      }
      return { emails, skipped };
    },
    [rows],
  );

  const selection = useSubscriberSelection({
    loadedIds,
    hasAdminRole: hasBulkRole,
    online,
    gated: input.gated,
    emailsForIds,
  });

  const create = useCreateSubscriber();
  const bulkPaste = useSubscriberBulkPaste();
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkPasteResult, setBulkPasteResult] =
    useState<BulkPasteResult | null>(null);

  const openCreate = useCallback(() => {
    haptics.tap();
    setBulkPasteResult(null);
    setCreateOpen(true);
  }, []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);

  // The bulk-paste receipt policy: full success closes with the summary
  // toast; any failed address keeps the sheet OPEN with the per-row list —
  // a closed sheet plus a toast naming a count would lose WHICH addresses.
  const submitBulkPaste = useCallback(
    (input: { emails: string; tags: string[] }) => {
      bulkPaste.mutate(input, {
        onSuccess: (result) => {
          setBulkPasteResult(result);
          const receipt = bulkPasteReceipt(result);
          if (bulkPasteFailedRows(result).length === 0) {
            haptics.success();
            setCreateOpen(false);
            toast({
              kind: "success",
              message:
                result.created > 0
                  ? `${receipt} ${UNCONFIRMED_CREATE_NOTICE}`
                  : receipt,
            });
          } else {
            haptics.error();
            toast({ kind: "error", message: receipt });
          }
        },
        onError: (error: Error) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't add the pasted subscribers. ${error.message}`.trim(),
          });
        },
      });
    },
    [bulkPaste, toast],
  );

  const submitCreate = useCallback(
    (draft: SubscriberDraft) => {
      create.mutate(draft, {
        onSuccess: () => {
          haptics.success();
          setCreateOpen(false);
          // The receipt repeats the non-sendability clause: the operator has
          // just added someone and must not walk away believing they can be
          // mailed.
          toast({
            kind: "success",
            message: `${draft.email.trim()} added. ${UNCONFIRMED_CREATE_NOTICE}`,
          });
        },
        onError: (error: Error) => {
          haptics.error();
          toast({ kind: "error", message: error.message });
        },
      });
    },
    [create, toast],
  );

  // The row renderer lives here so it can close over the SPECIFIC pieces of
  // selection state it needs. Depending on the whole `selection` object would
  // give it a new identity every render and defeat SubscriberRow's memo — the
  // exact failure mode that makes a long list janky on every keystroke.
  const selecting = selection.active;
  const selectedIds = selection.ids;
  const beginSelect = selection.begin;
  const toggleSelect = selection.toggle;
  const onSuppress = input.onSuppress;
  const gated = input.gated;
  const renderRow = useCallback<ListRenderItem<SubscriberListRow>>(
    ({ item }) => (
      <SubscriberRow
        item={item}
        selecting={selecting}
        selected={Boolean(item.id) && selectedIds.includes(item.id as string)}
        {...(hasBulkRole
          ? { onToggleSelect: toggleSelect, onBeginSelect: beginSelect }
          : {})}
        {...(gated || selecting ? {} : { onSuppress })}
      />
    ),
    [
      beginSelect,
      gated,
      hasBulkRole,
      onSuppress,
      selectedIds,
      selecting,
      toggleSelect,
    ],
  );

  const term = input.searchTerm.trim();
  return {
    renderRow,
    loadedIds,
    hasBulkRole,
    canCreate,
    selection,
    createOpen,
    openCreate,
    closeCreate,
    submitCreate,
    createPending: create.isPending,
    submitBulkPaste,
    bulkPastePending: bulkPaste.isPending,
    bulkPasteResult,
    online,
    /** Only seed the address when the search term actually is one. */
    createInitialEmail: term.includes("@") ? term : "",
  };
}
