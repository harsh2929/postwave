/**
 * SequenceChrome — the non-row furniture of the sequences surfaces.
 *
 * Extracted from the list and detail screens for two reasons:
 *   - the capability BOUNDARY copy must be identical wherever it appears, and
 *     duplicating it in two screens is how the two drift apart;
 *   - the empty/loading/error ladder is the part of a list screen that most
 *     often gets an ordering bug (an error rendered as "nothing here"), so it
 *     is worth having in one readable place.
 */
import { router, type ErrorBoundaryProps } from "expo-router";
import { Pressable, Share, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { goBackOr } from "@/lib/nav";
import type { SequenceFilter } from "@/lib/sequenceListView";
import { sequenceShare, type SequenceShareInput } from "@/lib/sequenceShare";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The empty/loading/error ladder, extracted so the screen body stays readable
 * and so the ORDER is stated in one place: an error is never rendered as
 * "nothing here", and offline is its own message rather than a failure.
 */
export function SequencesEmpty({
  loading,
  notice,
  unavailable,
  failureMessage,
  onRetry,
  onCreate,
  onDraft,
  total,
  query,
  filter,
}: {
  loading: boolean;
  notice: CachedSessionNoticeContent | null;
  unavailable: boolean;
  failureMessage: string | null;
  onRetry: () => void;
  /**
   * Start a new draft. Absent when creating cannot succeed (read-only role, or
   * the endpoint is not deployed) — an empty state whose only CTA 403s is
   * worse than an empty state with none.
   */
  onCreate?: (() => void) | undefined;
  /**
   * Present when AI drafting is offered on this screen right now.
   *
   * It is a separate term from `onCreate` and not a boolean derived from it,
   * because the two gates genuinely differ: drafting also needs the network
   * (`canDraftSequenceWithAI`). Naming an action in the empty state that is not
   * on the header would be the same manufactured claim the canvas empty state
   * was rewritten to remove.
   */
  onDraft?: (() => void) | undefined;
  total: number;
  query: string;
  filter: SequenceFilter;
}) {
  if (loading) return <SkeletonList rows={4} lines={2} />;
  if (notice) {
    return (
      <View style={{ marginTop: 12 }}>
        <CachedSessionNotice notice={notice} />
      </View>
    );
  }
  if (unavailable) {
    return (
      <View style={{ marginTop: 12 }}>
        <EmptyState
          title="Sequences not available"
          description="This Moosewave deployment hasn't enabled the Voice sequences endpoint yet. The desktop and web apps will show the same screen empty until the gateway is upgraded."
        />
      </View>
    );
  }
  if (failureMessage) {
    return (
      <View style={{ marginTop: 12 }}>
        <EmptyState
          title="Couldn't load sequences"
          description={failureMessage}
          cta={{ label: "Try again", onPress: onRetry }}
        />
      </View>
    );
  }
  if (total === 0) {
    // Deliberately keep the local, bare state. The shared
    // EMPTY_STATES.sequences CTA ("Build a sequence", routeKey sequences.new)
    // now does open SequenceCreateSheet on arrival via `?new=1` — but from
    // THIS screen that is a navigation to itself just to open a sheet the
    // local onCreate below opens in place, with the role gate already
    // applied. The shared CTA is for other screens pointing here.
    return (
      <View style={{ marginTop: 12 }}>
        <EmptyState
          title="No sequences yet"
          description={emptyDescription({
            canCreate: Boolean(onCreate),
            canDraft: Boolean(onDraft),
          })}
          {...(onCreate
            ? { cta: { label: "New sequence", onPress: onCreate } }
            : {})}
        />
      </View>
    );
  }
  if (query) {
    return (
      <View style={{ marginTop: 12 }}>
        <EmptyState
          title="No matches"
          description={`Nothing matches "${query}" in this filter. Clear the search or switch filters.`}
        />
      </View>
    );
  }
  return (
    <View style={{ marginTop: 12 }}>
      <EmptyState
        title={filter === "drafts" ? "No drafts yet" : "No read-only sequences"}
        description={
          filter === "drafts"
            ? "Create a draft to begin planning a journey. Nothing will enroll or send from this build."
            : "Historical active, archived, and unverified labels will appear here as read-only records."
        }
        {...(onCreate && filter === "drafts"
          ? { cta: { label: "New sequence", onPress: onCreate } }
          : {})}
      />
    </View>
  );
}

/**
 * What a first-time operator is told this screen can do — and only what the
 * header is actually offering them at that moment.
 *
 * The middle case is the one that changed with AUTOMATION#15: "its steps are
 * authored in the desktop or web app" was a true statement about the BLANK
 * draft this CTA makes and a false one about the screen, now that AI drafting
 * writes emails from the phone. Naming both is what stops the empty state
 * teaching the wrong ceiling.
 */
function emptyDescription(input: {
  canCreate: boolean;
  canDraft: boolean;
}): string {
  if (!input.canCreate && !input.canDraft) {
    return "Create and edit journey drafts in the desktop app. Mobile remains a read-only preview; live automation, enrollment, and delivery are unavailable.";
  }
  if (input.canDraft) {
    return "Name an empty draft here, or tap AI draft to have a model write the emails from a brief — you review every one before it is saved. Live automation, enrollment, and delivery remain unavailable.";
  }
  return "Start a draft here and give it a name; its steps are authored in the desktop or web app. Live automation, enrollment, and delivery remain unavailable.";
}

/**
 * Header action: hand this sequence off to a device that can edit it.
 *
 * Every empty and boundary state in this cluster ends with "open it on
 * desktop", and there was no way to actually get there — no share, no copy, no
 * link. The system share sheet covers both: it carries Copy, Messages, Mail
 * and the desktop handoff in one control, so no bespoke clipboard affordance
 * is needed.
 *
 * Renders NOTHING when there is no shareable link (missing or unsafe id): a
 * control that produces a URL resolving to the wrong thing is worse than an
 * absent one.
 */
export function SequenceShareAction(input: SequenceShareInput) {
  const { t } = useTheme();
  const share = sequenceShare(input);
  if (!share) return null;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        void Share.share({ title: share.title, message: share.message }).catch(
          () => {
            // A dismissed share sheet rejects on some platforms; that is the
            // user changing their mind, not a failure worth reporting.
          },
        );
      }}
      accessibilityRole="button"
      accessibilityLabel={`Share ${share.title}, or copy its link`}
      accessibilityHint="Opens the system share sheet with a link that opens this sequence on desktop or web."
      hitSlop={8}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Share
      </Text>
    </Pressable>
  );
}

