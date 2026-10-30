/**
 * Agency — read-only child roster and stored audit-portal branding projection.
 *
 * The agency endpoints return three DIFFERENT 403s (`not_agency`,
 * `not_authorized`, `not_your_child`); this screen used to render all of
 * them as "Not an agency workspace", so an admin whose permissions had just
 * been reduced was told their agency did not exist. The hook now classifies
 * the code and this screen has a third, honest branch for it.
 */
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { AgencyReleaseStatus } from "@/components/agency/AgencyReleaseStatus";
import { BrandingCard } from "@/components/agency/BrandingCard";
import { ChildrenSection } from "@/components/agency/ChildrenSection";
import {
  useMobileAgencyOverview,
  type MobileAgencyOverview,
} from "@/hooks/useAgencyOps";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import {
  onlineQueryAuthorityOwner,
  useOnlineQueryGate,
} from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { governanceOfflineNotice } from "@/lib/governanceOfflineStates";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

export { AppErrorBoundary as ErrorBoundary };

export default function Agency() {
  const { t } = useTheme();
  useScreenViewed("agency");
  const gate = useOnlineQueryGate();
  const canRead = canAccessMinimumRole("admin", gate.effectiveRole);
  const canIssueRead = gate.enabled && Boolean(gate.tenantId) && canRead;
  const authorityOwner = onlineQueryAuthorityOwner(gate);
  const agency = useMobileAgencyOverview();
  const overview = agency.data;
  const refresh = useManualRefresh([agency.refetch], {
    enabled: canIssueRead,
  });
  // GOVERNANCE#33. Offline the query is DISABLED: `isLoading` is false (nothing
  // is fetching), `isError` is false (nothing failed) and `data` is undefined —
  // so every branch below was false and this ScrollView rendered completely
  // BLANK. Not a wrong answer; no answer at all, presented as a finished screen.
  const offline = governanceOfflineNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "agency",
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Agency" onBack={goBackOrMore} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={canIssueRead}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {!canRead ? (
          <EmptyState
            title="Owner or admin access required"
            description="The child roster and stored audit-portal branding were not requested because this workspace role cannot read them."
          />
        ) : null}

        {canRead && agency.isLoading ? (
          <SkeletonList rows={3} lines={3} label="Loading agency overview" />
        ) : null}

        {/* Offline and holding nothing: the honest notice, not a blank page.
            Placed before the error branches because a disabled query can never
            reach them, and after the skeleton because the gate can close
            mid-flight. */}
        {canRead && offline && !overview ? (
          <EmptyState title={offline.title} description={offline.description} />
        ) : null}

        {/* Offline but the last-good overview is still in the cache — keep the
            cards and say so, rather than replacing real figures with a notice. */}
        {canRead && offline && overview ? (
          <View style={{ marginBottom: 8 }}>
            <StaleDataBanner
              message={offline.staleMessage}
              accessibilityLabel={`${offline.title}. ${offline.staleMessage}`}
            />
          </View>
        ) : null}

        {canRead && agency.isError && !overview ? (
          <ErrorState
            error={agency.error}
            onRetry={() => void agency.refetch()}
          />
        ) : null}

        {canRead && agency.isError && overview ? (
          // A refetch failed but we're still showing the last-good data.
          // Surface a compact, retryable banner above the stale cards instead
          // of stacking the full ErrorState card on top of them (matches the
          // approvals.tsx stale-with-rows treatment).
          <View style={{ marginBottom: 8 }}>
            <ErrorState
              compact
              message="Couldn't refresh — showing the last results."
              onRetry={() => void agency.refetch()}
            />
          </View>
        ) : null}

        {canRead && overview ? (
          <AgencyBody
            key={authorityOwner}
            overview={overview}
            onRetry={() => void agency.refetch()}
            hasMore={agency.hasNextPage}
            canLoadMore={canIssueRead}
            isFetchingNextPage={agency.isFetchingNextPage}
            isNextPageError={agency.isFetchNextPageError}
            onLoadMore={() => void agency.fetchNextPage()}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function AgencyBody({
  overview,
  onRetry,
  hasMore,
  canLoadMore,
  isFetchingNextPage,
  isNextPageError,
  onLoadMore,
}: {
  overview: MobileAgencyOverview;
  onRetry: () => void;
  hasMore: boolean;
  canLoadMore: boolean;
  isFetchingNextPage: boolean;
  isNextPageError: boolean;
  onLoadMore: () => void;
}) {
  const children = overview.children;
  const branding = overview.branding;

  return (
    <>
      <MobileScopeNotice body="Review the child roster and stored audit-portal branding draft here. Child lifecycle changes, branding publishing, custom-domain routing, and billing estimates are release-held." />

      {overview.errors.length ? (
        <View style={{ marginBottom: 8 }}>
          <ErrorState
            compact
            message={`Some agency data couldn't be loaded. ${overview.errors
              .map((error) => `${error.surface} could not be verified.`)
              .join(" ")}`}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      <ChildrenSection
        rows={children}
        notAgency={overview.notAgency}
        accessRestricted={overview.accessRestricted}
        unavailable={overview.childrenUnavailable}
        hasMore={hasMore}
        canLoadMore={canLoadMore}
        isFetchingNextPage={isFetchingNextPage}
        isNextPageError={isNextPageError}
        onLoadMore={onLoadMore}
      />

      {/* GOVERNANCE#55 / CQ-8: the shared heading, not agencyCardStyle's old
          private `sectionLabel(t)`, which had drifted from it (fgSubtle and
          letterSpacing 0.5), so a shell heading change never reached here. */}
      <SectionLabel topMargin={0}>Audit portal branding</SectionLabel>
      <BrandingCard branding={branding} />

      <SectionLabel topMargin={18}>Release status</SectionLabel>
      <AgencyReleaseStatus />
    </>
  );
}
