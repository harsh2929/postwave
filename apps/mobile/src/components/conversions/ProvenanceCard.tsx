/**
 * ProvenanceCard — how confident the attribution above it actually is.
 *
 * THIS CARD IS THE POINT OF THE SCREEN, NOT A FOOTNOTE. The revenue-by-campaign
 * list one section below is only as trustworthy as the way its conversions got
 * their campaign, and the backend is unusually honest about that: it reports
 * six separate provenance buckets and its own type comment instructs clients
 * never to present `last_touch` as certain (attribution.go:133-146). A client
 * that shows the money and hides the provenance is discarding the one piece of
 * information that stops a heuristic being read as a fact.
 *
 * SIX BUCKETS, SIX DIFFERENT STATEMENTS, NEVER MERGED:
 *   explicit     — the conversion arrived carrying its campaign id.
 *   last touch   — the server joined it to the subscriber's most recent click
 *                  within the previous 7 days. A guess, and labelled as one.
 *   none         — no campaign id and no click in that window. Genuinely
 *                  unattributed, and that is a measurement, not a gap.
 *   code         — linked through one issued-code assignment; not redeemer or
 *                  reader identity.
 *   vanity path  — linked through a shared campaign path; campaign scope only.
 *   unclassified — a pre-migration row the backfill has not stamped. Neither
 *                  attributed nor known to be unattributed.
 *
 * State is never colour alone: each row is a word, a count and a percentage.
 */
import { Text, View } from "react-native";

import { SectionLabel } from "@/components/SectionLabel";
import {
  lastTouchNotice,
  provenanceShares,
  unclassifiedNotice,
} from "@/lib/attributionVerdict";
import type { AttributionProvenance } from "@/lib/conversionAttribution";
import { EMDASH, num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Row {
  key: string;
  label: string;
  count: number;
  /** null when the window holds no conversions — a share of nothing, not 0%. */
  share: number | null;
  /** Read out after the figures — the sentence that makes the bucket mean something. */
  meaning: string;
}

export function ProvenanceCard({
  provenance,
}: {
  provenance: AttributionProvenance;
}) {
  const { t } = useTheme();
  const shares = provenanceShares(provenance);
  const lastTouch = lastTouchNotice(provenance);
  const unclassified = unclassifiedNotice(provenance);

  const rows: Row[] = [
    {
      key: "explicit",
      label: "Tagged by the caller",
      count: provenance.explicit,
      share: shares?.explicit ?? null,
      meaning: "the conversion arrived carrying its campaign id",
    },
    {
      key: "lastTouch",
      label: "Matched by last touch",
      count: provenance.lastTouch,
      share: shares?.lastTouch ?? null,
      meaning:
        "joined to the subscriber's most recent click in the previous 7 days — a heuristic, not a tag",
    },
    {
      key: "none",
      label: "No campaign found",
      count: provenance.none,
      share: shares?.none ?? null,
      meaning: "no campaign id and no click in the window — genuinely unattributed",
    },
    {
      key: "codeRedemption",
      label: "Linked by issued code",
      count: provenance.codeRedemption,
      share: shares?.codeRedemption ?? null,
      meaning:
        "linked through one campaign assignment — not proof of who redeemed the code or read the message",
    },
    {
      key: "campaignVanityPath",
      label: "Linked by shared path",
      count: provenance.campaignVanityPath,
      share: shares?.campaignVanityPath ?? null,
      meaning:
        "linked through a shared campaign path — campaign-scope evidence only",
    },
    {
      key: "unclassified",
      label: "Not classified yet",
      count: provenance.unclassified,
      share: shares?.unclassified ?? null,
      meaning: "predates attribution recording and has not been backfilled",
    },
  ];

  return (
    <View>
      <SectionLabel subtitle="How each conversion in this window got its campaign. The server reports all six classes separately so neither a heuristic nor an outcome link is read as identity proof.">
        How confident is this
      </SectionLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          gap: 10,
        }}
      >
        {rows.map((row) => (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${row.label}: ${num(row.count)} conversions${
              row.share === null ? "" : `, ${percent(row.share)} of the window`
            }. ${row.meaning}.`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              minHeight: 28,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                flex: 1,
                fontFamily: FONT.regular,
              }}
              numberOfLines={2}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fg,
                ...typeStyle("numeric"),
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.semibold,
              }}
            >
              {num(row.count)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontVariant: ["tabular-nums"],
                minWidth: 52,
                textAlign: "right",
                fontFamily: FONT.regular,
              }}
            >
              {row.share === null ? EMDASH : percent(row.share)}
            </Text>
          </View>
        ))}
      </View>

      {lastTouch ? <Note text={lastTouch} /> : null}
      {unclassified ? <Note text={unclassified} /> : null}
    </View>
  );
}

function Note({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("label"),
        marginTop: 8,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
