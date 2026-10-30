/**
 * AudienceDestinationsPanel — audience destinations, inside the integrations hub.
 *
 * WHY IT IS A PANEL AND NOT A THIRD `CONNECTION_FAMILIES` ENTRY. That table
 * models a verb set over an already-connected row. Destinations do not fit:
 * creating one takes a provider, a list or segment, an external audience id and
 * an opaque `config` blob, which is authoring rather than a verb.
 *
 * WHY IT EXISTS AT ALL. `capabilityCoverage.ts` recorded this capability as
 * living INSIDE the integrations screen while that screen never mentioned it —
 * a coverage table asserting something mobile did not ship. This is the panel
 * that makes the entry true.
 *
 * WHAT IT OFFERS. Pause, resume and disconnect. Not create, not `config`
 * editing: authoring an opaque provider blob on a phone keyboard is how a
 * destination ends up pointed at the wrong ad audience, and
 * `lib/stoppingHalfPolicy.ts` already settles that shape. Resume is included
 * because it is not the STARTING half — it restores a configuration a human
 * already made at a desk.
 *
 * SINCE THE 2026-08 PARITY PASS (P2.41 / P2.42) the history sheet also carries
 * sync-now (editor floor, online-only, confirm-gated) and a tap-through from a
 * failed job row to the provider's own diagnostics. The pure decisions behind
 * both — the job → row mapping, the open-job toggle, the refusal sentences —
 * live in `lib/audienceDestinationJobSheet.ts` so vitest can reach them.
 *
 * Reads are viewer-floored and mutations are admin, so a non-admin sees the
 * rows and no controls: a destination quietly pushing a stale segment into a
 * live ad audience is worth seeing regardless of who may stop it.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { DestinationSyncJobsSheet } from "@/components/integrations/DestinationSyncJobsSheet";
import { PanelLoadFailure } from "@/components/integrations/PanelLoadFailure";
import {
  useAudienceDestinations,
  useDestinationJobDiagnostics,
  useDestinationPreview,
  useDestinationSyncJobs,
  useDisconnectDestination,
  useSetDestinationStatus,
  useSyncDestinationNow,
} from "@/hooks/useAudienceDestinations";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  newDestinationSyncKey,
  syncNowResultMessage,
} from "@/lib/audienceDestinationActions";
import {
  diagnosticsErrorMessage,
  jobsFromQueryData,
  syncNowRefusal,
  toggleOpenJobId,
} from "@/lib/audienceDestinationJobSheet";
import {
  destinationSummary,
  destinationTone,
  type AudienceDestination,
} from "@/lib/audienceDestinationRows";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AudienceDestinationsPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  // OS reachability, separate from the auth gate: sync-now is online-only by
  // construction, and the gate alone cannot say whether the radio is up.
  const online = useIsOnline();
  const query = useAudienceDestinations();
  const setStatus = useSetDestinationStatus();
  const disconnect = useDisconnectDestination();
  // The OPEN DESTINATION is the sheet's visibility state, and it is held as an
  // id rather than a row so the sheet re-reads the row every render: a status
  // that changed under the sheet (pause, or a sync that just failed) must not
  // keep rendering the snapshot the tap captured.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // Both are PER-OPEN state: the preview is press-driven and a tapped job
  // belongs to one destination's history, so closing the sheet resets them.
  const [previewRequested, setPreviewRequested] = useState(false);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const jobsQuery = useDestinationSyncJobs(historyFor);
  const previewQuery = useDestinationPreview(historyFor, previewRequested);
  const diagnosticsQuery = useDestinationJobDiagnostics(historyFor, openJobId);
  const syncNow = useSyncDestinationNow();

  const rows = Array.isArray(query.data) ? query.data : [];
  const openRow = rows.find((row) => row.id === historyFor) ?? null;
  const jobs = jobsFromQueryData(jobsQuery.data);
  // isError FIRST: a destination quietly pushing a stale segment into a live ad
  // audience is exactly what this panel exists to surface, and hiding the whole
  // section on a failed read reported it as "no destinations configured".
  if (query.isError) {
    return (
      <PanelLoadFailure
        title="Audience destinations"
        subject="audience destinations"
      />
    );
  }
  if (rows.length === 0) return null;

  const mayAct = canAccessMinimumRole("admin", gate.effectiveRole);
  // Sync-now is `ScopeWriteSubscribers` (handlers.go:68-69) — editor floor on
  // the session path, a DIFFERENT floor from pause/disconnect. An editor who
  // cannot reconfigure a destination can still re-push it after a failure,
  // which is exactly the latency verb this panel was missing.
  const maySync = canAccessMinimumRole("editor", gate.effectiveRole);

  const closeSheet = () => {
    setHistoryFor(null);
    setPreviewRequested(false);
    setOpenJobId(null);
  };

  const onSyncNow = async (row: AudienceDestination) => {
    if (syncNow.isPending) return;
    // Refused BEFORE the confirm: an offline push cannot be queued (it would
    // land at a moment nobody chose), so the reason is stated up front rather
    // than surfacing as a transport error after the operator said yes.
    const refusal = syncNowRefusal({ online, provider: row.provider });
    if (refusal) {
      haptics.error();
      toast({ kind: "error", message: refusal });
      return;
    }
    haptics.tap();
    const ok = await confirm({
      title: `Push ${row.provider} now?`,
      message:
        "Delivers the current audience to the destination straight away. Anyone without consent for this destination's purpose is withheld.",
      confirmLabel: "Sync now",
      destructive: false,
    });
    if (!ok) return;
    haptics.impact();
    try {
      // THE TRAP: the server answers 202 for success, failure and cap
      // rejection alike — the outcome is read off the returned status, never
      // off the promise resolving (see lib/audienceDestinationActions).
      const result = await syncNow.mutateAsync({
        id: row.id,
        idempotencyKey: newDestinationSyncKey(row.id),
      });
      const outcome = syncNowResultMessage(result, row.provider);
      if (outcome.kind === "success") haptics.success();
      else haptics.error();
      toast({ kind: outcome.kind, message: outcome.message });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          errorPresentation(error).message ||
          `The push to ${row.provider} was not started.`,
      });
    }
  };

  const onPauseResume = (row: AudienceDestination) => {
    haptics.tap();
    const next = row.status === "paused" ? "active" : "paused";
    setStatus.mutate(
      { id: row.id, status: next },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message:
              next === "paused"
                ? `Paused ${row.provider}. Nothing more is pushed until you resume it.`
                : `Resumed ${row.provider}.`,
          }),
        onError: (err) =>
          toast({
            kind: "error",
            message:
              errorPresentation(err).message ||
              `Couldn't ${next === "paused" ? "pause" : "resume"} ${row.provider}.`,
          }),
      },
    );
  };

  const onDisconnect = async (row: AudienceDestination) => {
    haptics.tap();
    const ok = await confirm({
      title: `Disconnect ${row.provider}?`,
      message:
        "Syncing stops immediately and the destination is removed. Re-creating it is done from the web admin, not from here.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    disconnect.mutate(row.id, {
      onSuccess: () =>
        toast({ kind: "success", message: `Disconnected ${row.provider}.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            `Couldn't disconnect ${row.provider}.`,
        }),
    });
  };

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Audience destinations
      </Text>
      {rows.map((row) => (
        <View
          key={row.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {row.provider || "Destination"}
            </Text>
            <Pill label={row.status} tone={destinationTone(row.status)} />
          </View>
          <Text
            {...typeCap("caption")}
            style={{ color: t.fgMuted, ...typeStyle("caption") }}
          >
            {destinationSummary(row)}
          </Text>
          {/* Outside the `mayAct` gate on purpose: GET /{id}/jobs is
              ScopeReadReports, the same floor as the list, and the reason a
              destination stopped delivering is exactly what a viewer needs in
              order to tell someone who CAN fix it. */}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sync history for ${row.provider || "this destination"}`}
              accessibilityHint="Shows the recent sync attempts and why any of them failed"
              testID={`destination-${row.id}-history`}
              onPress={() => {
                haptics.tap();
                setHistoryFor(row.id);
              }}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: t.borderSubtle,
              }}
            >
              <Text {...typeCap("caption")} style={{ color: t.fg }}>
                Sync history
              </Text>
            </Pressable>
          </View>
          {mayAct ? (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${row.status === "paused" ? "Resume" : "Pause"} ${row.provider}`}
                testID={`destination-${row.id}-toggle`}
                onPress={() => onPauseResume(row)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: t.borderSubtle,
                }}
              >
                <Text {...typeCap("caption")} style={{ color: t.fg }}>
                  {row.status === "paused" ? "Resume" : "Pause"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${row.provider}`}
                testID={`destination-${row.id}-disconnect`}
                onPress={() => void onDisconnect(row)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: t.borderSubtle,
                }}
              >
                <Text {...typeCap("caption")} style={{ color: t.danger }}>
                  Disconnect
                </Text>
              </Pressable>
            </View>
          ) : (
            <Text
              {...typeCap("caption")}
              style={{ color: t.fgMuted, ...typeStyle("caption") }}
            >
              Read-only for your role.
            </Text>
          )}
        </View>
      ))}
      <DestinationSyncJobsSheet
        destination={openRow}
        jobs={jobs}
        jobsQuery={jobsQuery}
        gate={gate}
        now={Date.now()}
        onClose={closeSheet}
        syncNow={
          maySync && openRow
            ? {
                busy: syncNow.isPending,
                onPress: () => void onSyncNow(openRow),
              }
            : undefined
        }
        preview={{
          requested: previewRequested,
          onRequest: () => setPreviewRequested(true),
          data: previewQuery.data ?? null,
          query: previewQuery,
        }}
        diagnostics={{
          openJobId,
          onToggleJob: (jobId) =>
            setOpenJobId((current) => toggleOpenJobId(current, jobId)),
          data: diagnosticsQuery.data ?? null,
          query: diagnosticsQuery,
          errorMessage: diagnosticsErrorMessage(diagnosticsQuery.error),
        }}
      />
    </View>
  );
}
