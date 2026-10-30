/**
 * SubscriberImportDetailSheet — the whole job, live, plus the two verbs.
 *
 * A sheet rather than a route, matching AuditAlertDetailSheet and
 * ReviewDetailSheet: the rhythm is open → judge → act → next, and it keeps this
 * surface to ONE route file, so it costs one tab-layout registration.
 * THREE THINGS THIS SHEET REFUSES TO INVENT
 *
 *  1. A counter it did not receive. Every number goes through `num`/`compactNum`
 *     whose fallback is an em-dash, and the outcome block is rendered ONLY for a
 *     terminal job (`importOutcomeCounts` returns null otherwise) — quoting
 *     "imported 0" mid-run reads as a failure that has not happened.
 *  2. A Confirm button it knows will 409. `confirmGate` re-applies the server's
 *     own published verdict (`preflight_required` /
 *     `classification_authoritative` / `preflight_expires_at`), so a staged job
 *     whose preflight has gone stale shows the REASON, not a button.
 *  3. A "detail is empty" state. While the detail read is in flight the sheet
 *     renders the list row's own fields, which are a strict subset — never a
 *     blank sheet, and never a zero where the list already knew a number.
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SectionLabel } from "@/components/SectionLabel";
import { EMDASH, dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  importOutcomeCounts,
  importProgressCounts,
  importStatusPresentation,
  isTerminalImport,
  onExistingDescription,
  type SubscriberImportJob,
  type SubscriberImportJobDetail,
} from "@/lib/subscriberImportJobs";
import { canCancelImport, confirmGate } from "@/lib/subscriberImportVerbs";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SubscriberImportDetailSheetProps {
  /** The row that was tapped. Null closes the sheet. */
  job: SubscriberImportJob | null;
  /** The richer `GET /{id}` payload, once it lands. */
  detail: SubscriberImportJobDetail | null;
  detailLoading: boolean;
  detailFailed: boolean;
  onClose: () => void;
  onConfirm: (job: SubscriberImportJobDetail) => void;
  onCancel: (job: SubscriberImportJob) => void;
  /** True while either verb is in flight. */
  busy: boolean;
  /** False for non-admins, API-key sessions and offline sessions. */
  canWrite: boolean;
  /** Why a verb is withheld, when it is. */
  accessNotice: string | null;
  online: boolean;
  now: number;
}

