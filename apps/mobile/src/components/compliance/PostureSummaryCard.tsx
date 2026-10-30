/**
 * PostureSummaryCard — "is anything about to lapse", with the qualifier that
 * keeps it honest.
 *
 * The whole judgement is in `lib/compliancePosture` (pure, node-tested); this
 * component only paints it.
 *
 * THE QUALIFIER IS NOT DECORATION. A "0 due soon" headline is silent about the
 * attested framework whose renewal date was never recorded, and about the one
 * whose status the server sent in a shape this app does not model. Both are
 * invisible in the count and both are exactly what a compliance owner is
 * scanning for, so the qualifier names every category the headline skipped.
 *
 * THE COUNT STRIP CARRIES EXACT SPOKEN VALUES. Each tile's visible number is
 * hidden from assistive tech and the tile's own label speaks it in full, so a
 * VoiceOver user hears "2 lapsed" rather than a bare "2" beside a word.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import {
  postureHeadline,
  postureQualifier,
  type CompliancePosture,
} from "@/lib/compliancePosture";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Tile {
  key: string;
  value: number;
  label: string;
  spoken: string;
  tone: PillTone;
}

function tilesFor(posture: CompliancePosture): Tile[] {
  return [
    {
      key: "attested",
      value: posture.attested,
      label: "Attested",
      spoken: `${plural(posture.attested, "framework")} with an attestation on file, out of ${plural(posture.tracked, "tracked framework")}`,
      tone: "success",
    },
    {
      key: "lapsed",
      value: posture.lapsed,
      label: "Lapsed",
      spoken: `${plural(posture.lapsed, "attestation")} past its own renewal date`,
      tone: "danger",
    },
    {
      key: "due",
      value: posture.dueSoon,
      label: "Renew soon",
      spoken: `${plural(posture.dueSoon, "attestation")} renewing soon`,
      tone: "warning",
    },
    {
      key: "no-record",
      value: posture.noRecord,
      label: "No record",
      spoken: `${plural(posture.noRecord, "framework")} with no attestation record`,
      tone: "neutral",
    },
  ];
}

export function PostureSummaryCard({
  posture,
}: {
  posture: CompliancePosture;
}) {
  const { t } = useTheme();
  const headline = postureHeadline(posture);
  const qualifier = postureQualifier(posture);
  const tone: PillTone =
    posture.lapsed > 0
      ? "danger"
      : posture.dueSoon > 0 || posture.renewalUnset > 0
        ? "warning"
        : posture.tracked === 0
          ? "neutral"
          : "success";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 12,
      }}
    >
      <View accessible accessibilityLabel={`${headline} ${qualifier}`}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pill
            label={
              posture.lapsed > 0
                ? "attention"
                : posture.dueSoon > 0
                  ? "renewals ahead"
                  : "compliance posture"
            }
            tone={tone}
          />
        </View>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            marginTop: 8,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {headline}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {qualifier}
        </Text>
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        {tilesFor(posture).map((tile) => (
          <View
            key={tile.key}
            accessible
            accessibilityLabel={tile.spoken}
            style={{ minWidth: 74, minHeight: 44, flexGrow: 1 }}
          >
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              {...typeCap("figure")}
              style={{
                color:
                  tile.value > 0 && tile.tone === "danger"
                    ? t.danger
                    : tile.value > 0 && tile.tone === "warning"
                      ? t.warning
                      : t.fg,
                ...typeStyle("figure"),
                fontFamily: FONT.semibold,
              }}
            >
              {num(tile.value)}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                marginTop: 2,
                fontFamily: FONT.regular,
              }}
            >
              {tile.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
