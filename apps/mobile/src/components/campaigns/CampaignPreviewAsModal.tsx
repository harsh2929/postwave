/**
 * CampaignPreviewAsModal — the honest answer to "what will they actually see?"
 *
 * The detail screen's preview is `htmlToText(body_html)`. That strips every
 * conditional marker and renders all branches at once, so an operator reviewing
 * a three-branch campaign reads a body no recipient will ever receive. Desktop
 * has answered this in two panels for a long time (DynamicContentPanel +
 * PreviewAsSubscriber); a phone is the single best place to ask the question
 * and was the only client that could not.
 *
 * Two halves, in the order the question is asked:
 *   1. WHICH branches exist (GET /campaigns/{id}/regions) — free, and it is
 *      what makes the flattened preview's dishonesty visible at all.
 *   2. What ONE person receives (POST /campaigns/{id}/preview-as) — resolved
 *      merge tags, resolved conditionals, plus the list of regions the gateway
 *      could NOT resolve and defaulted, so the result is never overclaimed.
 *
 * Read-scope on both endpoints, so this sheet stays available to a viewer who
 * cannot change anything — which is exactly the person asked to review a draft.
 */
import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SkeletonGroup, Skeleton } from "@/components/Skeleton";
import {
  ActionButton,
  Card,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { CampaignRegionBranchToggles } from "@/components/campaigns/CampaignRegionBranchToggles";
import {
  useCampaignRegions,
  usePreviewCampaignAs,
} from "@/hooks/useCampaignPreviewAs";
import { isValidTestEmail } from "@/hooks/useCampaigns";
import {
  campaignPreviewAsReading,
  campaignRegionRows,
  campaignRegionsSummary,
} from "@/lib/campaignPreviewAs";
import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Bound on the rendered resolved body — the same ceiling the preview card uses. */
const RESOLVED_BODY_CHARS = 4000;

export function CampaignPreviewAsModal({
  visible,
  onClose,
  campaignId,
  bodyHtml,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  campaignId: string;
  /** The SAVED body — what the branch toggles substitute against. */
  bodyHtml?: string | undefined;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const myEmail = useAuthStore((s) => s.session?.email ?? null);
  const [email, setEmail] = useState<string>(myEmail ?? "");

  const regions = useCampaignRegions(campaignId, { enabled: visible });
  const preview = usePreviewCampaignAs(campaignId);

  const resetPreview = preview.reset;
  useEffect(() => {
    if (!visible) return;
    setEmail(myEmail ?? "");
    resetPreview();
  }, [visible, myEmail, resetPreview]);

  const trimmed = email.trim();
  const valid = isValidTestEmail(trimmed);
  const runPreview = useCallback(() => {
    if (!valid) return;
    preview.mutate(trimmed);
  }, [preview, trimmed, valid]);

  const rows = campaignRegionRows(regions.data?.regions ?? null);
  const reading = campaignPreviewAsReading(preview.data);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Preview as a subscriber"
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Preview as subscriber" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 14,
          fontFamily: FONT.regular,
        }}
      >
        Merge tags and conditional regions are resolved against one real
        subscriber&apos;s fields, so this is what that person receives — not the
        merged blob the plain-text preview shows.
      </Text>

      <SectionHeading label="Dynamic regions" t={t} />
      {regions.isLoading ? (
        <SkeletonGroup label="Loading dynamic regions">
          <Skeleton height={48} radius={10} />
        </SkeletonGroup>
      ) : regions.data?.problem ? (
        <Text
          {...typeCap("label")}
          accessibilityRole="alert"
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {regions.data.problem}
        </Text>
      ) : (
        <RegionList rows={rows} t={t} />
      )}

      {/* Client-side substitution over the SAVED body (no server round trip),
          so a reviewer can sanity-check the branch no live subscriber hits. */}
      <CampaignRegionBranchToggles
        bodyHtml={bodyHtml ?? ""}
        regionsResponse={regions.data?.regions ?? null}
      />

      <View style={{ height: 20 }} />
      <SectionHeading label="Preview as" t={t} />

      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={email}
        onChangeText={setEmail}
        placeholder="subscriber@example.com"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={runPreview}
        accessibilityLabel="Subscriber email address"
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          minHeight: 44,
          fontSize: 15,
          fontFamily: FONT.regular,
        }}
      />

      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <ActionButton
          label={preview.isPending ? "Rendering…" : "Preview"}
          primary
          onPress={runPreview}
          disabled={!valid || preview.isPending}
        />
      </View>

      {!valid && trimmed.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            marginTop: 8,
            fontFamily: FONT.medium,
          }}
        >
          That doesn&apos;t look like an email address.
        </Text>
      ) : null}

      {preview.isError ? (
        <Text
          {...typeCap("label")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 12,
            fontFamily: FONT.medium,
          }}
        >
          {preview.error instanceof Error
            ? preview.error.message
            : "Couldn't render the preview."}
        </Text>
      ) : null}

      {preview.data ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          {reading.caveat ? (
            <Text
              {...typeCap("caption")}
              accessibilityRole="alert"
              style={{
                color: t.warning,
                ...typeStyle("caption"),
                fontFamily: FONT.medium,
              }}
            >
              {reading.caveat}
            </Text>
          ) : null}
          <Card>
            <Text
              {...typeCap("bodySmall")}
              selectable
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                writingDirection: "auto",
              }}
            >
              {reading.text.slice(0, RESOLVED_BODY_CHARS) ||
                "This campaign has no body to render yet."}
            </Text>
          </Card>
        </View>
      ) : null}
    </KeyboardFormSheet>
  );
}

function SectionHeading({ label, t }: { label: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("caption")}
      accessibilityRole="header"
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        letterSpacing: 0.6,
        textTransform: "uppercase",
        fontWeight: "600",
        fontFamily: FONT.semibold,
        marginBottom: 8,
      }}
    >
      {label}
    </Text>
  );
}

function RegionList({
  rows,
  t,
}: {
  rows: ReturnType<typeof campaignRegionRows>;
  t: ThemeTokens;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {campaignRegionsSummary(rows)}
      </Text>
      {rows.map((row) => (
        <View
          key={row.id}
          accessible
          accessibilityLabel={`Region ${row.key}${
            row.depth > 0 ? `, nested at level ${row.depth + 1}` : ""
          }${row.hasElse ? ", has an alternative branch" : ""}${
            row.sample ? `. Begins: ${row.sample}` : ""
          }`}
          style={{
            marginStart: row.depth * 14,
            borderLeftColor: t.borderSubtle,
            borderLeftWidth: row.depth > 0 ? 1 : 0,
            paddingStart: row.depth > 0 ? 8 : 0,
          }}
        >
          <Text
            {...typeCap("mono")}
            style={{
              color: t.fg,
              ...typeStyle("mono"),
              fontFamily: FONT.medium,
            }}
          >
            {row.key}
            {/* Not colour-alone: the alternative branch is stated in words.
                Carries `mono` explicitly rather than leaning on nested-Text
                inheritance, so re-roling the parent cannot silently re-role
                this. */}
            {row.hasElse ? (
              <Text
                {...typeCap("mono")}
                style={{ color: t.fgSubtle, fontFamily: FONT.regular }}
              >
                {"  · has an else branch"}
              </Text>
            ) : null}
          </Text>
          {row.sample ? (
            <Text
              {...typeCap("caption")}
              numberOfLines={1}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {row.sample}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
