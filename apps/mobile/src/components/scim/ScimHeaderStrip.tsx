/**
 * ScimHeaderStrip — the SCIM screen's counter tiles and its freshness line.
 *
 * Extracted for the reason the governance audit gave: four enterprise screens
 * had each re-declared `card(t)` and `sectionLabel(t)` as private style
 * factories, byte-identical to the real shared components and to each other,
 * and they had already drifted on accessibility. The tiles here are the shared
 * `Card`; the screen's headings are the shared `SectionLabel`. A change to card
 * radius is now one edit rather than five.
 *
 * A counter renders an EM-DASH, never `0`, when its query failed or never ran.
 * On a provisioning screen "0 active tokens" reads as "SSO is not set up" —
 * the single most alarming thing an unfetched screen could say to an admin.
 */
import { Text } from "react-native";

import { Card } from "@/components/Card";
import { freshnessSentence, oldestUpdatedAt } from "@/lib/auditGrouping";
import { EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ScimMetricProps {
  label: string;
  /** null means "not measured" — rendered as an em-dash, never as zero. */
  value: number | null;
  hint?: string | undefined;
}

export function ScimMetric({ label, value, hint }: ScimMetricProps) {
  const { t } = useTheme();
  const display = value === null ? EMDASH : num(value);
  return (
    <Card
      variant="compact"
      style={{ flex: 1, marginBottom: 0 }}
      accessible
      accessibilityLabel={
        value === null
          ? `${label} failed to load`
          : `${display} ${label}${hint ? `, ${hint}` : ""}`
      }
    >
      {/* Stat hero on the scale's tightest ceiling; the compact 22pt size is
          deliberate for a two-up counter strip. Label and hint are prose and
          wrap rather than truncate as the OS text size grows. */}
      <Text
        {...typeCap("figure")}
        style={{
          color: t.accent,
          fontSize: 22,
          lineHeight: 26,
          fontWeight: "700",
          fontFamily: FONT.display,
        }}
        numberOfLines={1}
      >
        {display}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * "Provisioning state as of 3m ago."
 *
 * A screen fed by two queries is only as fresh as its STALEST one, so the
 * line is derived from the OLDEST stamp — a freshness indicator that
 * overstates freshness is worse than none, because it is trusted. Renders
 * nothing until something has actually loaded.
 */
export function ScimFreshness({
  stamps,
  now,
}: {
  stamps: readonly (number | null | undefined)[];
  now: number;
}) {
  const { t } = useTheme();
  const sentence = freshnessSentence(
    "Provisioning state",
    oldestUpdatedAt(stamps),
    now,
  );
  if (!sentence) return null;
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 8,
      }}
    >
      {sentence}
    </Text>
  );
}
