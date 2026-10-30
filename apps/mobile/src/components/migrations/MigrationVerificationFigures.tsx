/**
 * MigrationVerificationFigures — the counted half of a verification report.
 *
 * Split out of `MigrationDetailSheet` so the sheet stays inside its function
 * budget, and because these two blocks answer different questions: the sheet
 * above says whether the migration is SAFE TO SIGN OFF, this says WHAT CAME
 * ACROSS.
 *
 * EVERY FIGURE CAN BE ABSENT. `parseMigrationVerification` returns `number |
 * null` for each count, never a coerced 0, because a report that omits
 * `templates_imported` is not a report saying no templates were imported — and
 * "0 templates" is exactly the sentence that makes an operator go re-run a
 * migration that was fine. `num()` renders null as an em-dash by default and
 * the spoken label says "not reported".
 */
import { Text, View } from "react-native";

import type {
  MigrationResourceRow,
  MigrationVerification,
} from "@/lib/migrationVerification";
import { EMDASH, num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Resource rows shown before the list is truncated. */
const RESOURCE_CAP = 10;

export function MigrationVerificationFigures({
  report,
}: {
  report: MigrationVerification;
}) {
  const { t } = useTheme();
  const hidden = Math.max(0, report.resources.length - RESOURCE_CAP);
  return (
    <>
      <Heading>What came across</Heading>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Figure label="Subscribers" value={report.subscribersImported} />
        <Figure label="Suppressed" value={report.suppressionListSize} />
      </View>
      <View
        style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}
      >
        <Figure label="Segments" value={report.segmentsTranslated} />
        <Figure label="Automations" value={report.automationsTranslated} />
      </View>
      <View
        style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}
      >
        <Figure label="Templates" value={report.templatesImported} />
        <Figure label="Archived sends" value={report.archiveImported} />
      </View>

      <Heading>Needs a human</Heading>
      <Line
        label="Unsupported automations"
        value={report.automationsUnsupported}
        alarming={(report.automationsUnsupported ?? 0) > 0}
      />
      <Line
        label="Segments with warnings"
        value={report.segmentWarnings}
        alarming={(report.segmentWarnings ?? 0) > 0}
      />
      <Line
        label="Custom fields with nowhere to go"
        value={report.customFieldsUnmapped}
        alarming={(report.customFieldsUnmapped ?? 0) > 0}
      />
      <Line
        label="Contacts with unknown consent"
        value={report.consentUnknown}
        alarming={(report.consentUnknown ?? 0) > 0}
      />
      <Line
        label="Duplicates merged"
        value={report.duplicatesMerged}
        alarming={false}
      />

      {report.resources.length > 0 ? (
        <>
          <Heading>Per-resource completeness</Heading>
          {report.resources.slice(0, RESOURCE_CAP).map((row) => (
            <ResourceLine key={row.resource} row={row} />
          ))}
          {hidden > 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 6,
                fontFamily: FONT.regular,
              }}
            >
              +{num(hidden)} more resource{hidden === 1 ? "" : "s"} — the full
              breakdown is on desktop.
            </Text>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Heading({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("label")}
      style={{
        color: t.fg,
        ...typeStyle("label"),
        marginTop: 22,
        marginBottom: 8,
        fontWeight: "700",
        fontFamily: FONT.bold,
      }}
    >
      {children}
    </Text>
  );
}

function Figure({ label, value }: { label: string; value: number | null }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        value === null ? `${label}: not reported` : `${label}: ${value}`
      }
      style={{
        flexGrow: 1,
        flexBasis: 120,
        backgroundColor: t.bgSubtle,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <Text
        // `figure` is the stat-hero ceiling; 18pt is deliberate for a
        // half-width tile inside a sheet.
        {...typeCap("figure")}
        style={{
          color: t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.bold,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {num(value)}
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
    </View>
  );
}

/**
 * One label/number row. `alarming` only ever adds emphasis to a number the
 * words already name — the label is the state, the colour reinforces it.
 */
function Line({
  label,
  value,
  alarming,
}: {
  label: string;
  value: number | null;
  alarming: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        value === null ? `${label}: not reported` : `${label}: ${value}`
      }
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        paddingVertical: 6,
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
      >
        {label}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: alarming ? t.warning : t.fg,
          ...typeStyle("numeric"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {num(value)}
      </Text>
    </View>
  );
}

function ResourceLine({ row }: { row: MigrationResourceRow }) {
  const { t } = useTheme();
  const pct = row.completeness === null ? null : row.completeness;
  const counts =
    row.imported === null && row.expected === null
      ? EMDASH
      : `${num(row.imported)} of ${num(row.expected)}`;
  return (
    <View
      accessible
      accessibilityLabel={`${row.resource}: ${counts}${
        pct === null ? "" : `, ${percent(pct)} complete`
      }${row.note ? `. ${row.note}` : ""}`}
      style={{ paddingVertical: 6 }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            flex: 1,
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {row.resource}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: pct !== null && pct < 1 ? t.warning : t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {counts}
          {pct === null ? "" : ` · ${percent(pct)}`}
        </Text>
      </View>
      {row.note ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {row.note}
        </Text>
      ) : null}
    </View>
  );
}
