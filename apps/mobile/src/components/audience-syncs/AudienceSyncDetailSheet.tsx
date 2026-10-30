/**
 * AudienceSyncDetailSheet — where this audience goes, what happened last time,
 * and the one button that pushes it again now.
 *
 * A SHEET RATHER THAN A ROUTE, for the same two reasons ReviewDetailSheet is:
 * the rhythm is open → read the failure → maybe re-run → close, and a pushed
 * screen charges a navigation animation each way; and it keeps this surface to
 * ONE route file, so it costs the tab layout one registration instead of two.
 *
 * IT IS WHERE THE *REASON* LIVES. The list already carries the verdict
 * (`last_run_status`), so this sheet exists for the three things it cannot
 * carry: the error text, the three member counts, and the provider's own words.
 * The run list gets the full five-state ladder rather than a spinner-or-nothing,
 * because a failed FETCH of the history must never render as "this has never
 * run".
 *
 * RUN NOW IS GATED ON ROLE *AND* ON LIFECYCLE, AND BOTH ARE READ OFF THE
 * HANDLER. `POST /{id}/run` sits behind `RequireScope(ScopeWriteSubscribers)`
 * (sync_handlers.go:55), which on the session path means owner, admin or editor
 * (apikeys/middleware.go:291-317) — so a viewer is told plainly rather than
 * discovering the boundary after a confirm sheet. Separately,
 * `beginSyncOperation` refuses a manual run on a DISABLED sync with 409
 * `audience_operation_blocked` (operation_safety.go:288), so a paused sync's
 * button is disabled with that reason instead of offered and rejected.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { AudienceSyncDeleteAction } from "@/components/audience-syncs/AudienceSyncDeleteAction";
import { AudienceSyncExclusionSection } from "@/components/audience-syncs/AudienceSyncExclusionSection";
import { AudienceSyncRunRow } from "@/components/audience-syncs/AudienceSyncRunRow";
import { AudienceSyncSummary } from "@/components/audience-syncs/AudienceSyncSummary";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { runNowBlockedReason } from "@/lib/audienceSyncRunNow";
import {
  SYNC_RUN_LIST_CAP,
  type AudienceSync,
  type AudienceSyncRun,
} from "@/lib/audienceSyncs";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AudienceSyncDetailSheetProps {
  sync: AudienceSync | null;
  runs: readonly AudienceSyncRun[];
  runsQuery: QueryLike;
  /** The online/auth gate, so the history can say "offline" not "empty". */
  gate: { enabled: boolean };
  now: number;
  onClose: () => void;
  onRunNow: (sync: AudienceSync) => void;
  running: boolean;
  /** False for viewers: POST /{id}/run is editor-minimum server-side. */
  canRun: boolean;
  online: boolean;
}

export function AudienceSyncDetailSheet(props: AudienceSyncDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const sync = props.sync;
  const blocked = sync ? runNowBlockedReason(sync, props.online) : null;

  return (
    <ReducedMotionModal
      visible={sync !== null}
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
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {sync?.name || "Sync"}
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
            gap: 12,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {sync ? <AudienceSyncSummary sync={sync} now={props.now} /> : null}

          {props.canRun ? null : (
            <MobileScopeNotice
              title="Read-only for your role"
              body="Running a sync by hand needs an editor role on this workspace, because it delivers real subscriber records to a third-party destination."
            />
          )}

          {sync && props.canRun ? (
            <RunNowButton
              disabled={props.running || blocked !== null}
              busy={props.running}
              {...(blocked !== null ? { hint: blocked } : {})}
              onPress={() => props.onRunNow(sync)}
            />
          ) : null}

          {/* The firewall's forecast sits ABOVE the history deliberately: it
              answers "who would be withheld next time", which is the question
              someone reading a failed run is about to ask, and the receipt it
              offers belongs to a run in the list below. */}
          {sync ? (
            <>
              <SectionHeading>Consent firewall</SectionHeading>
              <AudienceSyncExclusionSection
                sync={sync}
                runs={props.runs}
                online={props.online}
              />
            </>
          ) : null}

          <SectionHeading>Run history</SectionHeading>

          <QueryStates
            query={props.runsQuery}
            gate={props.gate}
            isEmpty={props.runs.length === 0}
            offlineMessage="You're offline, so this sync's run history can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={3} />}
            empty={{
              title: "No runs recorded",
              description:
                "Nothing has run yet — not on the schedule and not by hand. The outcome of the first run will show up here, including anything the consent firewall withholds.",
            }}
          >
            <View style={{ gap: 10 }}>
              {props.runs.map((run) => (
                <AudienceSyncRunRow key={run.id} run={run} now={props.now} />
              ))}
              {props.runs.length >= SYNC_RUN_LIST_CAP ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Showing the {num(SYNC_RUN_LIST_CAP)} most recent runs — the
                  server caps this history and offers no further pages.
                </Text>
              ) : null}
            </View>
          </QueryStates>

          {/* Last, and only once the history has been READ: the confirm sheet
              tells the reader how many runs are about to be deleted with the
              sync, and a count taken from a history that failed to load would
              be a number we made up. `runCount` is null until then, and the
              copy says "its run history" instead. */}
          {sync ? (
            <>
              <SectionHeading>Danger zone</SectionHeading>
              <AudienceSyncDeleteAction
                sync={sync}
                runCount={
                  props.runsQuery.isSuccess === true ? props.runs.length : null
                }
                online={props.online}
                onDeleted={props.onClose}
              />
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SectionHeading({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

function RunNowButton({
  disabled,
  busy,
  hint,
  onPress,
}: {
  disabled: boolean;
  busy: boolean;
  hint?: string | undefined;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={busy ? "Running the sync" : "Run now"}
        accessibilityHint="Resolves the source audience and delivers it to the destination straight away"
        accessibilityState={{ disabled, busy }}
        style={{
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: disabled ? t.surface : t.accent,
          borderWidth: 1,
          borderColor: disabled ? t.borderSubtle : t.accent,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: disabled ? t.fgSubtle : t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Running…" : "Run now"}
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
        {hint ??
          "It runs here and now, for up to a minute, and the result comes back with it. Nothing is queued."}
      </Text>
    </View>
  );
}
