/**
 * DestinationSyncJobsSheet — one audience destination's recent sync jobs, the
 * only place mobile says WHY a destination stopped delivering — and, since the
 * 2026-08 parity pass, the place it can be pushed again and sanity-checked
 * before it sends.
 *
 * WHY THIS EXISTS. The transport (`fetchDestinationJobs`), the parser
 * (`parseSyncJobs`) and the server route (`GET /{id}/jobs`, ScopeReadReports)
 * all shipped and nothing ever called them, so the panel could tell an operator
 * a destination was in `error` and had no way to say what the error WAS.
 *
 * WHAT THE PARITY PASS ADDED, all three verified against the handler:
 *   SYNC NOW    `POST /{id}/sync` — editor floor (ScopeWriteSubscribers). The
 *               button is passed in (or omitted) by the panel, which owns the
 *               role decision; below the floor the section renders a caption
 *               instead of a control that can only 403.
 *   PREVIEW     `GET /{id}/preview` — viewer. PRESS-DRIVEN: resolving the
 *               audience is a real server-side walk, so it runs when asked.
 *   DIAGNOSTICS `GET /{id}/jobs/{job_id}/diagnostics` — viewer. Tap-through
 *               from a non-succeeded job row; rendered by
 *               `DestinationSyncJobRow`, which documents why a refusal is
 *               shown as its own reason.
 *
 * A SHEET RATHER THAN A ROUTE, for the same two reasons AudienceSyncDetailSheet
 * is one: the rhythm is open → read the failure → maybe re-push → close, and
 * this surface lives INSIDE the integrations hub.
 *
 * PRESENTATIONAL ON PURPOSE. Queries and mutations live in the panel, so this
 * component renders against fixed props in a test — the only way to pin the
 * failure-state sentences with the harness's single global query mock.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  SyncJobRow,
  type JobDiagnosticsControls,
} from "@/components/integrations/DestinationSyncJobRow";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SkeletonList } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  previewLines,
  type DestinationPreview,
} from "@/lib/audienceDestinationActions";
import {
  DESTINATION_JOB_LIST_CAP,
  type AudienceDestination,
  type DestinationSyncJob,
} from "@/lib/audienceDestinationRows";
import { FONT } from "@/lib/fonts";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

/**
 * The tap-through diagnostics and the row that offers it moved to
 * `DestinationSyncJobRow`; the predicate is re-exported because callers and
 * tests reach for it here.
 */
export { jobIsDiagnosable } from "@/components/integrations/DestinationSyncJobRow";

export interface DestinationSyncJobsSheetProps {
  /** Null closes the sheet — the open destination IS the visibility state. */
  destination: AudienceDestination | null;
  jobs: readonly DestinationSyncJob[];
  jobsQuery: QueryLike;
  /** The online/auth gate, so an empty history can say "offline" not "never". */
  gate: Pick<OnlineQueryGate, "enabled">;
  now: number;
  onClose: () => void;
  /** Omitted below the editor floor — the panel owns the role decision. */
  syncNow: { onPress: () => void; busy: boolean } | undefined;
  preview: {
    requested: boolean;
    onRequest: () => void;
    data: DestinationPreview | null;
    query: QueryLike;
  };
  diagnostics: JobDiagnosticsControls;
}

export function DestinationSyncJobsSheet(props: DestinationSyncJobsSheetProps) {
  const { t } = useTheme();
  const destination = props.destination;

  return (
    <ReducedMotionModal
      visible={destination !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={2}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {`${destination?.provider || "Destination"} sync history`}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 32,
            gap: 10,
          }}
        >
          {props.syncNow ? (
            <SyncNowButton
              busy={props.syncNow.busy}
              onPress={props.syncNow.onPress}
              provider={destination?.provider || "this destination"}
            />
          ) : (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Pushing this audience again needs an editor role, because it
              delivers real subscriber records to a third party.
            </Text>
          )}

          <PreviewSection preview={props.preview} />

          <QueryStates
            query={props.jobsQuery}
            gate={props.gate}
            isEmpty={props.jobs.length === 0}
            offlineMessage="You're offline, so this destination's sync history can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={3} />}
            empty={{
              title: "No syncs recorded",
              description:
                "Nothing has been pushed to this destination yet. The outcome of the first sync shows up here, including anything the provider rejected.",
            }}
          >
            <View style={{ gap: 10 }}>
              {props.jobs.map((job) => (
                <SyncJobRow
                  key={job.id}
                  job={job}
                  now={props.now}
                  diagnostics={props.diagnostics}
                />
              ))}
              {props.jobs.length >= DESTINATION_JOB_LIST_CAP ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Showing the {DESTINATION_JOB_LIST_CAP} most recent syncs — the
                  server caps this history and offers no further pages.
                </Text>
              ) : null}
            </View>
          </QueryStates>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SyncNowButton({
  busy,
  onPress,
  provider,
}: {
  busy: boolean;
  onPress: () => void;
  provider: string;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={busy ? "Pushing the audience" : "Sync now"}
        accessibilityHint="Delivers the current audience to the destination straight away"
        accessibilityState={{ disabled: busy, busy }}
        style={{
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: busy ? t.surface : t.accent,
          borderWidth: 1,
          borderColor: busy ? t.borderSubtle : t.accent,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: busy ? t.fgSubtle : t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Pushing…" : "Sync now"}
        </Text>
      </Pressable>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`Pushes the audience to ${provider} here and now — the outcome comes back with it, and anyone without consent for this destination's purpose is withheld.`}
      </Text>
    </View>
  );
}

/**
 * Membership preview. Press-driven: the button IS the request, so a reader
 * who only wants the failure history never pays for a server-side audience
 * walk. A failed preview renders its reason and never a zero — a zero is a
 * claim about the audience, and a failed request holds no claims.
 */
function PreviewSection({
  preview,
}: {
  preview: DestinationSyncJobsSheetProps["preview"];
}) {
  const { t } = useTheme();
  if (!preview.requested) {
    return (
      <Pressable
        onPress={preview.onRequest}
        accessibilityRole="button"
        accessibilityLabel="Preview who will be pushed"
        accessibilityHint="Counts the audience and how many the consent firewall would withhold; nothing is sent"
        style={{
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: t.borderSubtle,
        }}
      >
        <Text {...typeCap("caption")} style={{ color: t.fg }}>
          Preview who will be pushed
        </Text>
      </Pressable>
    );
  }
  const body = preview.query.isError ? (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.danger,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {previewErrorMessage(preview.query.error)}
    </Text>
  ) : preview.data ? (
    <View style={{ gap: 2 }}>
      {previewLines(preview.data).map((line) => (
        <Text
          key={line}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {line}
        </Text>
      ))}
    </View>
  ) : (
    <Text
      {...typeCap("caption")}
      style={{ color: t.fgSubtle, ...typeStyle("caption") }}
    >
      Counting the audience…
    </Text>
  );
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Before it sends
      </Text>
      {body}
      <Text
        {...typeCap("caption")}
        style={{ color: t.fgSubtle, ...typeStyle("caption") }}
      >
        Nothing is shipped by this preview.
      </Text>
    </View>
  );
}

/** The sentence for a failed preview — the 503 has a specific meaning. */
function previewErrorMessage(error: unknown): string {
  const status =
    error && typeof error === "object"
      ? Number((error as { status?: unknown }).status ?? 0)
      : 0;
  if (status === 503) {
    return "Preview needs the sync runner, which isn't enabled on this server.";
  }
  if (status === 403) {
    return "Your role cannot preview this destination's membership.";
  }
  return "The preview failed, so the counts are unknown — not zero.";
}
