/**
 * SubscribersListEmpty — the five-state ladder under an empty subscriber
 * list, lifted out of the screen so the screen stays inside its complexity
 * budget and the ORDER of the states is reviewable in one place.
 *
 * Order is load-bearing:
 *   loading  → skeletons, never "no subscribers"
 *   error    → a retryable failure, never "nothing here"
 *   gated    → a reconnect notice, never a fake empty workspace
 *   filtered → says what was filtered AND offers the way back
 *   empty    → the genuine onboarding empty state
 *
 * The filtered branch used to dead-end: it named the query and then left the
 * operator to work out that the search box had to be cleared by hand. It now
 * carries the in-app next step, which is the whole point of an empty state.
 */
import { View } from "react-native";

import { EMPTY_STATES } from "@postwave/onboarding-schema";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { useTheme } from "@/lib/theme";

export function SubscribersListEmpty({
  isLoading,
  isError,
  error,
  gateNotice,
  query,
  filterKey,
  filterNoun,
  onRetry,
  onClearFilters,
  onCreate,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  gateNotice: CachedSessionNoticeContent | null;
  query: string;
  filterKey: string;
  /** "unsubscribed" etc; empty for the "all" chip. */
  filterNoun: string;
  onRetry: () => void;
  onClearFilters: () => void;
  /**
   * Opens the create sheet. Omitted when the operator's role or session
   * cannot create, in which case no button is shown rather than one that
   * 403s.
   */
  onCreate?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  if (isLoading) return <SkeletonList rows={6} />;

  if (isError) {
    return (
      <View style={{ marginTop: 12 }}>
        <ErrorState error={error} onRetry={onRetry} />
      </View>
    );
  }

  if (gateNotice) {
    return (
      <View style={{ marginTop: 12 }}>
        <CachedSessionNotice notice={gateNotice} />
      </View>
    );
  }

  const filtered = Boolean(query) || filterKey !== "all";

  if (filtered) {
    return (
      <View style={{ marginTop: 12 }}>
        <EmptyState
          title={
            query
              ? `No subscribers match "${query}"`
              : `No ${filterNoun} subscribers`
          }
          description={
            query && filterKey !== "all"
              ? `Nothing matches that search among ${filterNoun} subscribers.`
              : "Nothing here under the current filters."
          }
          cta={{ label: "Clear filters", onPress: onClearFilters }}
        />
        {/* A search for an address that is not in the workspace is the most
            common way to reach this state, and the useful next step is to add
            that person — not to clear the search and forget them. */}
        {onCreate && query.includes("@") ? (
          <View style={{ marginTop: 12, alignItems: "center" }}>
            <SubActionButton
              label={`Add ${query.trim()}`}
              onPress={onCreate}
              t={t}
            />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ marginTop: 12 }}>
      <EmptyState
        title="No subscribers yet"
        description="Connect a form or import a CSV from the web admin to start growing your audience."
        content={EMPTY_STATES.subscribers}
      />
      {/* The shared content's two CTAs are both DESTINATIONS — an import
          monitor and the forms screen. Adding one person by hand is an
          in-place action this screen owns, so it is offered here directly
          rather than through the router.

          (It used to be offered here because the shared secondary CTA said
          "Add manually" and routed to THIS screen — a button that went
          nowhere. That is fixed in @postwave/onboarding-schema and pinned by
          its self-route invariant test, so this button no longer sits beside
          a dead twin.) */}
      {onCreate ? (
        <View style={{ marginTop: 12, alignItems: "center" }}>
          <SubActionButton label="Add a subscriber" onPress={onCreate} t={t} />
        </View>
      ) : null}
    </View>
  );
}
