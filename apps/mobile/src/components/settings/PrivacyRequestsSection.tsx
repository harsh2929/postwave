/**
 * PrivacyRequestsSection — queue a portable export and track request status.
 *
 * Lifted out of the 900-line Settings screen, and fixed on the way:
 *
 *  - REGION IS NO LONGER HARDCODED. Every export filed from mobile posted
 *    `region: "OTHER"` with no way to change it, so a GDPR-subject request was
 *    filed under the wrong regime and got the wrong regulatory due date — the
 *    same screen then rendered that wrong region and due date back at the user.
 *    The default is now derived from the workspace timezone and is visible and
 *    changeable before filing.
 *  - It joined the query layer. The list used a raw client.request inside a
 *    useEffect with three hand-rolled flags (loaded / error / rows) — no cache,
 *    no dedupe, no retry, no online gate, and no loading state at all: the
 *    pre-load copy was "Pull to refresh to load privacy requests", which reads
 *    as a permanent instruction rather than a spinner.
 *  - Success and failure are toasts, not modal Alerts. "Export request queued"
 *    does not deserve a focus-stealing dialog that costs a tap to dismiss.
 *  - IT IS NO LONGER A DEAD END. The inline list showed four rows in WIRE
 *    order and then said "+N more on the web admin", which on a workspace with
 *    real DSAR volume hid the one request that had blown its statutory
 *    deadline. The preview now leads with what is overdue and opens the full
 *    tenant queue — sorted by deadline, paged, and able to verify, hold, deny
 *    and appeal (see PrivacyRequestQueue).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { getWorkspaceSettings } from "@/api/settings";
import {
  listPrivacyRequests,
  loadPrivacyPortalSummary,
  PRIVACY_REGIONS,
  regionForTimezone,
  requestPrivacyExport,
  type PrivacyRegion,
  type PrivacyRequestRecord,
} from "@/api/settingsExtras";
import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { PrivacyRequestQueue } from "@/components/settings/PrivacyRequestQueue";
import {
  Card,
  FieldLabel,
  formatPrivacyLabel,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  parsePrivacyPosture,
  privacyPostureLine,
  resolvedPrivacyCounts,
} from "@/lib/privacyPosture";
import { dueLabel, sortQueue, summarizeQueue } from "@/lib/privacyQueue";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Rows previewed inline; the queue sheet holds every one of them. */
const VISIBLE_ROWS = 3;

