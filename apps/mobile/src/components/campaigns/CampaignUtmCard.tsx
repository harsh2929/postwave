/**
 * CampaignUtmCard — what link tagging this campaign will actually apply.
 *
 * This is the last-check-before-send that desktop's UTMTemplatesPanel serves
 * (CampaignDetailPresentation.tsx:430), reshaped for a phone. It answers three
 * questions in the order they get asked:
 *
 *   1. WILL anything be added to my links? (the summary line)
 *   2. WHAT exactly? (the five parameters, unset ones dashed rather than
 *      hidden — "utm_term is not set" is information)
 *   3. SHOW me. (paste a real link, get the rewritten one back from the same
 *      rewriter the sender uses — POST /utm-templates/preview)
 *
 * WHAT IT DOES NOT DO, AND WHY. It does not edit the five values. Authoring a
 * tagging convention is a workspace-wide decision made once; a phone-sized
 * form for it would invite someone to change how EVERY campaign's links are
 * attributed while standing in a queue. The one write offered is "use the
 * workspace default here", which is idempotent, reversible on desktop, and the
 * only thing the API's per-campaign upsert can honestly be called.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";

import { CampaignInsightCard } from "@/components/campaigns/CampaignInsightCard";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { CampaignUtmAdminActions } from "@/components/campaigns/CampaignUtmAdminActions";
import { useUtmPreview, useUtmTemplates } from "@/hooks/useCampaignUtm";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  resolveCampaignUtm,
  utmParamRows,
  utmPreviewProblem,
} from "@/lib/campaignUtm";
import { FONT } from "@/lib/fonts";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignUtmCardProps {
  campaignId: string;
  expanded: boolean;
  onToggle: () => void;
  /**
   * The upsert route is ScopeAdmin — an editor who can change everything else
   * on this campaign cannot change its tagging (see api/campaignUtm.ts).
   */
  canAdmin: boolean;
}

export function CampaignUtmCard({
  campaignId,
  expanded,
  onToggle,
  canAdmin,
}: CampaignUtmCardProps) {
  const { t } = useTheme();
  const templates = useUtmTemplates(expanded);
  const preview = useUtmPreview(campaignId);
  const [url, setUrl] = useState("");

  const resolution = resolveCampaignUtm(templates.data ?? [], campaignId);
  const rows = utmParamRows(resolution.effective);
  const problem = utmPreviewProblem(url);
  const canPreview = url.trim().length > 0 && problem === null;

  return (
    <CampaignInsightCard
      title="Link tagging"
      caption="The UTM parameters that will be appended to this campaign's links when it sends."
      expanded={expanded}
      onToggle={onToggle}
      loading={templates.isLoading}
      error={templates.error}
      onRetry={() => void templates.refetch()}
      // Never "empty": a workspace with no tagging configured is a real,
      // meaningful answer, and the summary states it.
      empty={false}
      emptyMessage=""
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          lineHeight: 19,
          marginBottom: 10,
          fontFamily: FONT.regular,
        }}
      >
        {resolution.summary}
      </Text>

      <View
        style={{
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 4,
          marginBottom: 12,
        }}
      >
        {rows.map((row, index) => (
          <View
            key={row.key}
            accessible
            accessibilityLabel={
              row.value === "—"
                ? `${row.label}, not set`
                : `${row.label}, ${row.value}`
            }
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              paddingVertical: 8,
              borderBottomColor: t.borderSubtle,
              borderBottomWidth: index === rows.length - 1 ? 0 : 1,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("caption")}
              numberOfLines={1}
              style={{
                color: row.value === "—" ? t.fgSubtle : t.fg,
                ...typeStyle("caption"),
                flexShrink: 1,
                textAlign: "right",
                fontFamily: FONT.regular,
              }}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>

      {/* The proof. Read-scope, so the viewer asked to check the send can run
          it — and it goes through the SAME rewriter the sender uses rather
          than a client-side approximation that could disagree. */}
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        Check a link
      </Text>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={url}
        onChangeText={setUrl}
        placeholder="https://yourdomain.com/spring"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="A link from this campaign to check"
        {...(problem ? { accessibilityHint: problem } : {})}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        returnKeyType="go"
        onSubmitEditing={() => {
          if (canPreview) preview.mutate(url.trim());
        }}
        style={{
          color: t.fg,
          fontSize: 15,
          fontFamily: FONT.regular,
          borderColor: problem ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          minHeight: 44,
          backgroundColor: t.surface,
        }}
      />
      {problem ? (
        <Text
          {...typeCap("caption")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {problem}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <ActionButton
          label={preview.isPending ? "Checking…" : "Preview"}
          onPress={() => preview.mutate(url.trim())}
          disabled={!canPreview || preview.isPending}
        />
        {/* The three ADMIN verbs (per-campaign apply, workspace-default
            upsert + delete) live in their own component — all ScopeAdmin,
            all omitted below canAdmin (CampaignUtmAdminActions). */}
        <CampaignUtmAdminActions
          campaignId={campaignId}
          resolution={resolution}
          canAdmin={canAdmin}
        />
      </View>

      {preview.isError ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            marginTop: 10,
            lineHeight: 16,
            fontFamily: FONT.regular,
          }}
        >
          {campaignErrorMessage(preview.error, "Couldn't check that link.")}
        </Text>
      ) : preview.data ? (
        <View
          accessible
          accessibilityLabel={`Tagged link: ${preview.data.rewritten}`}
          style={{
            backgroundColor: t.bgSubtle,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginTop: 10,
          }}
        >
          <Text
            {...typeCap("caption")}
            selectable
            style={{
              color: t.fg,
              ...typeStyle("caption"),
              lineHeight: 17,
              fontFamily: FONT.regular,
            }}
          >
            {preview.data.rewritten}
          </Text>
          {preview.data.rewritten === preview.data.original ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 6,
                fontFamily: FONT.regular,
              }}
            >
              Unchanged — nothing is added to this link.
            </Text>
          ) : null}
        </View>
      ) : null}
    </CampaignInsightCard>
  );
}
