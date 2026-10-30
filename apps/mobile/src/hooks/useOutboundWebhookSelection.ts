/**
 * hooks/useOutboundWebhookSelection.ts — the outbound Webhooks screen's
 * selection mode and the three bulk verbs it carries: pause, resume, delete.
 *
 * Long-press a row to enter it; tap rows to add and remove; Done to leave —
 * the convention the campaigns list uses (hooks/useCampaignSelection), and
 * the only one that works without the header checkbox column desktop's bulk
 * toolbar is built around (pages/OutboundWebhooks.tsx `useCanonicalBulkActions`).
 *
 * The hook owns the selection, every guard, and the fan-out, so
 * app/(tabs)/webhooks.tsx stays a readable state ladder. The rules —
 * which verb applies to which row, who may fire one, what the operator is
 * told afterwards — live in lib/outboundWebhookSelection and
 * lib/outboundWebhookBulkRun, where node vitest can reach them.
 *
 * WHO MAY ENTER. Every route a bulk verb reaches is admin in
 * routeauth/manifest.json, so the long-press is withheld below admin (and in
 * API-key mode) rather than offered and then 403'd once per row. The role
 * reason inside `bulkWebhookAvailability` stays as the second line of
 * defence should the session's role change mid-selection.
 *
 * Writes go straight through api/outboundWebhooks / api/settings and the
 * caches are invalidated ONCE at the end, not per row: N rows through the
 * per-row mutations in useOutboundWebhookActions would fire 3N invalidations
 * and refetch the list under the loop.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  reEnableOutboundWebhook,
  setOutboundWebhookActive,
} from "@/api/outboundWebhooks";
import { deleteOutboundWebhook, type OutboundWebhook } from "@/api/settings";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import type { WebhookBulkVerb } from "@/components/webhooks/OutboundWebhookSelectionBar";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  retainAfterBulkRun,
  runBulkWebhookVerb,
  type BulkWebhookRunners,
} from "@/lib/outboundWebhookBulkRun";
import {
  BULK_WEBHOOK_VERBS,
  bulkWebhookAvailability,
  bulkWebhookBusyLabel,
  bulkWebhookConfirmCopy,
  bulkWebhookOutcomeMessage,
  partitionForVerb,
  pruneWebhookSelection,
  selectedWebhooks,
  toggleWebhookSelection,
  verbBlockedReason,
  type BulkWebhookVerb,
} from "@/lib/outboundWebhookSelection";
import { useAuthStore } from "@/store/auth";

const VERB_LABELS: Readonly<Record<BulkWebhookVerb, string>> = {
  pause: "Pause",
  resume: "Resume",
  delete: "Delete",
};

export interface OutboundWebhookSelectionController {
  active: boolean;
  selected: string[];
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Long-press handler: enters selection mode with that row already picked. */
  begin: (id: string) => void;
  exit: () => void;
  verbs: WebhookBulkVerb[];
  /** "Pausing 3 of 12…" while the loop runs; null otherwise. */
  busyLabel: string | null;
  /** True while a bulk verb is in flight — single-row actions lock on it. */
  running: boolean;
  /** Admin in session mode. False withholds the long-press entirely. */
  canSelect: boolean;
}

/**
 * The cache roots every outbound view hangs off — the endpoint list
 * ("outbound-webhooks"), the global feed, the per-endpoint health rollup and
 * the per-endpoint history — all start with this string and carry the tenant
 * second. Matched positionally by predicate because they are distinct first
 * elements, not one shared prefix TanStack could match for us.
 */
const OUTBOUND_KEY_ROOT = "outbound-webhook";