export function PrivacyRequestsSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const { toast } = useToast();
  const [regionOverride, setRegionOverride] = useState<PrivacyRegion | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  const requests = useQuery({
    queryKey: ["privacy-requests", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<{
      rows: PrivacyRequestRecord[];
      truncated: boolean;
    }> => {
      const res = await listPrivacyRequests();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return {
        rows: res.data?.requests ?? [],
        // A cursor means there are more rows than this page — so any count
        // derived from it is a FLOOR, not a total.
        truncated: Boolean(res.data?.nextCursor),
      };
    },
    staleTime: 60_000,
  });

  /**
   * The authoritative overdue clock.
   *
   * The count derived from the loaded page is a floor: `listPrivacyRequests`
   * asks for 100 rows and a busier workspace has more. GET /privacy/portal
   * aggregates open/overdue in SQL over the whole table, so it is used when
   * available. It is ScopeAdmin and may be absent on older deployments, so a
   * failure is NOT surfaced as an error — the screen falls back to the page
   * count and says what it counted.
   */
  const posture = useQuery({
    queryKey: ["privacy-portal-posture", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await loadPrivacyPortalSummary();
      if (res.error) return null;
      return parsePrivacyPosture(res.data);
    },
  });

  // The workspace timezone is the only signal available for a sensible default
  // regime. Shares its key with WorkspaceSettingsSection's reads.
  const workspace = useQuery({
    queryKey: ["workspace-settings", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async () => {
      const res = await getWorkspaceSettings();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    staleTime: 5 * 60_000,
  });

  const region = useMemo(
    () => regionOverride ?? regionForTimezone(workspace.data?.timezone),
    [regionOverride, workspace.data?.timezone],
  );

  // Its own memo: a `?? []` inline would hand `summarizeQueue`'s memo a new
  // array identity on every render, defeating it entirely.
  const rows = useMemo(() => (Array.isArray(requests.data?.rows) ? requests.data?.rows : []), [requests.data?.rows]);
  // The preview now leads with the deadline, not the arrival order — an
  // overdue request three pages down was the whole problem with the old list.
  const summary = useMemo(() => summarizeQueue(rows, now), [rows, now]);
  const counts = useMemo(
    () =>
      resolvedPrivacyCounts({
        posture: posture.data ?? null,
        pageOpen: summary.open,
        pageOverdue: summary.overdue,
        pageTruncated: requests.data?.truncated ?? false,
      }),
    [posture.data, summary.open, summary.overdue, requests.data?.truncated],
  );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await requestPrivacyExport(region);
      if (res.error) {
        toast({
          kind: "error",
          message: "Couldn't queue the export. Check your connection.",
        });
        return;
      }
      haptics.success();
      toast({
        kind: "success",
        message: `Export queued under ${region}. Reference ${res.data?.request_id ?? "pending"}.`,
      });
      void requests.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <FieldLabel marginBottom={6}>Regulatory region</FieldLabel>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {PRIVACY_REGIONS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={region === option.value}
            accessibilityLabel={`${option.label}. ${option.hint}`}
            onPress={() => {
              haptics.tap();
              setRegionOverride(option.value);
            }}
          />
        ))}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        Region sets the statutory deadline the workspace is held to for this
        request.
      </Text>

      <Pressable
        onPress={() => void submit()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Request data export under ${region}`}
        accessibilityState={{ disabled: busy }}
        style={{
          marginTop: 12,
          minHeight: 44,
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          alignItems: "center",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {busy ? "Queuing…" : "Request data export"}
        </Text>
      </Pressable>

      <View style={{ marginTop: 12, gap: 8 }}>
        <RequestList
          rows={rows}
          now={now}
          isError={requests.isError}
          error={requests.error}
          isLoading={requests.isLoading}
          gateEnabled={gate.enabled}
          onRetry={() => void requests.refetch()}
        />
        {rows.length > 0 ? (
          <>
            <Pressable
              onPress={() => {
                haptics.tap();
                setQueueOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={
                counts.overdue > 0
                  ? `Open the privacy request queue. ${counts.overdue} overdue, ${counts.open} open.`
                  : `Open the privacy request queue. ${counts.open} open.`
              }
              style={{
                marginTop: 4,
                minHeight: 44,
                justifyContent: "center",
                alignItems: "center",
                borderRadius: 10,
                borderWidth: 1,
                borderColor: counts.overdue > 0 ? t.danger : t.border,
                backgroundColor: t.surface,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: counts.overdue > 0 ? t.danger : t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                }}
              >
                {counts.overdue > 0
                  ? `Review ${counts.overdue} overdue`
                  : "Open the full queue"}
              </Text>
            </Pressable>
            {/* The regulatory clock in words. It names its own SCOPE when the
                figure cannot speak for the whole tenant — "3 overdue" that
                silently means "3 in the first hundred" is worse than no
                number on a statutory deadline. */}
            <Text
              {...typeCap("caption")}
              style={{
                color: counts.overdue > 0 ? t.danger : t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {privacyPostureLine(counts)}
            </Text>
          </>
        ) : null}
      </View>

      <PrivacyRequestQueue
        visible={queueOpen}
        onClose={() => {
          setQueueOpen(false);
          // The sheet can deny / hold / verify, all of which change what the
          // inline preview should say.
          void requests.refetch();
        }}
      />
    </Card>
  );
}

function RequestList({
  rows,
  now,
  isError,
  error,
  isLoading,
  gateEnabled,
  onRetry,
}: {
  rows: PrivacyRequestRecord[];
  now: number;
  isError: boolean;
  error: unknown;
  isLoading: boolean;
  gateEnabled: boolean;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  // Deadline order, not arrival order. The wire sorts `requested_at DESC`,
  // which puts today's request above one that is three weeks past its GDPR
  // deadline — the exact inversion this preview existed to prevent.
  const previewed = sortQueue(rows, now).slice(0, VISIBLE_ROWS);
  // A failed load must never render as "no privacy requests yet" — on a
  // compliance surface that is a claim the workspace has nothing outstanding.
  // The queryFn re-tags the envelope's status onto the thrown Error, so the
  // 403 a non-admin gets is named rather than rendered as a generic failure.
  if (isError) return <ErrorState compact error={error} onRetry={onRetry} />;
  if (isLoading && rows.length === 0) {
    return <SkeletonList rows={2} lines={2} label="Loading privacy requests" />;
  }
  if (rows.length === 0) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {gateEnabled
          ? "No privacy requests yet."
          : "Reconnect to load privacy requests."}
      </Text>
    );
  }
  return (
    <>
      {previewed.map((req, i) => {
        const deadline = dueLabel(req, now);
        const late = deadline.startsWith("Overdue");
        return (
          <View key={req.request_id || `privacy-${i}`}>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {formatPrivacyLabel(req.type)} · {formatPrivacyLabel(req.status)}
            </Text>
            <Text
              {...typeCap("caption")}
              // Lateness is never colour-alone: the word "Overdue" is in the
              // string VoiceOver reads.
              style={{
                color: late ? t.danger : t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: late ? FONT.semibold : FONT.regular,
              }}
              numberOfLines={1}
            >
              {formatPrivacyLabel(req.region)} · {deadline}
              {req.legal_hold ? " · legal hold" : ""}
            </Text>
          </View>
        );
      })}
      {rows.length > VISIBLE_ROWS ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {rows.length - VISIBLE_ROWS} more in the queue
        </Text>
      ) : null}
    </>
  );
}
