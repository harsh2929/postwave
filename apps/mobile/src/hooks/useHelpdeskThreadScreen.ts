/**
 * hooks/useHelpdeskThreadScreen.ts — everything the Helpdesk thread screen
 * decides, lifted out of `app/(tabs)/helpdesk/[id].tsx`.
 *
 * The screen carries three versioned writes (assign/unassign, status change,
 * internal note), a durable note-intent journal, a bounded-history window and
 * five separate "we could not verify this" disclosures. Folding that into the
 * component body pushed it past the FUNCTION line and complexity budgets, so
 * the cut is the state/JSX seam: this file owns what the thread KNOWS, the
 * component and its three render pieces own what it LOOKS LIKE.
 *
 * Nothing here is new logic. Every guard, every message and every ordering
 * decision is the one the screen already made.
 */
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlatList } from "react-native";

import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import {
  useHelpdeskAccess,
  useHelpdeskAssignment,
  useHelpdeskCatalog,
  useHelpdeskConversation,
  useHelpdeskInternalNote,
  useHelpdeskStatusChange,
  useHelpdeskThread,
} from "@/hooks/useHelpdesk";
import { useHelpdeskThreadWrites } from "@/hooks/useHelpdeskThreadWrites";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  helpdeskClaimAction,
  helpdeskClaimLabel,
  mergeHelpdeskMessagePages,
  normalizeHelpdeskId,
} from "@/lib/helpdesk";
import {
  HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY,
  HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY,
  inspectHelpdeskNoteIntent,
  type HelpdeskNoteIntentInspection,
  type HelpdeskNoteIntentScope,
} from "@/lib/helpdeskNoteIntentStore";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function useHelpdeskThreadScreen() {
  const focused = useIsFocused();
  const access = useHelpdeskAccess(focused);
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const rawId = firstParam(params.id);
  const id = normalizeHelpdeskId(rawId) ?? "";
  const requestAccess = useMemo(
    () => ({ ...access, canRequest: access.canRequest && Boolean(id) }),
    [access, id],
  );
  useScreenViewed("helpdesk-thread");
  useRecordLastViewed(
    "helpdesk-conversation",
    requestAccess.canRequest && id ? id : "",
  );

  const conversation = useHelpdeskConversation(id, requestAccess);
  const thread = useHelpdeskThread(id, requestAccess);
  const catalog = useHelpdeskCatalog(requestAccess);
  const note = useHelpdeskInternalNote(id, requestAccess);
  const statusChange = useHelpdeskStatusChange(id, requestAccess);
  const assignment = useHelpdeskAssignment(id, requestAccess);
  const refresh = useRefreshControl(
    { isRefetching: thread.isRefetching, refetch: thread.refreshLatest },
    conversation,
    catalog,
  );

  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState<HelpdeskNoteIntentInspection>({
    status: "none",
  });
  const [intentError, setIntentError] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const didInitialScroll = useRef(false);
  const identityFingerprint = requestAccess.identity?.fingerprint ?? null;
  const noteRecoveryPrincipal =
    requestAccess.identity?.noteRecoveryPrincipal ?? null;
  const noteScope = useMemo<HelpdeskNoteIntentScope | null>(
    () =>
      noteRecoveryPrincipal && id
        ? { recoveryPrincipal: noteRecoveryPrincipal, conversationId: id }
        : null,
    [id, noteRecoveryPrincipal],
  );
  const noteScopeRef = useRef(noteScope);
  noteScopeRef.current = noteScope;

  useEffect(() => {
    setDraft("");
    setIntentError(null);
    didInitialScroll.current = false;
  }, [
    identityFingerprint,
    id,
    requestAccess.roleAllowed,
    requestAccess.sessionReady,
  ]);

  const inspectIntent = useCallback(async () => {
    if (!noteScope) {
      if (noteScopeRef.current === null) setIntent({ status: "none" });
      return;
    }
    try {
      const next = await inspectHelpdeskNoteIntent(noteScope);
      if (noteScopeRef.current !== noteScope) return;
      setIntent(next);
      setIntentError(null);
    } catch {
      if (noteScopeRef.current !== noteScope) return;
      setIntentError(
        "Internal-note recovery storage could not be verified. New notes are blocked to prevent duplicates.",
      );
    }
  }, [noteScope]);

  useEffect(() => {
    void inspectIntent();
  }, [inspectIntent]);

  const merged = useMemo(() => {
    if (!thread.data) return { messages: [], error: null };
    try {
      return {
        messages: mergeHelpdeskMessagePages(thread.data.pages),
        error: null,
      };
    } catch (error) {
      return { messages: [], error };
    }
  }, [thread.data]);
  const olderHistoryLoaded = (thread.data?.pages.length ?? 0) > 1;
  const resource = conversation.data ?? null;
  const row = resource?.conversation ?? null;
  const catalogStatuses = useMemo(
    () => (Array.isArray(catalog.data?.statuses) ? catalog.data.statuses : []),
    [catalog.data?.statuses],
  );
  const catalogVerified =
    !catalog.isError && Boolean(catalog.data) && catalogStatuses.length > 0;
  const claimAction = row
    ? helpdeskClaimAction(row, requestAccess.identity?.userId)
    : "none";
  const claimLabel = helpdeskClaimLabel(claimAction);
  const noteBlocked =
    Boolean(intentError) ||
    !resource ||
    intent.status === "principal_capacity_reached" ||
    intent.status === "device_capacity_reached";
  const noteDisabledReason = intentError
    ? intentError
    : !resource
      ? "The conversation and its current server revision must be verified before recording a note."
      : intent.status === "principal_capacity_reached"
        ? `This account already holds ${HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY} unresolved internal-note recovery keys on this device. Reconcile an originating thread before recording another note.`
        : intent.status === "device_capacity_reached"
          ? `This device already holds ${HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY} unresolved internal-note recovery keys across signed-in accounts. Reconcile an originating thread before recording another note.`
          : !requestAccess.online
            ? "You are offline. Internal notes are never queued."
            : !requestAccess.sessionReady
              ? "Helpdesk is waiting for a verified session and context epoch."
              : null;

  const { onClaim, onSaveNote, onStatus } = useHelpdeskThreadWrites({
    assignment,
    catalogStatuses,
    catalogVerified,
    claimAction,
    draft,
    id,
    inspectIntent,
    note,
    noteBlocked,
    noteScope,
    resource,
    row,
    setDraft,
    statusChange,
  });

  return {
    access,
    assignment,
    catalog,
    catalogStatuses,
    catalogVerified,
    claimLabel,
    conversation,
    didInitialScroll,
    draft,
    id,
    intent,
    listRef,
    merged,
    note,
    noteBlocked,
    noteDisabledReason,
    olderHistoryLoaded,
    onClaim,
    onSaveNote,
    onStatus,
    refresh,
    requestAccess,
    row,
    resource,
    setDraft,
    statusChange,
    thread,
  };
}

export type HelpdeskThreadController = ReturnType<
  typeof useHelpdeskThreadScreen
>;