export function useOutboundWebhookSelection(input: {
  /** Every endpoint row currently loaded. Verbs act only on these. */
  visible: readonly OutboundWebhook[];
}): OutboundWebhookSelectionController {
  const { visible } = input;
  const { toast } = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const online = useIsOnline();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);

  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState<BulkWebhookVerb | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const runningRef = useRef(false);

  const canSelect = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const visibleIds = useMemo(() => visible.map((w) => w.id), [visible]);

  // A refetch after a bulk delete removes rows; without this the bar's count
  // disagrees with the highlighted rows and the next verb fires at something
  // nobody can see.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneWebhookSelection(prev, visibleIds);
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  const rows = useMemo(() => selectedWebhooks(visible, selected), [visible, selected]);

  const exit = useCallback(() => {
    setActive(false);
    setSelected([]);
  }, []);

  const begin = useCallback((id: string) => {
    haptics.impact();
    setActive(true);
    setSelected([id]);
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = toggleWebhookSelection(prev, id);
      // Deselecting the last row leaves selection mode rather than stranding
      // an empty bar whose every verb is disabled.
      if (next.length === 0) setActive(false);
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selected.includes(id), [selected]);

  const availability = useMemo(
    () =>
      bulkWebhookAvailability({
        count: selected.length,
        hasAdminRole: canSelect,
        online,
        gated: !gate.enabled,
      }),
    [canSelect, gate.enabled, online, selected.length],
  );

  const runners = useMemo<BulkWebhookRunners>(
    () => ({
      pause: (id) => setOutboundWebhookActive(id, false),
      // Re-enable, not PATCH {active:true}: it is right for a human-paused
      // row AND an auto-disabled one (lib/outboundWebhookSelection has why).
      resume: (id) => reEnableOutboundWebhook(id),
      delete: async (id) => {
        const res = await deleteOutboundWebhook(id);
        // The settings client returns the {data, error} envelope rather than
        // throwing; the loop needs a rejection carrying the server's words.
        if (res.error) throw new Error(res.error.message || "");
      },
    }),
    [],
  );

  const invalidateOutbound = useCallback(() => {
    void qc.invalidateQueries({
      predicate: (query) => {
        const [root, tenant] = query.queryKey;
        return (
          typeof root === "string" &&
          root.startsWith(OUTBOUND_KEY_ROOT) &&
          (tenant ?? null) === (gate.tenantId ?? null)
        );
      },
    });
  }, [gate.tenantId, qc]);

  const run = useCallback(
    async (verb: BulkWebhookVerb) => {
      if (runningRef.current) return;
      const partition = partitionForVerb(rows, verb);
      if (partition.applicable.length === 0) return;
      const copy = bulkWebhookConfirmCopy(verb, partition);
      if (copy) {
        const ok = await confirm({
          title: copy.title,
          message: copy.message,
          confirmLabel: copy.confirmLabel,
          destructive: copy.destructive,
          ...(copy.consequence ? { consequence: copy.consequence } : {}),
        });
        if (!ok) return;
      }
      runningRef.current = true;
      setRunning(verb);
      setProgress({ done: 0, total: partition.applicable.length });
      let outcome;
      try {
        outcome = await runBulkWebhookVerb(verb, rows, runners, (done, total) =>
          setProgress({ done, total }),
        );
      } finally {
        runningRef.current = false;
        setRunning(null);
        setProgress(null);
        invalidateOutbound();
      }
      const message = bulkWebhookOutcomeMessage(verb, outcome);
      const retained = retainAfterBulkRun(outcome);
      if (retained.length === 0) {
        haptics.success();
        toast({ kind: "success", message });
        exit();
        return;
      }
      // Failures stay selected so the next tap retries exactly them.
      haptics.warning();
      toast({
        kind: outcome.succeeded.length > 0 ? "warning" : "error",
        message,
      });
      setSelected(retained);
    },
    [confirm, exit, invalidateOutbound, rows, runners, toast],
  );

  const verbs = useMemo<WebhookBulkVerb[]>(
    () =>
      BULK_WEBHOOK_VERBS.map((verb) => ({
        key: verb,
        label: VERB_LABELS[verb],
        onPress: () => void run(verb),
        blockedReason: verbBlockedReason(verb, rows, availability),
        ...(verb === "delete" ? { destructive: true } : {}),
      })),
    [availability, rows, run],
  );

  const busyLabel =
    running && progress
      ? bulkWebhookBusyLabel(running, progress.done, progress.total)
      : null;

  return {
    active,
    selected,
    isSelected,
    toggle,
    begin,
    exit,
    verbs,
    busyLabel,
    running: running !== null,
    canSelect,
  };
}
