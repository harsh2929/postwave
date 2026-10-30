/**
 * Campaign detail — the on-the-go operator's view of one campaign.
 *
 * This route used to be 826 lines holding four formatters, an HTML stripper,
 * five mutations, the whole gating matrix and ~390 lines of JSX. Desktop
 * decomposed the same surface into six components plus four controller hooks
 * precisely so it could keep growing; this file now does the same:
 *
 *   src/lib/campaignFormat.ts             formatters (tested)
 *   src/lib/campaignBody.ts               body → preview text (tested, bounded)
 *   src/lib/campaignDetailGates.ts        which actions the STATE allows (tested)
 *   src/lib/campaignAccess.ts             which actions the PERSON may take (tested)
 *   src/hooks/useCampaignDetailActions.ts delete / resend / lifecycle / clone
 *   components/campaigns/CampaignDetailContent  the loaded-campaign layout
 *
 * Behavioural fixes that came with it:
 *  - A missing or deleted campaign gets a way out. `useCampaign` is disabled
 *    without an id, so a malformed deep link left isLoading false, isError
 *    false and `c` undefined — every content block sat behind `{c ? … }` and
 *    the screen rendered nothing, permanently, with no way back.
 *  - The load failure renders through ErrorState instead of printing
 *    `camp.error.message`, which contradicted the app's own no-raw-errors
 *    policy.
 *  - Every mutating affordance is gated on the workspace ROLE, not just on
 *    connectivity, and a denial is explained instead of 403-ing after the tap.
 *  - The body's eleven regex passes are memoised (and bounded), instead of
 *    re-running on every render and being thrown away.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonDetail } from "@/components/Skeleton";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { CampaignDetailContent } from "@/components/campaigns/CampaignDetailContent";
import {
  CampaignDetailModals,
  type CampaignSheet,
} from "@/components/campaigns/CampaignDetailModals";
import { DraftCheckpointBanner } from "@/components/campaigns/DraftCheckpointBanner";
import { useCampaignAccess } from "@/hooks/useCampaignAccess";
import { useCampaignDraftCheckpoint } from "@/hooks/useCampaignDraftCheckpoint";
import { useCampaignDetailActions } from "@/hooks/useCampaignDetailActions";
import { useCampaignSendPreview } from "@/hooks/useCampaignSendChecks";
import { useCampaignShare } from "@/hooks/useCampaignShare";
import { useEntityActivity } from "@/hooks/useEntityActivity";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useSheetTriggerRefs } from "@/hooks/useSheetTriggerRefs";
import { useCampaign, useCampaignReport } from "@/hooks/useCampaigns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignPreviewText, hasDynamicRegions } from "@/lib/campaignBody";
import { campaignGates } from "@/lib/campaignDetailGates";
import { isCampaignMissingError } from "@/lib/campaignErrors";
import {
  campaignsQueryRootKey,
  firstMeaningful,
} from "@/lib/detailSeedKeys";
import { useCachedRowSeed } from "@/hooks/useCachedRowSeed";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

/**
 * A render failure inside one campaign (a malformed report reaching .toFixed,
 * a bad variant array) should not tear down the whole app to the global error
 * screen and lose the user's tab and scroll state.
 */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * What the header can borrow from the row the operator just tapped. Only the
 * two identity strings — anything else (status, counts) is a MEASUREMENT, and
 * showing a stale one under a live-looking header is worse than showing none.
 */
const CAMPAIGN_SEED_FIELDS = ["name", "subject"] as const;

