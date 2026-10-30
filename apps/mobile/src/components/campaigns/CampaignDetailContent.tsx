/**
 * CampaignDetailContent — everything the detail screen renders once the
 * campaign has actually loaded.
 *
 * Splitting this out of the route file is what lets the route be a readable
 * state ladder (offline / role / loading / not-found / content) instead of
 * one 390-line conditional. Composition mirrors desktop's decomposition of
 * the same surface.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";

import { SectionLabel } from "@/components/SectionLabel";
import { WebHandoffRow } from "@/components/WebHandoffRow";
import { CampaignActionRow } from "@/components/campaigns/CampaignActionRow";
import { CampaignAssuranceCard } from "@/components/campaigns/CampaignAssuranceCard";
import type { CampaignSheet } from "@/components/campaigns/CampaignDetailModals";
import type { TriggerRef } from "@/hooks/useSheetTriggerRefs";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { CampaignAudienceModeCard } from "@/components/campaigns/CampaignAudienceModeCard";
import {
  CampaignOptimizerCard,
  CampaignRemixCard,
} from "@/components/campaigns/CampaignContentToolsCards";
import { CampaignGoalCard } from "@/components/campaigns/CampaignGoalCard";
import { CampaignHoldoutCard } from "@/components/campaigns/CampaignHoldoutCard";
import { CampaignPollReceiptsCard } from "@/components/campaigns/CampaignPollReceiptsCard";
import { CampaignInsightsSection } from "@/components/campaigns/CampaignInsightsSection";
import { CampaignRenderedPreviewCard } from "@/components/campaigns/CampaignRenderedPreviewCard";
import { CampaignPerformanceSection } from "@/components/campaigns/CampaignPerformanceSection";
import { CampaignPreviewCard } from "@/components/campaigns/CampaignPreviewCard";
import { CampaignSendProgress } from "@/components/campaigns/CampaignSendProgress";
import { CampaignSummaryCard } from "@/components/campaigns/CampaignSummaryCard";
import { CampaignTranslationsCard } from "@/components/campaigns/CampaignTranslationsCard";
import { CampaignUtmCard } from "@/components/campaigns/CampaignUtmCard";
import { useCampaignTranslations } from "@/hooks/useCampaignTranslations";
import { readCampaignTranslations } from "@/lib/campaignTranslations";
import type { CampaignDetailActions } from "@/hooks/useCampaignDetailActions";
import type { CampaignDetail, CampaignReport } from "@/hooks/useCampaigns";
import type { CampaignAccess } from "@/lib/campaignAccess";
import type { CampaignGates } from "@/lib/campaignDetailGates";
import type { SendPreviewResponse } from "@/lib/campaignSendPreview";
import { campaignHasAuthoritativeSemanticPoll } from "@/lib/campaignPolls";
import { FONT } from "@/lib/fonts";
import { useMotion } from "@/lib/motion";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignDetailContentProps {
  campaign: CampaignDetail;
  gates: CampaignGates;
  access: CampaignAccess;
  actions: CampaignDetailActions;
  report: CampaignReport | null | undefined;
  reportLoading: boolean;
  reportError: unknown;
  onRetryReport: () => void;
  audience: SendPreviewResponse | null | undefined;
  audienceLoading: boolean;
  /**
   * The send-preview read errored or never ran. Without it the audience line
   * states "no list or segment" from a lack of signal.
   */
  audienceUnavailable?: boolean | undefined;
  previewText: string | null;
  hasDynamicRegions: boolean;
  /** Non-null when the campaign has a shareable public web version. */
  archiveUrl: string | null;
  onEditSubject: () => void;
  /** Opens the internal review thread (read-scope, so every role gets it). */
  onOpenFeedback: () => void;
  /** Opens the resolve-for-one-subscriber sheet (regions + preview-as). */
  onPreviewAs: () => void;
  /** Opens the admin-only save-as-template sheet. */
  onSaveAsTemplate: () => void;
  onSchedule: () => void;
  onSendTest: () => void;
  onViewAbResults: () => void;
  onSend: () => void;
  /**
   * Binds every control that opens a sheet to a ref, so dismissing the sheet
   * returns screen-reader focus to it. Threaded rather than owned here because
   * the ROUTE owns which sheet is open, and the two have to agree.
   */
  sheetTriggerRef?: ((sheet: CampaignSheet) => TriggerRef) | undefined;
}

