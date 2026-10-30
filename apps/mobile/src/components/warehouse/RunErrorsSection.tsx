/**
 * RunErrorsSection — WHY a run's rows failed, grouped so a phone can hold it.
 *
 * This section is the reason the whole surface is a screen rather than a
 * dashboard tile. "Last night's import failed" is a notification;
 * "23 rows failed with subscriber_not_found in orders.jsonl" is something an
 * operator can act on before they reach a desk.
 *
 * IT NEVER SHOWS A BARE EMPTY LIST. Three different things produce zero rows
 * here and they are not the same fact:
 *   - the run failed, so its per-row ledger was rolled back with the failing
 *     transaction (`failRun`, repo.go:1052-1055) — the run's own error message
 *     is the record, and it is already shown above;
 *   - the run completed cleanly, so there is genuinely nothing to explain;
 *   - the run completed with failures but never wrote reasons (only the import
 *     path calls `insertRowError`).
 * `runEvidence` decides which sentence applies; this component renders the
 * LIST only when there is a list, and otherwise defers to that sentence
 * instead of drawing an empty state that would imply "nothing went wrong".
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import type { QueryLike } from "@/components/QueryStates";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  emptyRowErrorsMessage,
  groupWarehouseRowErrors,
  type RunEvidence,
  type WarehouseRowError,
} from "@/lib/warehouseRunErrors";

export interface RunErrorsSectionProps {
  query: QueryLike & { data?: WarehouseRowError[] | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
  evidence: RunEvidence;
}

export function RunErrorsSection({
  query,
  gate,
  evidence,
}: RunErrorsSectionProps) {
  const { t } = useTheme();
  const rows = Array.isArray(query.data) ? query.data : [];
  const groups = groupWarehouseRowErrors(rows);

  return (
    <View style={{ marginTop: 8 }}>
      <SectionLabel
        subtitle={
          groups.length > 0
            ? `${plural(rows.length, "recorded reason")} in ${plural(groups.length, "group")}`
            : undefined
        }
      >
        Why rows failed
      </SectionLabel>
      <QueryStates
        query={query}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Reconnect to read this run's row errors. This is not the same as the run having none."
        skeleton={<SkeletonList rows={2} lines={2} label="Loading run errors" />}
        empty={{
          // Never "no errors" — that would read as "nothing went wrong".
          // `emptyRowErrorsMessage` names which of the empty cases this is,
          // without repeating the sentence the detail card already carries.
          title: "No per-row reasons for this run",
          description: emptyRowErrorsMessage(evidence),
        }}
      >
        {groups.map((group) => (
          <View
            key={group.code}
            accessible
            accessibilityLabel={`${plural(group.count, "row")} failed with ${group.code}. ${group.sampleMessage}${
              group.sourceObjects.length > 0
                ? ` In ${group.sourceObjects.join(", ")}.`
                : ""
            }${
              group.firstRowNumber === null
                ? ""
                : ` First at row ${num(group.firstRowNumber)}.`
            }`}
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 12,
              padding: 12,
              marginBottom: 8,
              gap: 6,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  flex: 1,
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                {group.code}
              </Text>
              <Pill
                label={String(group.count)}
                tone="danger"
                accessibilityLabel={plural(group.count, "row")}
              />
            </View>
            {group.sampleMessage ? (
              <Text
                selectable
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {group.sampleMessage}
              </Text>
            ) : null}
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {[
                group.sourceObjects.length > 0
                  ? group.sourceObjects.join(", ")
                  : "no source object recorded",
                group.firstRowNumber === null
                  ? "no row number recorded"
                  : `first at row ${num(group.firstRowNumber)}`,
              ].join(" · ")}
            </Text>
          </View>
        ))}
      </QueryStates>
    </View>
  );
}
