/**
 * SavedReportsSection — run a report somebody already authored, and get its
 * output somewhere it can be sent on.
 *
 * DASHBOARD#33. The reporting subsystem shipped a full definition→run→export
 * lifecycle and mobile called none of it, which made every saved report
 * desktop-tethered: the one thing you want on a phone — "run the weekly
 * revenue report and paste it into the thread" — was the one thing you could
 * not do. Authoring is still absent, deliberately: a metric picker, a
 * dimension picker and a filter grammar are desk work, and this file never
 * calls `POST /api/v1/reporting/definitions`.
 *
 * TWO GATES, NOT ONE. Reading definitions and runs is `ScopeReadReports`
 * (reporting.go:126,130), a read-only scope that clears any session role.
 * RUNNING is `ScopeAdmin` (:129), which on a session cookie is a hard
 * owner|admin check. So a viewer sees the shortlist and its outcomes — useful
 * on its own — and simply has no Run control, rather than one that 403s.
 *
 * THE 202 IS NOT A QUEUE. `Repo.RunDefinition` executes the preview inline and
 * inserts the row already `completed` with a real `rows_total`
 * (reporting/repo.go:234-270); the handler then answers 202. The toast
 * therefore reports the OUTCOME, and `runToast` is where that reading is made
 * once. A run that came back `failed` is reported as a failure even though the
 * HTTP call succeeded.
 *
 * COPY, NOT DOWNLOAD. A phone has nowhere useful to put a file. The export is
 * fetched as the server's own canonical JSON (`export.json`, whose body is
 * produced by `RunResultToJSON`) and written to the clipboard, so it can be
 * pasted into the thread that asked for it.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { fetchSavedReportExport } from "@/api/savedReports";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useRunSavedReport,
  useSavedReportDefinitions,
  useSavedReportRuns,
} from "@/hooks/useSavedReports";
import { copyToClipboard } from "@/lib/clipboard";
import { relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  definitionSummary,
  latestRunFor,
  runOutcome,
  runToast,
  sortDefinitions,
  type SavedReportDefinition,
  type SavedReportRun,
} from "@/lib/savedReports";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SavedReportsSection() {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const { toast } = useToast();

  // Reads clear any session role; an API-key session is modelled as viewer.
  const canRead = canAccessMinimumRole("viewer", gate.effectiveRole, mode);
  const canRun = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const definitions = useSavedReportDefinitions(canRead);
  const runs = useSavedReportRuns(canRead);
  const run = useRunSavedReport();
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = sortDefinitions(definitions.data ?? [], runs.data ?? []);

  const onRun = useCallback(
    (definition: SavedReportDefinition) => {
      setBusyId(definition.id);
      haptics.tap();
      run.mutate(definition.id, {
        onSuccess: (result) => {
          const outcome = runToast(result);
          if (outcome.kind === "success") haptics.success();
          else haptics.error();
          toast({ kind: outcome.kind, message: outcome.message });
          setBusyId(null);
        },
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "The report could not be run.",
          });
          setBusyId(null);
        },
      });
    },
    [run, toast],
  );

  const onCopy = useCallback(
    async (latest: SavedReportRun) => {
      haptics.tap();
      try {
        const document = await fetchSavedReportExport(latest.id);
        const ok = await copyToClipboard(JSON.stringify(document, null, 2));
        if (ok) {
          haptics.success();
          toast({ kind: "success", message: "Report export copied." });
        } else {
          // `copyToClipboard` resolves false on a locked pasteboard rather
          // than throwing. Saying "Copied" there is a lie the operator only
          // discovers when they paste nothing.
          haptics.error();
          toast({
            kind: "error",
            message: "The clipboard refused the copy. Try again.",
          });
        }
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "The export could not be fetched.",
        });
      }
    },
    [toast],
  );

  if (!canRead) return null;

  return (
    <View>
      <SectionLabel topMargin={24}>Saved reports</SectionLabel>
      <QueryStates
        query={definitions}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Saved reports need a connection. This is not the same as having none."
        skeleton={<SkeletonList rows={3} lines={2} label="Loading saved reports" />}
        empty={{
          title: "No saved reports",
          description:
            "Reports are authored in the web admin's report builder. Once one exists you can run it and share its output from here.",
        }}
      >
        {rows.map((definition) => (
          <SavedReportRow
            key={definition.id}
            definition={definition}
            latest={latestRunFor(runs.data ?? [], definition.id)}
            busy={busyId === definition.id}
            {...(canRun && gate.enabled ? { onRun } : {})}
            {...(gate.enabled ? { onCopy } : {})}
          />
        ))}
      </QueryStates>
    </View>
  );
}

function SavedReportRow({
  definition,
  latest,
  busy,
  onRun,
  onCopy,
}: {
  definition: SavedReportDefinition;
  latest: SavedReportRun | null;
  busy: boolean;
  onRun?: ((definition: SavedReportDefinition) => void) | undefined;
  onCopy?: ((latest: SavedReportRun) => void) | undefined;
}) {
  const { t } = useTheme();
  const failed = Boolean(
    latest && latest.status && latest.status !== "completed",
  );
  const outcome = runOutcome(latest);
  const when =
    latest && (latest.completedAt || latest.createdAt)
      ? relativeTime(latest.completedAt || latest.createdAt)
      : "";
  // The export exists only for a COMPLETED run: `RunResultToJSON` refuses any
  // other status with a 422 (export.go:20-22). Offering Copy on a failed run
  // would be offering a button that is guaranteed to fail.
  const exportable = Boolean(latest && latest.status === "completed" && onCopy);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={2}
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {definition.name}
        </Text>
        {failed ? (
          <Pill
            label="last run failed"
            tone="danger"
            accessibilityLabel="The last run of this report failed"
          />
        ) : null}
      </View>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {definitionSummary(definition)}
      </Text>

      <Text
        accessible
        {...typeCap("bodySmall")}
        style={{
          color: failed ? t.danger : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {when ? `${outcome} ${when}.` : outcome}
      </Text>

      {onRun || exportable ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {onRun ? (
            <RowButton
              label={busy ? "Running…" : "Run now"}
              accessibilityLabel={`Run ${definition.name} now`}
              accessibilityHint="Runs the saved report and reports how many rows it returned"
              disabled={busy}
              onPress={() => onRun(definition)}
            />
          ) : null}
          {exportable && latest && onCopy ? (
            <RowButton
              label="Copy export"
              accessibilityLabel={`Copy the last export of ${definition.name}`}
              accessibilityHint="Copies the server's JSON export of the last completed run"
              disabled={false}
              onPress={() => onCopy(latest)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function RowButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  accessibilityHint: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      // NativeWind v4: a function-style `style` on a Pressable silently drops
      // layout. Static object only.
      style={{
        minHeight: 44,
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surfaceElevated,
        opacity: disabled ? 0.6 : 1,
        paddingHorizontal: 12,
      }}
    >
      <Text
        numberOfLines={1}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