export function CampaignDetailContent(props: CampaignDetailContentProps) {
  const { t } = useTheme();
  const { animateLayout } = useMotion();
  const { campaign, gates, access, actions } = props;
  // Collapsed by default: the card owns a real gateway read, and it is
  // enabled only by the disclosure — the same contract every insight card on
  // this screen follows.
  const [utmOpen, setUtmOpen] = useState(false);

  // Not lazily enabled behind a disclosure, unlike the insight reads: a
  // multilingual warning that only appears once you go looking for it has
  // already failed the reviewer it exists for. One indexed SELECT.
  const translationsQuery = useCampaignTranslations(campaign.id);
  const translations = useMemo(
    () => readCampaignTranslations(translationsQuery.data),
    [translationsQuery.data],
  );

  return (
    <>
      <CampaignSummaryCard
        campaign={campaign}
        preview={props.audience}
        previewLoading={props.audienceLoading}
        previewUnavailable={props.audienceUnavailable ?? false}
      />

      <CampaignSendProgress
        status={campaign.status}
        sent={props.report?.sent}
        delivered={props.report?.delivered}
        audience={props.audience?.recipients}
      />

      <CampaignActionRow
        canMutate={access.canMutate}
        canAdmin={access.canAdmin}
        canEdit={gates.canEdit}
        canSchedule={gates.canSchedule}
        canSend={gates.canSend}
        canTest={gates.canTest}
        canResend={gates.canResend}
        canDelete={gates.canDelete}
        canViewAbResults={gates.canViewAbResults}
        lifecycleActions={actions.lifecycleActions}
        lifecyclePending={actions.lifecyclePending}
        lifecycleActionInFlight={actions.lifecycleActionInFlight}
        deletePending={actions.deletePending}
        resendPending={actions.resendPending}
        clonePending={actions.clonePending}
        onEditSubject={props.onEditSubject}
        onOpenFeedback={props.onOpenFeedback}
        onSaveAsTemplate={props.onSaveAsTemplate}
        onSchedule={props.onSchedule}
        onSendTest={props.onSendTest}
        onViewAbResults={props.onViewAbResults}
        onLifecycle={actions.confirmLifecycle}
        onSend={props.onSend}
        onResend={actions.confirmResend}
        onDelete={actions.confirmDelete}
        onDuplicate={actions.duplicate}
        triggerRef={props.sheetTriggerRef}
      />

      <CampaignAssuranceCard campaignId={campaign.id} />

      <CampaignPollReceiptsCard
        campaignId={campaign.id}
        hasSemanticPoll={campaignHasAuthoritativeSemanticPoll(
          campaign.source_mode,
          campaign.content_schema_version,
          campaign.content_blocks,
        )}
      />

      {/* Editor verbs on an editable campaign only — the mode flip and the
          freeze are online-only writes (lib/campaignAudienceMode), and a
          role that cannot use them is not shown them. */}
      {access.canMutate && gates.canEdit ? (
        <CampaignAudienceModeCard campaign={campaign} />
      ) : null}

      {props.archiveUrl ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            marginTop: 10,
            lineHeight: 16,
            fontFamily: FONT.regular,
          }}
        >
          Published to the public archive — Share sends the web version link.
        </Text>
      ) : null}

      <CampaignPerformanceSection
        report={props.report}
        loading={props.reportLoading}
        error={props.reportError}
        onRetry={props.onRetryReport}
        isDraft={gates.isDraft}
      />

      {/* ABOVE Insights, and deliberately OUTSIDE it: the insights block is
          hidden for a campaign that has never sent, and "what will be appended
          to my links" is a question you ask BEFORE sending, not after. This is
          the phone form of desktop's UTMTemplatesPanel
          (CampaignDetailPresentation.tsx:430). */}
      <SectionLabel>Links</SectionLabel>
      <CampaignUtmCard
        campaignId={campaign.id}
        expanded={utmOpen}
        onToggle={() => {
          // LOVE#7's detail half, minus the navigator restructure the round
          // forbids. Expanding this card pushes Insights, Translations and
          // Preview down the screen; a fade on the card alone would leave all
          // three snapping to their new offsets in a single frame. Called in
          // the handler because LayoutAnimation configures the NEXT pass —
          // from an effect the pass has already committed. `animateLayout`
          // schedules nothing at all under Reduce Motion.
          animateLayout("enter");
          setUtmOpen((prev) => !prev);
        }}
        canAdmin={access.canAdmin}
      />

      <CampaignInsightsSection
        campaignId={campaign.id}
        hasSent={!gates.isDraft}
        canMutate={access.canMutate}
        {...(access.notice ? { mutateBlockedReason: access.notice } : {})}
      />

      {/* Measurement + derivation verbs. Rendered ONLY for roles that can use
          them: the goal / optimizer / remix routes are editor, the holdout
          handler binds ScopeAdmin (lib/campaignHoldout). Viewers see none of
          this — the insight cards above already carry the read side. */}
      {access.canMutate ? (
        <>
          <SectionLabel>Measure &amp; derive</SectionLabel>
          <CampaignGoalCard campaign={campaign} />
          {access.canAdmin ? (
            <CampaignHoldoutCard campaignId={campaign.id} />
          ) : null}
          <CampaignOptimizerCard campaignId={campaign.id} />
          <CampaignRemixCard campaignId={campaign.id} />
        </>
      ) : null}

      {/* Above Preview, because it QUALIFIES Preview: the block below shows
          one language and never said so. Renders nothing for a campaign with
          no translations, which is nearly all of them. */}
      <CampaignTranslationsCard
        reading={translations}
        campaignId={campaign.id}
        canMutate={access.canMutate}
        canAdmin={access.canAdmin}
        wire={translationsQuery.data ?? null}
      />

      <View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
            marginBottom: 8,
            gap: 12,
          }}
        >
          <Text
            {...typeCap("caption")}
            accessibilityRole="header"
            style={{
              color: t.fgMuted,
              fontSize: 11,
              letterSpacing: 0.6,
              fontWeight: "600",
              fontFamily: FONT.semibold,
              textTransform: "uppercase",
            }}
          >
            Preview
          </Text>
          {/* Read-scope on the gateway, so it stays available to the viewer
              who was asked to review the draft and cannot change it. */}
          <ActionButton
            label="Preview as…"
            onPress={props.onPreviewAs}
            buttonRef={props.sheetTriggerRef?.("previewAs")}
          />
        </View>
        <CampaignPreviewCard
          preview={props.previewText}
          hasDynamicContent={props.hasDynamicRegions}
        />
        {/* ADMIN floor: both rendered-preview routes are session-role admin
            in the routeauth manifest, so the card is omitted — not disabled —
            for everyone else. */}
        {access.canAdmin ? (
          <CampaignRenderedPreviewCard
            bodySource={campaign.body_mjml || campaign.body_html || ""}
          />
        ) : null}
      </View>

      {/* "Finish this on the web" (LOVE#50). Placed directly under Preview
          because that is where the read-only boundary bites hardest: this
          screen shows you the body and gives you no way to change a word of
          it — app/(tabs)/campaigns/index.tsx says in its own header comment that
          full composition stays on the web. Copy leads over Open because the
          in-app browser does not carry this app's session; see WebHandoffRow. */}
      <WebHandoffRow
        entity="campaign"
        id={campaign.id}
        label={campaign.name || campaign.subject || "this campaign"}
      />
    </>
  );
}
