/**
 * MigrationDetailSheet — the verification report, on a phone.
 *
 * WHY A SHEET AND NOT A ROUTE. Desktop's `MigrationDetailSurface` is a page
 * because it also owns rollback, checkpoint resume and cutover evidence — all
 * of which need the report READ FIRST and belong at a desk. What a phone is
 * for is the question the list could not answer: a six-hour import says
 * "completed" and the operator has to decide whether to tell the client it
 * worked. This sheet is that decision's evidence and nothing else, so it is a
 * disclosure over the list rather than a second navigable surface.
 *
 * NO REPORT IS A STATE, NOT A FAILURE. `useMigrationVerification` resolves a
 * 404 to `null` because that is the server's normal answer for a job that has
 * not produced a report yet; `verificationAbsenceCopy` turns it into the
 * sentence that fits the job's status. Rendering it red would say something is
 * broken while an import runs perfectly.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill, type PillTone } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { CutoverWatchSection } from "@/components/migrations/CutoverWatchSection";
import { MigrationEvidenceSection } from "@/components/migrations/MigrationEvidenceSection";
import { MigrationVerificationFigures } from "@/components/migrations/MigrationVerificationFigures";
import type { MobileMigrationJob } from "@/api/ops";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  useMigrationRollback,
  useMigrationVerification,
} from "@/hooks/useMigrations";
import { dateTime, num, percent, truncateMiddle } from "@/lib/format";
import { CARD_RADIUS } from "@/lib/shellStyleTokens";
import { FONT } from "@/lib/fonts";
import {
  verificationAbsenceCopy,
  verificationRisk,
  verificationRiskCopy,
} from "@/lib/migrationVerification";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const RISK_TONE: Record<string, PillTone> = {
  clean: "success",
  review: "warning",
  loss: "danger",
};

export interface MigrationDetailSheetProps {
  job: MobileMigrationJob | null;
  onClose: () => void;
}

export function MigrationDetailSheet({
  job,
  onClose,
}: MigrationDetailSheetProps) {
  const { t } = useTheme();
  const jobId = job?.id ?? null;
  const online = useIsOnline();
  const verification = useMigrationVerification(jobId);
  const rollback = useMigrationRollback(jobId, job?.status);
  const report = verification.data ?? null;
  const risk = report ? verificationRisk(report) : null;
  const riskCopy = risk ? verificationRiskCopy(risk) : null;

  return (
    <KeyboardFormSheet
      visible={job !== null}
      onClose={onClose}
      accessibilityLabel={
        job ? `Verification report for the ${job.source} import` : "Report"
      }
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {job?.source ?? "Migration"} report
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
        // The whole id is never spoken: a UUID read aloud is thirty-six
        // characters of noise between the reader and the next control.
        accessibilityLabel={`Job started ${job?.started_at ? dateTime(job.started_at) : "at an unknown time"}`}
      >
        {truncateMiddle(String(job?.id ?? ""), 18)}
        {job?.started_at ? ` · started ${dateTime(job.started_at)}` : ""}
      </Text>

      {job?.error ? (
        <View
          accessible
          accessibilityLabel={`The job reported an error: ${job.error}`}
          style={{
            marginTop: 16,
            borderRadius: CARD_RADIUS,
            borderWidth: 1,
            borderColor: t.danger,
            backgroundColor: t.surface,
            padding: 12,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {job.error}
          </Text>
        </View>
      ) : null}

      {rollback.data ? (
        <RollbackBlock status={rollback.data} />
      ) : null}

      {verification.isLoading ? (
        <View style={{ marginTop: 20 }}>
          <SkeletonList rows={3} lines={2} label="Loading the verification report" />
        </View>
      ) : verification.isError ? (
        <View style={{ marginTop: 20 }}>
          <ErrorState
            error={verification.error}
            onRetry={() => void verification.refetch()}
          />
        </View>
      ) : report && riskCopy && risk ? (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginTop: 20,
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
                flex: 1,
              }}
            >
              {riskCopy.headline}
            </Text>
            {/* The pill repeats the verdict as a labelled word, never as a
                bare colour. */}
            <Pill label={risk} tone={RISK_TONE[risk] ?? "neutral"} />
          </View>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            {riskCopy.detail}
          </Text>
          {report.dataLossEstimatePct !== null ? (
            <Text
              accessibilityLabel={`Estimated data loss ${percent(report.dataLossEstimatePct / 100)}`}
              {...typeCap("bodySmall")}
              style={{
                color: report.dataLossEstimatePct > 0 ? t.danger : t.fgSubtle,
                ...typeStyle("bodySmall"),
                marginTop: 8,
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
            >
              Estimated data loss {percent(report.dataLossEstimatePct / 100)}
            </Text>
          ) : null}

          <MigrationVerificationFigures report={report} />

          {report.discoveryWarnings.length > 0 ? (
            <>
              <Text
                accessibilityRole="header"
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  marginTop: 22,
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                }}
              >
                Discovery warnings ({num(report.discoveryWarnings.length)})
              </Text>
              {report.discoveryWarnings.slice(0, 8).map((line) => (
                <Text
                  key={line}
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    marginTop: 6,
                    fontFamily: FONT.regular,
                  }}
                >
                  {line}
                </Text>
              ))}
            </>
          ) : null}

          {/* The counts above say HOW MUCH came across; this says WHICH — the
              per-resource rows and the source→canonical field mapping behind
              those numbers. Inside this branch on purpose: with no report
              there is nothing to diff, and a control that can only answer
              "nothing" is worse than no control. Press-driven, so opening a
              report to read its verdict still costs one request. */}
          <MigrationEvidenceSection
            jobId={jobId}
            status={job?.status}
            online={online}
          />

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 22,
              fontFamily: FONT.regular,
            }}
          >
            Rollback and checkpoint resume stay on desktop — each one needs
            this report read in full first.
          </Text>
        </>
      ) : (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 20,
            fontFamily: FONT.regular,
          }}
        >
          {verificationAbsenceCopy(job?.status)}
        </Text>
      )}

      {/* GOVERNANCE#53. Outside the verification ternary on purpose: the watch
          answers a DIFFERENT question ("is the source still moving?") and a
          failed report fetch must not hide it. Self-gates on a completed job. */}
      <CutoverWatchSection jobId={jobId} status={job?.status} online={online} />
    </KeyboardFormSheet>
  );
}

function RollbackBlock({
  status,
}: {
  status: NonNullable<ReturnType<typeof useMigrationRollback>["data"]>;
}) {
  const { t } = useTheme();
  const state = status.state ?? "in progress";
  const counted =
    status.deleted !== null
      ? status.total !== null && status.total > 0
        ? `${num(status.deleted)} / ${num(status.total)} removed`
        : `${num(status.deleted)} removed`
      : null;
  return (
    <View
      accessible
      accessibilityLabel={`Rollback ${state}${counted ? `, ${counted}` : ""}`}
      style={{
        marginTop: 16,
        borderRadius: CARD_RADIUS,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.bgSubtle,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Rollback {state}
      </Text>
      {counted ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            marginTop: 3,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {counted}
          {status.finishedAt ? ` · finished ${dateTime(status.finishedAt)}` : ""}
        </Text>
      ) : null}
      {status.error ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {status.error}
        </Text>
      ) : null}
    </View>
  );
}
