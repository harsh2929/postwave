/**
 * MigrationEvidenceSection — "which fields actually moved, and what did they
 * become?"
 *
 * WHAT THE SHEET ABOVE COULD NOT ANSWER. The report block states a verdict and
 * counts: 13 custom fields mapped, 2 unmapped, 94% complete. None of that
 * settles the only question a client ever asks — "did MY field survive?" This
 * section is the per-resource and per-field evidence behind those numbers, and
 * it is the phone's version of desktop's VerificationDiff +
 * MigrationVerificationEvidence pair.
 *
 * VERBATIM IS THE WHOLE POINT. Every value below is printed exactly as the
 * server sent it: the source field name with whatever spacing and casing it
 * had, the canonical name it landed on, the server's own status word for each
 * resource, and its own note strings. Nothing is title-cased, re-spelled, or
 * folded into a client vocabulary — a diff that tidies its inputs is not
 * evidence of anything. The only derived number is the shortfall, and it is
 * shown NEXT TO the two numbers it came from, never instead of them.
 *
 * WHY IT IS COLLAPSED AND PRESS-DRIVEN. Expanding it is what issues the read
 * (`useMigrationVerificationEvidence` is disabled until then), so a sheet
 * opened to check a verdict costs one request and not two. Nothing here writes:
 * `GET /api/v1/migrations/{job_id}/verification` is the single route, and the
 * migrations destination is already admin-gated, so there is no second role
 * check to make here.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style` prop silently drops layout.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SkeletonList } from "@/components/Skeleton";
import { useMigrationVerificationEvidence } from "@/hooks/useMigrationEvidence";
import { FONT } from "@/lib/fonts";
import {
  evidenceIsEmpty,
  evidenceScopeCopy,
  fieldMappingLine,
  resourceCountsLine,
  type MigrationEvidence,
  type ResourceEvidence,
} from "@/lib/migrationEvidence";
import { CARD_RADIUS } from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MigrationEvidenceSection({
  jobId,
  status,
  online,
}: {
  jobId: string | null;
  status: string | undefined;
  online: boolean;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const evidence = useMigrationVerificationEvidence(jobId, open && online);
  const data = evidence.data ?? null;
  const scope = evidenceScopeCopy(status);

  if (!jobId) return null;

  return (
    <View style={{ marginTop: 22 }}>
      <Pressable
        onPress={() => setOpen((was) => !was)}
        accessibilityRole="button"
        accessibilityLabel={
          open
            ? "Hide the field-level evidence"
            : "Show the field-level evidence for this migration"
        }
        accessibilityHint="Reads the per-resource and per-field before-and-after values from the server."
        accessibilityState={{ expanded: open }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {open ? "Hide field-level evidence" : "Field-level evidence"}
        </Text>
      </Pressable>

      {!open ? null : !online ? (
        <Body text="The evidence is read from the server each time. Reconnect to open it." />
      ) : evidence.isLoading ? (
        <SkeletonList rows={3} lines={2} label="Loading the field-level evidence" />
      ) : evidence.isError ? (
        <Body
          alarming
          text={
            evidence.error instanceof Error && evidence.error.message
              ? evidence.error.message
              : "Couldn't read the verification evidence."
          }
        />
      ) : evidenceIsEmpty(data) ? (
        <Body
          text={
            data === null
              ? "This job has no verification report yet, so there is nothing to diff."
              : "The report carries no per-resource or per-field detail. That is not a claim that nothing moved — only that this report did not record it."
          }
        />
      ) : (
        <>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 2,
              marginBottom: 8,
              fontFamily: FONT.regular,
            }}
          >
            {scope.badge} · {scope.sentence}
          </Text>
          <EvidenceBody evidence={data as MigrationEvidence} />
        </>
      )}
    </View>
  );
}

function EvidenceBody({ evidence }: { evidence: MigrationEvidence }) {
  return (
    <>
      {evidence.resources.length > 0 ? (
        <Group title="Per resource">
          {evidence.resources.map((row) => (
            <ResourceRow key={`${row.resource}-${row.label}`} row={row} />
          ))}
        </Group>
      ) : null}

      {evidence.fieldsMapped.length > 0 ? (
        <Group title={`Field mapping (${evidence.fieldsMapped.length})`}>
          {evidence.fieldsMapped.map((row) => (
            <Line key={`${row.source}-${row.canonical ?? ""}`} text={fieldMappingLine(row)} />
          ))}
        </Group>
      ) : null}

      {evidence.fieldsUnmapped.length > 0 ? (
        <Group title={`Fields with nowhere to go (${evidence.fieldsUnmapped.length})`}>
          {evidence.fieldsUnmapped.map((name) => (
            <Line key={name} alarming text={name} />
          ))}
        </Group>
      ) : null}

      {evidence.segmentWarnings.length > 0 ? (
        <Group title={`Segment warnings (${evidence.segmentWarnings.length})`}>
          {evidence.segmentWarnings.map((row) => (
            <Line
              key={row.name}
              alarming
              text={row.detail === null ? row.name : `${row.name} — ${row.detail}`}
            />
          ))}
        </Group>
      ) : null}

      {evidence.automationsUnsupported.length > 0 ? (
        <Group
          title={`Automations not ported (${evidence.automationsUnsupported.length})`}
        >
          {evidence.automationsUnsupported.map((row) => (
            <Line
              key={row.name}
              alarming
              text={row.detail === null ? row.name : `${row.name} — ${row.detail}`}
            />
          ))}
        </Group>
      ) : null}

      {evidence.resourceWarnings.length > 0 ? (
        <Group title={`Row-level warnings (${evidence.resourceWarnings.length})`}>
          {evidence.resourceWarnings.map((row, index) => (
            <Line
              key={`${row.resource ?? ""}-${row.sourceId ?? row.name ?? index}`}
              alarming
              text={[row.resource, row.name, row.warning]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}

/**
 * One resource: OUR label for the group, the SERVER's status word, the
 * server's two counts, and the server's own notes underneath.
 */
function ResourceRow({ row }: { row: ResourceEvidence }) {
  const { t } = useTheme();
  const counts = resourceCountsLine(row);
  return (
    <View
      accessible
      accessibilityLabel={`${row.label}: ${counts}${
        row.status === null ? "" : `, status ${row.status}`
      }`}
      style={{ paddingVertical: 6 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
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
          {row.label}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {counts}
        </Text>
      </View>
      {row.status !== null ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {row.status}
        </Text>
      ) : null}
      {row.notes.map((note) => (
        <Text
          key={note}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {note}
        </Text>
      ))}
    </View>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 12 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          marginBottom: 2,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function Line({ text: body, alarming }: { text: string; alarming?: boolean }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: alarming ? t.warning : t.fg,
        ...typeStyle("caption"),
        marginTop: 3,
        fontFamily: FONT.regular,
      }}
    >
      {body}
    </Text>
  );
}

function Body({ text: body, alarming }: { text: string; alarming?: boolean }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        marginTop: 8,
        borderRadius: CARD_RADIUS,
        borderWidth: 1,
        borderColor: alarming ? t.danger : t.borderSubtle,
        backgroundColor: t.bgSubtle,
        padding: 12,
      }}
    >
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("bodySmall")}
        style={{
          color: alarming ? t.danger : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