export function SubscriberImportDetailSheet(
  props: SubscriberImportDetailSheetProps,
) {
  const { t } = useTheme();
  const job = props.job;
  return (
    <ReducedMotionModal
      visible={job !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        {job === null ? null : (
          <View style={{ flex: 1 }}>
            <SheetHeader title={job.filename} onClose={props.onClose} />
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
            >
              <JobBody
                job={props.detail ?? job}
                detailFailed={props.detailFailed}
                detailLoading={props.detailLoading}
                now={props.now}
              />
            </ScrollView>
            <SheetFooter {...props} job={job} />
          </View>
        )}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SheetHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: t.borderSubtle,
      }}
    >
      <Text
        numberOfLines={2}
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontFamily: FONT.bold,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close import details"
        style={{
          minWidth: 44,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function JobBody({
  job,
  detailLoading,
  detailFailed,
  now,
}: {
  job: SubscriberImportJob | SubscriberImportJobDetail;
  detailLoading: boolean;
  detailFailed: boolean;
  now: number;
}) {
  const { t } = useTheme();
  const status = importStatusPresentation(job.status, job.cancelRequested);
  const progress = importProgressCounts(job);
  const outcome = importOutcomeCounts(job);
  const strategy = onExistingDescription(job.onExisting);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pill
          label={status.label}
          tone={status.tone}
          accessibilityLabel={`${status.label}. ${status.description}`}
        />
        {detailLoading ? (
          <Muted>Checking the latest…</Muted>
        ) : detailFailed ? (
          // Not an empty state: the list row's own fields are still shown
          // above, and this says the refresh — not the job — failed.
          <Muted>
            Couldn&apos;t refresh. Showing the last values received.
          </Muted>
        ) : null}
      </View>

      <Body>{status.description}</Body>

      <SectionLabel topMargin={12}>Progress</SectionLabel>
      <Fact
        label="Rows processed"
        value={
          progress === null
            ? EMDASH
            : `${num(progress.processed)} of ${num(progress.total)}`
        }
      />
      {outcome === null ? null : (
        <>
          <Fact label="Imported" value={num(outcome.imported)} />
          <Fact label="Skipped" value={num(outcome.skipped)} />
          <Fact
            label="Failed"
            value={num(outcome.failed)}
            tone={
              outcome.failed !== null && outcome.failed > 0
                ? t.danger
                : undefined
            }
          />
        </>
      )}
      <Fact
        label="Last chunk"
        value={
          job.lastChunkAt ? relativeTime(job.lastChunkAt, { now }) : EMDASH
        }
      />

      <SectionLabel topMargin={12}>This import</SectionLabel>
      <Fact
        label="Created"
        value={job.createdAt ? dateTime(job.createdAt) : EMDASH}
      />
      <Fact label="Existing subscribers" value={job.onExisting || EMDASH} />
      {strategy ? <Body>{strategy}</Body> : null}
      {"scheduleType" in job && job.nextScheduledAt ? (
        <Fact label="Scheduled for" value={dateTime(job.nextScheduledAt)} />
      ) : null}
      {"consentContractState" in job && job.consentContractState !== "none" ? (
        <Fact label="Consent evidence" value={job.consentContractState} />
      ) : null}

      {job.status === "failed" && job.errorMessage ? (
        <>
          <SectionLabel topMargin={12}>Why it stopped</SectionLabel>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {job.errorMessage}
          </Text>
        </>
      ) : null}
    </View>
  );
}

function SheetFooter(
  props: SubscriberImportDetailSheetProps & { job: SubscriberImportJob },
) {
  const { t } = useTheme();
  const detail = props.detail;
  const gate = confirmGate(detail, {
    canWrite: props.canWrite,
    online: props.online,
    now: props.now,
  });
  const cancellable = canCancelImport(props.job) && props.canWrite;
  const notice = gate.reason ?? props.accessNotice;
  const nothingOffered = !gate.allowed && !cancellable && !notice;
  const detailMissing =
    nothingOffered && detail === null && !isTerminalImport(props.job.status);
  // A staged job whose `GET /{id}` FAILED is not still being checked. Nothing
  // is in flight and nothing retries on its own, so "checking…" is a progress
  // claim about a read that is already over — and "already finished" would be
  // a claim about the JOB that nobody made. Both are wrong; this is the third
  // state, and it names the read as the thing that failed.
  const detailUnavailable = detailMissing && props.detailFailed;
  const awaitingDetail = detailMissing && !props.detailFailed;
  const idle = nothingOffered && !detailMissing;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        padding: 16,
        gap: 10,
      }}
    >
      {gate.allowed && detail ? (
        <ActionButton
          label="Confirm import"
          tone="accent"
          busy={props.busy}
          onPress={() => props.onConfirm(detail)}
        />
      ) : null}
      {cancellable ? (
        <ActionButton
          label="Stop import"
          tone="danger"
          busy={props.busy}
          onPress={() => props.onCancel(props.job)}
        />
      ) : null}
      {notice ? <Muted>{notice}</Muted> : null}
      {idle ? (
        // Only for a job the worker is genuinely DONE with. `detail === null`
        // while the read is in flight, and `confirmGate(null, …)` answers
        // "not allowed, no reason" — saying "already finished" there would
        // announce a staged import as complete for as long as the fetch takes.
        <Muted>
          Nothing to do from here — this import has already finished.
        </Muted>
      ) : awaitingDetail ? (
        <Muted>Checking whether this import can still be confirmed…</Muted>
      ) : detailUnavailable ? (
        <Muted>
          Couldn&apos;t check whether this import can be confirmed. Pull to
          refresh the list and open it again.
        </Muted>
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  tone,
  busy,
  onPress,
}: {
  label: string;
  tone: "accent" | "danger";
  busy: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      style={{
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        backgroundColor: tone === "danger" ? t.danger : t.accent,
        opacity: busy ? 0.55 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accentFg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {busy ? "Working…" : label}
      </Text>
    </Pressable>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string | undefined;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: tone ?? t.fg,
          ...typeStyle("numeric"),
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

function Body({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function Muted({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
