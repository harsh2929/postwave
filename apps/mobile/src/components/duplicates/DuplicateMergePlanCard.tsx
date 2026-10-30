/**
 * DuplicateMergePlanCard — the server's own plan for ONE pair, rendered.
 *
 * This is the escalation that replaces a typed-phrase gate. It is not a
 * paraphrase of what merging does in general: every line comes from the
 * `dry_run: true` response for this exact pair (merge/apply.go:325-338), which
 * the real apply must then replay by fingerprint. If it cannot load, no merge
 * button appears.
 *
 * `preserved_on_duplicate` is the server's list of what the merge does NOT
 * touch (apply.go:161-165). It is shown because the most common fear at this
 * moment — "will this delete their address" — is answered by it, and the
 * answer is no.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { dateTime, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { DuplicateMergePlan } from "@/lib/duplicateMergePlan";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DuplicateMergePlanCardProps {
  plan: DuplicateMergePlan;
  survivorEmail: string;
  loserEmail: string;
}

export function DuplicateMergePlanCard({
  plan,
  survivorEmail,
  loserEmail,
}: DuplicateMergePlanCardProps) {
  const { t } = useTheme();
  const survivor = survivorEmail || "the surviving record";
  const loser = loserEmail || "the duplicate record";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 12,
        marginTop: 12,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Exact server plan
      </Text>

      <PlanLine
        label="Ends up"
        value={plan.status || "status not reported"}
        spoken={`The merged record ends up ${plan.status || "with a status the server did not report"}`}
      />
      <PlanLine
        label="Tags"
        value={
          plan.tags.length === 0
            ? "none"
            : `${num(plan.tags.length)} after union`
        }
        spoken={`${plan.tags.length} tags after the union`}
      />
      <PlanLine
        label="Custom fields"
        value={
          plan.customFieldCount === null
            ? "—"
            : `${num(plan.customFieldCount)} after union`
        }
        spoken={
          plan.customFieldCount === null
            ? "The server did not report a custom-field count"
            : `${plan.customFieldCount} custom fields after the union`
        }
      />
      <PlanLine
        label="Consent kept from"
        value={plan.consentTimestamp ? dateTime(plan.consentTimestamp) : "no consent timestamp on either record"}
        spoken={
          plan.consentTimestamp
            ? `Consent is kept from ${dateTime(plan.consentTimestamp)}, the earlier of the two`
            : "Neither record carries a consent timestamp"
        }
      />

      {plan.conflicts.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {plan.conflicts.length === 1
              ? "1 field disagrees"
              : `${plan.conflicts.length} fields disagree`}
          </Text>
          {plan.conflicts.map((conflict) => (
            <Text
              key={conflict.field}
              {...typeCap("bodySmall")}
              accessibilityLabel={`${conflict.field}: ${survivor} has ${conflict.survivorValue}, ${loser} has ${conflict.duplicateValue}. Resolved by ${resolutionWords(conflict.resolution)}.`}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {conflict.field} — keeps {conflict.survivorValue}, drops{" "}
              {conflict.duplicateValue} ({resolutionWords(conflict.resolution)})
            </Text>
          ))}
        </View>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No field disagrees between these two records.
        </Text>
      )}

      {plan.preserved.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Kept on {loser}
          </Text>
          {plan.preserved.map((item) => (
            <Text
              key={item}
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {item}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The server's `resolution` vocabulary, said in words.
 *
 * An unknown value is echoed rather than mapped to "other": a new resolution
 * rule shipping before the app updates must still name itself in a screen
 * whose entire job is to be exact.
 */
function resolutionWords(resolution: string): string {
  if (resolution === "primary_wins") return "the survivor wins";
  if (resolution === "most_restrictive_wins") return "the stricter value wins";
  return resolution || "resolution not stated";
}

function PlanLine({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
