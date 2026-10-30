/**
 * CampaignPresendChecks — the three opt-in checks that join the send flow.
 *
 * All press-driven, none auto-fired (hooks/useCampaignPresendChecks says why:
 * LLM cost, a whole-body walk, and a churn-score scan respectively):
 *
 *   AI VERDICT   POST /presend/verdict   — editor. Desktop's CopilotRail row.
 *   A11Y CHECK   POST /a11y/check        — ADMIN in the manifest; the card is
 *                rendered for admins only, never disabled for editors.
 *   CHURN REFINE GET/POST/DELETE /campaigns/{id}/presend-refine — read is
 *                viewer (everyone sees the active exclusion set); preview /
 *                apply / clear are editor verbs and appear only for editors.
 *
 * Role gating is BY OMISSION at this component's props: the caller passes the
 * session's computed capabilities and anything a role cannot use is simply
 * not rendered — with one caption naming the rule where the whole cluster is
 * read-only.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignA11yCheck,
  useCampaignPresendRefine,
  useCampaignPresendRefineWrite,
  useCampaignVerdictCheck,
} from "@/hooks/useCampaignPresendChecks";
import { a11yHeadline, a11yTone } from "@/lib/campaignA11y";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  REFINE_DEFAULT_THRESHOLD,
  REFINE_THRESHOLD_OPTIONS,
  refineSummary,
} from "@/lib/campaignPresendRefine";
import { verdictHeadline, verdictTone } from "@/lib/campaignVerdict";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TONE_PILL: Record<string, "success" | "warning" | "danger" | "neutral"> =
  {
    success: "success",
    warning: "warning",
    danger: "danger",
    neutral: "neutral",
  };

function Headline({
  text,
  tone,
  t,
}: {
  text: string;
  tone: "success" | "warning" | "danger" | "neutral";
  t: ThemeTokens;
}) {
  const color =
    tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.fg;
  return (
    <Text
      {...typeCap("bodySmall")}
      accessibilityRole="alert"
      style={{
        color,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.semibold,
        marginTop: 8,
      }}
    >
      {text}
    </Text>
  );
}

export function CampaignPresendChecks({
  campaignId,
  subject,
  bodyHtml,
  fromLine,
  canEdit,
  canAdmin,
  visible,
  disabled,
}: {
  campaignId: string;
  subject: string;
  bodyHtml: string;
  /** What the From header will read — input to the verdict's checks. */
  fromLine: string;
  canEdit: boolean;
  canAdmin: boolean;
  /** The sheet's visibility — gates the refine read like every sheet query. */
  visible: boolean;
  disabled: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const verdict = useCampaignVerdictCheck();
  const a11y = useCampaignA11yCheck();
  const refine = useCampaignPresendRefine(campaignId, { enabled: visible });
  const refineWrite = useCampaignPresendRefineWrite(campaignId);
  const [threshold, setThreshold] = useState(REFINE_DEFAULT_THRESHOLD);

  const fail = (fallback: string) => (err: unknown) =>
    toast({ kind: "error", message: campaignErrorMessage(err, fallback) });

  const shownRefine = refineWrite.data ?? refine.data ?? null;
  const refineBusy = refineWrite.isPending || disabled;

  return (
    <Card>
      <Text
        {...typeCap("callout")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          marginBottom: 8,
        }}
      >
        Optional pre-send checks
      </Text>

      {canEdit ? (
        <View style={{ marginBottom: 12 }}>
          <ActionButton
            label={verdict.isPending ? "Asking…" : "Get AI verdict"}
            onPress={() => {
              if (verdict.isPending || disabled) return;
              haptics.tap();
              verdict.mutate(
                { campaignId, subject, html: bodyHtml, from: fromLine },
                { onError: fail("Couldn't get a verdict.") },
              );
            }}
            disabled={verdict.isPending || disabled}
          />
          {verdict.data ? (
            <>
              <Headline
                text={verdictHeadline(verdict.data)}
                tone={verdictTone(verdict.data.verdict)}
                t={t}
              />
              {verdict.data.components.map((row) => (
                <Text
                  key={row.name}
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    marginTop: 2,
                  }}
                >
                  {row.label}
                  {row.scoreLabel ? ` ${row.scoreLabel}` : ""}
                  {row.status ? ` · ${row.status}` : ""}
                  {row.message ? ` — ${row.message}` : ""}
                </Text>
              ))}
            </>
          ) : null}
        </View>
      ) : null}

      {canAdmin ? (
        <View style={{ marginBottom: 12 }}>
          <ActionButton
            label={a11y.isPending ? "Checking…" : "Check accessibility"}
            onPress={() => {
              if (a11y.isPending || disabled) return;
              haptics.tap();
              a11y.mutate(
                { html: bodyHtml, subject },
                { onError: fail("Couldn't run the accessibility check.") },
              );
            }}
            disabled={a11y.isPending || disabled}
          />
          {a11y.data ? (
            <>
              <Headline
                text={a11yHeadline(a11y.data)}
                tone={a11yTone(a11y.data)}
                t={t}
              />
              {a11y.data.findings.map((finding) => (
                <Text
                  key={finding.key}
                  {...typeCap("caption")}
                  style={{
                    color:
                      finding.severity === "error" ? t.danger : t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    marginTop: 2,
                  }}
                >
                  {finding.message}
                  {finding.wcag ? ` (${finding.wcag})` : ""}
                </Text>
              ))}
              {a11y.data.truncated ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    marginTop: 2,
                  }}
                >
                  More findings on the web app.
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      <View>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {shownRefine
            ? refineSummary(shownRefine)
            : "Churn-risk refine: hold likely-unsubscribers back into a cooling-off window instead of sending to them."}
        </Text>
        {shownRefine?.sample.length ? (
          <View style={{ marginTop: 6, gap: 2 }}>
            {shownRefine.sample.map((row) => (
              <Text
                key={row.id}
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {row.email} · churn {Math.round(row.churnScore)}
                {row.reason ? ` — ${row.reason}` : ""}
              </Text>
            ))}
          </View>
        ) : null}
        {canEdit ? (
          <View style={{ marginTop: 10, gap: 8 }}>
            <SegmentedControl<string>
              options={REFINE_THRESHOLD_OPTIONS.map((v) => ({
                value: String(v),
                label: `≥${v}`,
              }))}
              value={String(threshold)}
              onChange={(next) => setThreshold(Number(next))}
              accessibilityLabel="Churn score threshold"
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <ActionButton
                label="Preview excluded"
                onPress={() => {
                  if (refineBusy) return;
                  haptics.tap();
                  refineWrite.mutate(
                    { kind: "preview", churnThreshold: threshold },
                    { onError: fail("Couldn't preview the exclusion set.") },
                  );
                }}
                disabled={refineBusy}
              />
              <ActionButton
                label="Apply"
                primary
                onPress={() => {
                  if (refineBusy) return;
                  haptics.impact();
                  refineWrite.mutate(
                    { kind: "apply", churnThreshold: threshold },
                    {
                      onSuccess: () =>
                        toast({
                          kind: "success",
                          message: "Churn-risk exclusions applied to this send.",
                        }),
                      onError: fail("Couldn't apply the exclusion set."),
                    },
                  );
                }}
                disabled={refineBusy}
              />
              {refine.data ? (
                <ActionButton
                  label="Clear"
                  danger
                  onPress={() => {
                    if (refineBusy) return;
                    haptics.tap();
                    refineWrite.mutate(
                      { kind: "clear" },
                      {
                        onSuccess: () =>
                          toast({
                            kind: "success",
                            message:
                              "Exclusions cleared — everyone re-enters the send.",
                          }),
                        onError: fail("Couldn't clear the exclusion set."),
                      },
                    );
                  }}
                  disabled={refineBusy}
                />
              ) : null}
            </View>
          </View>
        ) : shownRefine ? (
          <View style={{ marginTop: 8 }}>
            <Pill
              label="Changing the exclusion set needs the editor role"
              tone="neutral"
            />
          </View>
        ) : null}
      </View>
    </Card>
  );
}