/**
 * Header action: start a new draft.
 *
 * A text button rather than a "+" glyph. The tab bar and this header both sit
 * at the tightest end of the type scale, and a bare plus is the control most
 * often reported as "I didn't know that did anything" — the label costs eight
 * points of width and removes the guess. `control` is the right role: it is a
 * compact chrome label that shares a row and cannot reflow.
 */
export function SequenceCreateAction({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="New sequence"
      accessibilityHint="Names a new empty draft. Steps are added in the desktop or web app."
      hitSlop={8}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        New
      </Text>
    </Pressable>
  );
}

export function SequenceChromeBoundary() {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Sequence runtime unavailable. These are journey drafts and historical labels only. Live triggers, enrollment, delivery, and analytics are off."
      style={{
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 0,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgSubtle,
        gap: 3,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Draft designer · live runtime unavailable
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Review planned journeys here. Triggers, enrollment, delivery, runtime
        analytics, and mobile authoring remain off.
      </Text>
    </View>
  );
}

export function SequenceDetailBoundary({ topMargin }: { topMargin: number }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Draft preview only. Live sequence triggers, enrollment, delivery, analytics, and mobile authoring are unavailable."
      style={{
        marginHorizontal: 16,
        marginTop: topMargin,
        marginBottom: 8,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgSubtle,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Draft preview only
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Review the planned journey here. Live triggers, enrollment, delivery,
        analytics, and mobile editing stay off until the runtime and
        conflict-recovery contract are qualified.
      </Text>
    </View>
  );
}

/**
 * Body of the sequence-detail route error boundary.
 *
 * `wireToCanvas` walks untrusted, arbitrarily-nested server JSON inside render.
 * It is defensive now (array guards + a depth ceiling), but this is still the
 * one screen in the cluster that parses a recursive payload, so a failure must
 * scope to that route instead of taking the ROOT boundary and blanking the app.
 * The route file exports the boundary itself (Expo Router picks up a named
 * `ErrorBoundary` export per file); the presentation lives here.
 */
export function SequenceCanvasErrorBody({
  message,
  onRetry,
  onLeave,
}: {
  message: string;
  onRetry: () => void;
  onLeave: () => void;
}) {
  return (
    <View style={{ padding: 16, gap: 12 }}>
      <EmptyState
        title="This sequence couldn't be drawn"
        description={`${message || "The stored journey has a shape this build doesn't understand."} Open it on desktop to inspect or repair it.`}
        cta={{ label: "Try again", onPress: onRetry }}
      />
      <EmptyState
        title="Back to sequences"
        description="The rest of the app is unaffected."
        cta={{ label: "All sequences", onPress: onLeave }}
      />
    </View>
  );
}

/**
 * The sequence-detail route's Expo Router ErrorBoundary, chrome included.
 *
 * It lives here rather than in the route file so the route stays a data flow:
 * the file already carries the seeding, versioning and offline-replay logic
 * and sits against its source-line ceiling. `app/(tabs)/sequences/[id].tsx`
 * re-exports this under the name Expo Router looks for.
 */
export function SequenceRouteErrorBoundary({
  error,
  retry,
}: ErrorBoundaryProps) {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
      <ScreenHeader
        title="Sequence"
        onBack={() => goBackOr("/(tabs)/sequences")}
      />
      <SequenceCanvasErrorBody
        message={error.message}
        onRetry={() => void retry()}
        onLeave={() => router.replace("/(tabs)/sequences")}
      />
    </SafeAreaView>
  );
}
