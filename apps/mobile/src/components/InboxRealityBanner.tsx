/**
 * InboxRealityBanner (mobile) — RN port of the desktop pre-send
 * placement predictor banner. Calls POST /api/v1/predict and renders
 * three stacked progress bars for Primary / Promotions / Spam.
 *
 * When predicted-Primary < 70%, two recovery affordances surface:
 *   - "Why?" expands a one-paragraph muted explanation derived from
 *     the `risk` breakdown the predictor returns.
 *   - "Improve subject" is forwarded to the parent so the user can
 *     pick a healthier subject without leaving the sheet.
 *
 * Honest-fallback policy: 404/405/501/503 → muted "unavailable yet"
 * message. The Continue button stays enabled so the user is never
 * blocked by a flaky predictor.
 */
import { type ReactElement, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useInboxRealityPrediction } from "@/hooks/useInboxRealityPrediction";
import { FONT } from "@/lib/fonts";
import { inboxRealityRiskExplanation } from "@/lib/inboxRealityRisk";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Props {
  subject: string;
  bodyHtml: string;
  /** Called when the user taps "Send now" / "Continue". */
  onContinue: () => void;
  /** Called when the user taps "Cancel". */
  onCancel: () => void;
  /** Called when the user taps "Improve subject" in the low-primary
   *  branch. Optional — when omitted the button is hidden. */
  onImproveSubject?: () => void;
  /** Whether the parent is mid-send (disables both buttons). */
  busy?: boolean;
  /** Continue-button label. Defaults to "Send now". */
  continueLabel?: string;
}

function pct(n: number | undefined | null): number {
  if (n == null || Number.isNaN(n)) return 0;
  const v = n > 1 ? n : n * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

export function InboxRealityBanner({
  subject,
  bodyHtml,
  onContinue,
  onCancel,
  onImproveSubject,
  busy,
  continueLabel,
}: Props): ReactElement {
  const { t } = useTheme();
  const [whyOpen, setWhyOpen] = useState<boolean>(false);
  // Prediction, its inputs and its failure copy all live in the hook: the
  // signals it depends on now resolve through the query cache, which made the
  // inline effect the largest thing in this file and the least visible.
  const {
    loading,
    prediction: pred,
    error: errMsg,
  } = useInboxRealityPrediction(subject, bodyHtml);

  const primary = pct(pred?.predicted?.primary);
  const promo = pct(pred?.predicted?.promotions);
  const spam = pct(pred?.predicted?.spam);
  const lowPrimary = pred != null && primary > 0 && primary < 70;
  const riskExplanation = inboxRealityRiskExplanation(pred?.risk);

  const renderBar = (
    label: string,
    value: number,
    fill: string,
  ): ReactElement => (
    <View style={{ marginBottom: 8 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontWeight: "700",
            fontFamily: FONT.bold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}%
        </Text>
      </View>
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: t.surfaceElevated,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${value}%`,
            backgroundColor: fill,
          }}
        />
      </View>
    </View>
  );

  const skeletonBar = (key: number): ReactElement => (
    <View
      key={key}
      style={{
        height: 14,
        marginBottom: 6,
        borderRadius: 4,
        backgroundColor: t.surfaceElevated,
      }}
    />
  );

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
      }}
      accessibilityLabel="Inbox Reality prediction"
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        {/* Decorative glyph standing in for an icon, already hidden from
            assistive tech — the one case where switching font scaling off is
            correct, because an icon that grows to 42pt beside a capped
            headline is a rendering bug rather than an accommodation. */}
        <Text
          allowFontScaling={false}
          style={{ color: t.accent, fontSize: 14, fontFamily: FONT.regular }}
          aria-hidden
        >
          {"✦"}
        </Text>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {loading
            ? "Inbox Reality is predicting placement…"
            : errMsg
              ? "Inbox Reality"
              : `Inbox Reality predicts ${primary}% primary, ${promo}% promo, ${spam}% spam`}
        </Text>
      </View>

      {loading ? (
        <View>{[0, 1, 2].map((i) => skeletonBar(i))}</View>
      ) : errMsg ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {errMsg} — sending will proceed without a placement preview.
        </Text>
      ) : (
        <View>
          {renderBar("Primary", primary, t.success)}
          {renderBar("Promotions", promo, t.warning)}
          {renderBar("Spam", spam, t.danger)}
        </View>
      )}

      {lowPrimary ? (
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            marginTop: 8,
          }}
        >
          <Pressable
            onPress={() => setWhyOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Explain why primary is low"
            style={{
              backgroundColor: t.bgSubtle,
              borderColor: t.border,
              borderWidth: 1,
              paddingHorizontal: 12,
              paddingVertical: 6,
              minHeight: 44,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {whyOpen ? "Hide why" : "Why?"}
            </Text>
          </Pressable>
          {onImproveSubject ? (
            <Pressable
              onPress={onImproveSubject}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Improve subject line"
              style={{
                backgroundColor: t.bgSubtle,
                borderColor: t.border,
                borderWidth: 1,
                paddingHorizontal: 12,
                paddingVertical: 6,
                minHeight: 44,
                borderRadius: 8,
                opacity: busy ? 0.5 : 1,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.fg,
                  ...typeStyle("control"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                Improve subject
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {whyOpen && pred ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {riskExplanation ??
            "The predictor did not return a component risk breakdown for this run."}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 14,
        }}
      >
        <Pressable
          onPress={onCancel}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.border,
            borderWidth: 1,
            paddingHorizontal: 14,
            paddingVertical: 10,
            minHeight: 44,
            borderRadius: 10,
            opacity: busy ? 0.5 : 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={onContinue}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue"
          style={{
            backgroundColor: t.accent,
            paddingHorizontal: 14,
            paddingVertical: 10,
            minHeight: 44,
            borderRadius: 10,
            opacity: busy ? 0.7 : 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accentFg,
              ...typeStyle("callout"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {busy ? "Sending…" : (continueLabel ?? "Send now")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