export default function CampaignDetailRoute() {
  useScreenViewed("campaign-detail");
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("campaign", id);
  const onlineGate = useOnlineQueryGate();
  const gateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "campaigns",
  });
  const access = useCampaignAccess({ sessionUsable: !gateNotice });

  const camp = useCampaign(id);
  const c = camp.data;
  // The row that led here is still in the campaigns cache (and, because detail
  // routes are siblings in the Tabs navigator, the list screen is still
  // mounted). Read the name off it so the header carries the campaign's
  // identity on the FIRST frame instead of an anonymous "Campaign" for the
  // whole detail round trip. It loses to `c` the moment real data lands.
  const headerSeed = useCachedRowSeed(
    campaignsQueryRootKey(onlineGate.tenantId),
    id,
    CAMPAIGN_SEED_FIELDS,
  );
  const headerSubtitle = firstMeaningful(
    c?.name,
    c?.subject,
    headerSeed.name,
    headerSeed.subject,
  );
  // Offer this campaign to Handoff and Spotlight (SHELL#31). Suppressed while
  // the app lock is armed, and revoked from the search index on sign-out.
  useEntityActivity({
    entity: "campaign",
    id,
    title: headerSubtitle,
    subtitle: c?.subject ?? headerSeed.subject,
  });

  // The report polls itself while the campaign is actively sending — the one
  // state where a static screen is actively misleading.
  const report = useCampaignReport(id, { status: c?.status });
  const r = report.data;

  // The audience read answers the question the screen never did ("who does
  // this go to?"), and warms the cache the send sheet reads.
  //
  // NOT gated on `c`. This needs the route id and nothing else, so waiting for
  // the campaign GET to resolve serialised two requests that can run at once,
  // on the screen an operator opens before pressing Send. The hook already
  // refuses to run without an id, a tenant, or connectivity
  // (useCampaignSendChecks.ts), and already swallows a missing endpoint via
  // isOptionalEndpointError, so the extra gate only cost a round trip.
  const audience = useCampaignSendPreview(id);

  // One sheet at a time — they are all page sheets, and seven independent
  // booleans made "open the subject sheet from inside the send sheet" a
  // two-setState dance that could leave both mounted.
  const [sheet, setSheet] = useState<CampaignSheet | null>(null);
  // Which control opened the sheet that is up, so dismissing it returns
  // VoiceOver focus there. The route owns this because the route owns `sheet`:
  // the trigger side (a row of up to eleven buttons) and the sheet side are
  // two different components, and only this one knows they are the same event.
  const triggers = useSheetTriggerRefs<CampaignSheet>();

  const previewText = useMemo(() => campaignPreviewText(c), [c]);
  const dynamicRegions = useMemo(() => hasDynamicRegions(c), [c]);
  const gates = useMemo(() => campaignGates(c), [c]);

  // The content half of cross-device continuity (ECO-03). `useRecordLastViewed`
  // above tells the other devices WHICH campaign you were on; this is what you
  // had actually typed into it. Until now the phone wrote neither half of that
  // — the checkpoint API had been mounted and RLS-scoped with no caller on this
  // surface at all, so a subject line half-written on a laptop simply was not
  // here.
  //
  // Held at the ROUTE, not inside the edit sheet: arriving from another device
  // you land on this screen, and an offer buried behind a sheet nobody has a
  // reason to open is an offer that is never seen. Writes still need both the
  // campaign's state and the person's role to allow editing — a viewer's phone
  // must not create drafts it could never save.
  const openEditor = useCallback(() => setSheet("subject"), []);
  const checkpoint = useCampaignDraftCheckpoint({
    campaign: c,
    campaignId: id,
    canEdit: gates.canEdit && access.canMutate,
    onOpenEditor: openEditor,
  });
  const clearSeed = checkpoint.clearSeed;
  const closeSheet = useCallback(() => {
    setSheet(null);
    clearSeed();
  }, [clearSeed]);

  const openResend = useCallback(() => setSheet("resend"), []);
  const actions = useCampaignDetailActions({
    campaign: c,
    canMutate: access.canMutate,
    canAdmin: access.canAdmin,
    onOpenResend: openResend,
  });

  const { archiveUrl, share } = useCampaignShare(c, r);

  // The spinner used to be bound to `camp.isFetching || report.isFetching`,
  // and the report POLLS ITSELF every few seconds while a campaign is sending
  // — the one state this screen exists for. So on exactly the screen an
  // operator watches, the refresh control span and retracted on its own,
  // repeatedly, with no gesture behind it. The shared hook binds the spinner to
  // the gesture and confirms completion with a tick.
  const refetchCampaign = camp.refetch;
  const refetchReport = report.refetch;
  const refetchAudience = audience.refetch;
  const refresh = useManualRefresh(
    [refetchCampaign, refetchReport, refetchAudience],
    { enabled: !gateNotice },
  );

  // A malformed deep link, or a cold universal link that loses the param.
  if (!id) {
    return (
      <CampaignNotFound description="That link didn't include a campaign. Open one from the campaigns list." />
    );
  }
  if (camp.isError && isCampaignMissingError(camp.error)) {
    return (
      <CampaignNotFound description="This campaign no longer exists — it may have been deleted." />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Campaign"
        subtitle={headerSubtitle}
        onBack={() => goBackOr("/(tabs)/campaigns")}
        right={c ? <ActionButton label="Share" onPress={share} /> : undefined}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={!gateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {access.notice ? (
          <MobileScopeNotice
            title={ACCESS_TITLES[access.reason] ?? "Actions unavailable"}
            body={access.notice}
          />
        ) : null}

        {gateNotice ? (
          <CachedSessionNotice
            notice={gateNotice}
            variant={c ? "stale" : "blocked"}
            style={{ marginBottom: 12 }}
          />
        ) : null}

        {/* Before the content, not after: a draft you are not told about is a
            draft you overwrite. On a campaign this surface can no longer edit,
            the same banner is what explains why it can only be read. */}
        <DraftCheckpointBanner
          state={checkpoint.state}
          canEdit={gates.canEdit && access.canMutate}
        />

        {camp.isLoading && !c ? <SkeletonDetail sections={3} /> : null}

        {camp.isError && !c ? (
          <ErrorState
            error={camp.error}
            message="Couldn't load this campaign."
            onRetry={() => void camp.refetch()}
          />
        ) : null}

        {c ? (
          <CampaignDetailContent
            campaign={c}
            gates={gates}
            access={access}
            actions={actions}
            report={r}
            reportLoading={report.isLoading}
            reportError={report.error}
            onRetryReport={() => void report.refetch()}
            audience={audience.data}
            audienceLoading={audience.isLoading}
            // Errored, or never ran because the online gate is closed. Both
            // leave `data` undefined, and without saying so the audience line
            // reads "this campaign has no list or segment" — which for a
            // workspace-wide send is the exact inverse of the truth, printed
            // directly above Send.
            audienceUnavailable={
              audience.isError || (!audience.isSuccess && !audience.isLoading)
            }
            previewText={previewText}
            hasDynamicRegions={dynamicRegions}
            archiveUrl={archiveUrl}
            sheetTriggerRef={triggers.refFor}
            onEditSubject={() => setSheet("subject")}
            onOpenFeedback={() => setSheet("feedback")}
            onPreviewAs={() => setSheet("previewAs")}
            onSaveAsTemplate={() => setSheet("saveTemplate")}
            onSchedule={() => setSheet("schedule")}
            onSendTest={() => setSheet("test")}
            onSend={() => setSheet("send")}
            onViewAbResults={() =>
              router.push({
                pathname: "/(tabs)/campaigns/[id]/ab-results",
                params: { id: c.id },
              })
            }
          />
        ) : null}
      </ScrollView>

      {c ? (
        <CampaignDetailModals
          campaign={c}
          access={access}
          open={sheet}
          onOpen={setSheet}
          onClose={closeSheet}
          returnFocusRef={triggers.activeRef(sheet)}
          draftSeed={checkpoint.seed}
          onDraftChange={checkpoint.onDraftChange}
        />
      ) : null}
    </SafeAreaView>
  );
}

const ACCESS_TITLES: Record<string, string> = {
  viewer: "Read-only access",
  offline: "You're offline",
  session: "Cached session",
};

function CampaignNotFound({ description }: { description: string }) {
  const { t } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Campaign"
        onBack={() => goBackOr("/(tabs)/campaigns")}
      />
      <View style={{ padding: 16 }}>
        <EmptyState
          title="Campaign not found"
          description={description}
          cta={{
            label: "Back to campaigns",
            onPress: () => goBackOr("/(tabs)/campaigns"),
          }}
        />
      </View>
    </SafeAreaView>
  );
}
