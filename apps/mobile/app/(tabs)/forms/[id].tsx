/**
 * Form detail — "is this form actually capturing, and what does the curve
 * look like?"
 *
 * Three reads, in decreasing order of how often you want them on a phone:
 *   1. status + 30-day signups + conversion (from the list payload's own
 *      computed fields, refetched here so a deep link works standalone);
 *   2. the 30-day hosted-page visit curve (GET /forms/{id}/analytics);
 *   3. the most recent submissions — ADMIN ONLY.
 *
 * (3) is admin-gated in BOTH directions: the server keeps
 * /forms/{id}/submissions at admin scope because the rows carry email
 * addresses, IP/user-agent metadata and arbitrary custom fields, and the scope
 * vocabulary has no form-response PII permission yet. The client must not
 * merely handle the 403 — it must not ask, and must say why.
 *
 * Since the desktop-parity pass this screen also carries the WRITES:
 *  - lifecycle (publish / move-to-draft / archive) at the editor floor,
 *    online-only by queue policy — see lib/formLifecycle;
 *  - the admin danger zone (hard delete, typed-phrase confirmed);
 *  - the submissions CSV as a bounded share-sheet text, the same treatment
 *    discounts gives redemptions (the old "needs a file download" note here
 *    predated that precedent).
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { SkeletonDetail } from "@/components/Skeleton";
import { FormDetailBody } from "@/components/forms/FormDetailBody";
import { FormLifecycleCard } from "@/components/forms/FormLifecycleActions";
import { FormVariantsSection } from "@/components/forms/FormVariantsSection";
import { OnsiteGrowthSection } from "@/components/forms/OnsiteGrowthSection";
import { useFormCsvShare } from "@/hooks/useFormCsvShare";
import { useFormDetailQueries } from "@/hooks/useFormDetailQueries";
import { useResendConfirmation } from "@/hooks/useResendConfirmation";
import {
  FORM_DELETE_MINIMUM_ROLE,
  FORM_LIFECYCLE_MINIMUM_ROLE,
  lifecycleTargetFromListItem,
} from "@/lib/formLifecycle";
import { useAuthStore } from "@/store/auth";
import { date, relativeTime } from "@/lib/format";
import { alignVisitCounts, utcDayBuckets } from "@/lib/formMetrics";
import {
  analyticsErrorMessage,
  formFetchState,
  formHeaderText,
  submissionsErrorMessage,
} from "@/lib/formDetailView";
import { safeHostedFormUrl } from "@/lib/formStatus";
import { goBackOr } from "@/lib/nav";
import {
  canAccessMinimumRole,
  normalizeMobileAccessRole,
} from "@/lib/mobileRouteManifest";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const WINDOW_DAYS = 30;

export default function FormDetail() {
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("form", id);
  const gate = useOnlineQueryGate();
  useScreenViewed("form detail");
  const notice = cachedSessionNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "campaigns",
  });

  const role = normalizeMobileAccessRole(gate.effectiveRole);
  const isAdmin = role === "admin" || role === "owner";
  const mode = useAuthStore((s) => s.mode);
  // Mode-aware, unlike `isAdmin` above: an API-key session cannot prove its
  // scopes, so write affordances fail closed for keys.
  const canLifecycle = canAccessMinimumRole(
    FORM_LIFECYCLE_MINIMUM_ROLE,
    gate.effectiveRole,
    mode,
  );
  const canDelete = canAccessMinimumRole(
    FORM_DELETE_MINIMUM_ROLE,
    gate.effectiveRole,
    mode,
  );
  const { toast } = useToast();
  // Fetch the bounded CSV and hand it to the OS share sheet — see the hook.
  const csvShare = useFormCsvShare(id, toast);
  // Re-send a double-opt-in confirmation — 409 means "already confirmed".
  const confirmation = useResendConfirmation(id, gate.tenantId, toast);

  // The four reads and their gate/role-aware enabled clauses — see the hook.
  const { form, analytics, submissions, embed } = useFormDetailQueries(
    id,
    gate,
    isAdmin,
  );

  const detail = form.data?.data ?? null;
  const fetch = formFetchState({
    error: form.data?.error ?? null,
    threw: form.isError,
    hasId: Boolean(id),
  });

  const buckets = useMemo(() => utcDayBuckets(WINDOW_DAYS), []);
  const visitSeries = useMemo(
    () => alignVisitCounts(analytics.data?.data?.visits, buckets),
    [analytics.data?.data?.visits, buckets],
  );
  const visitLabels = useMemo(() => buckets.map((d) => date(d)), [buckets]);
  const visitsTotal = useMemo(
    () => visitSeries.reduce((a, b) => a + b, 0),
    [visitSeries],
  );
  const header = formHeaderText(detail, relativeTime);

  const refetchForm = form.refetch;
  const refetchAnalytics = analytics.refetch;
  const refetchSubmissions = submissions.refetch;
  const onRefresh = useCallback(() => {
    if (notice) return;
    void refetchForm();
    void refetchAnalytics();
    if (isAdmin) void refetchSubmissions();
  }, [notice, refetchForm, refetchAnalytics, refetchSubmissions, isAdmin]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={header.title}
        subtitle={header.subtitle}
        onBack={() => goBackOr("/(tabs)/forms")}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={form.isFetching && !form.isLoading}
            onRefresh={onRefresh}
            enabled={!notice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {notice ? (
          <CachedSessionNotice
            notice={notice}
            variant={detail ? "stale" : "blocked"}
          />
        ) : null}

        {form.isLoading ? (
          <SkeletonDetail sections={3} />
        ) : fetch.unavailable ? (
          <EmptyState
            title="Form not found"
            description="This form no longer exists, or this deployment doesn't expose the forms endpoints."
          />
        ) : fetch.hardError ? (
          <EmptyState
            title="Couldn't load this form"
            description={fetch.errorMessage}
            cta={{ label: "Try again", onPress: () => void refetchForm() }}
          />
        ) : detail ? (
          <>
            <FormDetailBody
              detail={detail}
              visitSeries={visitSeries}
              visitLabels={visitLabels}
              visitsTotal={visitsTotal}
              analyticsLoading={analytics.isLoading}
              analyticsError={analyticsErrorMessage(analytics.data?.error)}
              hostedUrl={safeHostedFormUrl(embed.data?.data?.public_url)}
              isAdmin={isAdmin}
              submissions={submissions.data?.data ?? null}
              submissionsLoading={submissions.isLoading}
              submissionsError={submissionsErrorMessage(
                submissions.data?.error,
                submissions.isError,
              )}
              onResendConfirmation={
                isAdmin && gate.enabled && id
                  ? (row) => void confirmation.resend(row)
                  : null
              }
              resendingConfirmation={confirmation.resending}
              onExportSubmissions={
                isAdmin && gate.enabled && id
                  ? () => csvShare.share(detail.name ?? detail.slug ?? "form")
                  : null
              }
              exportingSubmissions={csvShare.exporting}
            />
            {/* The lifecycle verbs and the admin danger zone. Renders nothing
                for a role below editor. */}
            {id ? (
              <FormLifecycleCard
                form={lifecycleTargetFromListItem({ ...detail, id })}
                canLifecycle={canLifecycle && gate.enabled}
                canDelete={canDelete && gate.enabled}
                onDeleted={() => goBackOr("/(tabs)/forms")}
              />
            ) : null}
            {/* Renders nothing at all when this form has no display variants,
                when the routes are absent, or when the token lacks
                read:reports — see the component. */}
            <FormVariantsSection id={id} canAdmin={canDelete && gate.enabled} />
            {/* Popup targeting / experiments / spin rewards — read for
                everyone, arm/disarm for admins; hidden when never
                configured. */}
            <OnsiteGrowthSection
              formId={id}
              canAdmin={canDelete && gate.enabled}
            />
          </>
        ) : (
          <View />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
