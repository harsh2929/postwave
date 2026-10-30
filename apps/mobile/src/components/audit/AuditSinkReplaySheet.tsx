/**
 * AuditSinkReplaySheet — backfill a sink after an outage window, and stop a
 * runaway backfill.
 *
 * THE RANGE IS AUDIT IDS. `POST /{id}/replay` takes `{from_id, to_id}` — the
 * ids every audit row and DLQ entry already shows — capped at 100,000 rows per
 * job (lib/auditSinkReplay mirrors the exact refusals). Desktop's replay tab
 * takes the same two numbers; there is no server-side time→id translation to
 * pretend at.
 *
 * CANCEL IS OFFERED EXACTLY WHERE IT BITES: `pending` and `in_progress` jobs
 * (the server's own WHERE clause). It is the stopping half and it ships with
 * the start half because a start button with no stop is how a runaway replay
 * hammers a struggling destination from a phone nobody can act on.
 *
 * The job list re-fetches on open (`staleTime: 0` in useSinkReplayJobs) and by
 * pull — no poll: a backfill is watched deliberately, not ambiently.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import { SettingsTextInput } from "@/components/settings/FormControls";
import type { MobileAuditSink } from "@/api/ops";
import { useSinkReplayJobs } from "@/hooks/useAuditSinkOps";
import {
  useCancelSinkReplay,
  useStartSinkReplay,
} from "@/hooks/useGovernanceOps";
import {
  isReplayJobCancellable,
  replayJobLine,
  validateReplayRange,
  type SinkReplayJob,
} from "@/lib/auditSinkReplay";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

export interface AuditSinkReplaySheetProps {
  sink: MobileAuditSink | null;
  onClose: () => void;
}

export function AuditSinkReplaySheet({ sink, onClose }: AuditSinkReplaySheetProps) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [fromRaw, setFromRaw] = useState("");
  const [toRaw, setToRaw] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const jobs = useSinkReplayJobs(sink?.id ?? null);
  const start = useStartSinkReplay();
  const cancel = useCancelSinkReplay();

  const onStart = async () => {
    if (!sink || start.isPending) return;
    const { range, errors: found } = validateReplayRange(fromRaw, toRaw);
    if (!range) {
      setErrors(found);
      return;
    }
    setErrors([]);
    const ok = await confirm({
      title: `Replay rows ${num(range.fromId)}–${num(range.toId)}?`,
      message: `Every audit event in the range is re-sent to ${
        sink.name || "this sink"
      }. Duplicate delivery is possible for rows the sink already received.`,
      confirmLabel: "Start replay",
      consequence: "The job runs on the server and can be cancelled from here.",
    });
    if (!ok) return;
    try {
      await start.mutateAsync({ id: sink.id, range });
      haptics.success();
      toast({ kind: "success", message: "Replay queued." });
      setFromRaw("");
      setToRaw("");
    } catch (err) {
      haptics.error();
      toast({ kind: "error", message: startErrorMessage(err) });
    }
  };

  const onCancel = async (job: SinkReplayJob) => {
    if (!sink || cancel.isPending) return;
    const ok = await confirm({
      title: "Cancel this replay?",
      message:
        "Rows already re-sent stay sent. A cancelled job cannot be resumed — starting over means entering the range again.",
      confirmLabel: "Cancel replay",
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync({ id: sink.id, jobId: job.id });
      haptics.success();
      toast({ kind: "success", message: "Replay cancelled." });
    } catch {
      haptics.error();
      // The one interesting refusal is a 409: the job finished first.
      toast({
        kind: "error",
        message:
          "Couldn't cancel — the job may have already finished. Pull the list to refresh.",
      });
    }
  };

  // `?? []` would let a truthy non-array from the wire reach `.map` below.
  const jobRows = jobs.data?.jobs;
  const rows = Array.isArray(jobRows) ? jobRows : [];
  return (
    <KeyboardFormSheet
      visible={sink !== null}
      onClose={onClose}
      accessibilityLabel="Sink replay jobs"
      contentContainerStyle={{ padding: 0, paddingBottom: 32 }}
    >
      <SheetHeader
        title={`Replay · ${sink?.name || "sink"}`}
        onClose={onClose}
      />
      <View style={{ padding: 20, gap: 14 }}>
        <Muted text="Re-send a range of audit events after an outage window. The range is audit event ids — the numbers on audit rows and DLQ batches — and one job covers at most 100,000 rows." />
        <SettingsTextInput
          label="From audit id"
          placeholder="100000"
          value={fromRaw}
          onChangeText={setFromRaw}
          keyboardType="number-pad"
        />
        <SettingsTextInput
          label="To audit id"
          placeholder="120000"
          value={toRaw}
          onChangeText={setToRaw}
          keyboardType="number-pad"
        />
        {errors.map((error) => (
          <Text
            key={error}
            accessibilityRole="alert"
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {error}
          </Text>
        ))}
        <View style={{ flexDirection: "row" }}>
          <AuditAction
            label={start.isPending ? "Starting…" : "Start replay"}
            hint="Queues a server-side job that re-sends the range to this sink"
            emphasis
            disabled={start.isPending}
            onPress={() => void onStart()}
          />
        </View>

        <SectionTitle text="Replay jobs" />
        {jobs.isLoading ? <Muted text="Loading replay jobs…" /> : null}
        {jobs.isError ? (
          <Muted text="Couldn't load the replay jobs. Close and reopen to retry." />
        ) : null}
        {jobs.data && rows.length === 0 ? (
          <Muted text="No replays have been run against this sink." />
        ) : null}
        {rows.map((job) => (
          <View key={job.id} style={{ gap: 4 }}>
            <Text
              accessible
              accessibilityLabel={replayJobLine(job)}
              {...typeCap("bodySmall")}
              style={{
                color: job.status === "failed" ? t.danger : t.fg,
                fontFamily: FONT.regular,
                ...typeStyle("bodySmall"),
              }}
            >
              {replayJobLine(job)}
            </Text>
            {isReplayJobCancellable(job) ? (
              <View style={{ flexDirection: "row" }}>
                <AuditAction
                  label={cancel.isPending ? "Cancelling…" : "Cancel"}
                  hint="Stops this replay job. Rows already sent stay sent."
                  disabled={cancel.isPending}
                  onPress={() => void onCancel(job)}
                />
              </View>
            ) : null}
          </View>
        ))}
        {jobs.data?.truncated ? (
          <Muted text="Older jobs exist beyond this page — the full history is on desktop." />
        ) : null}
      </View>
    </KeyboardFormSheet>
  );
}

function startErrorMessage(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status) || 0
      : 0;
  if (status === 400) {
    return err instanceof Error && err.message
      ? err.message
      : "The server refused the range.";
  }
  if (status === 403) {
    return "Your role is not permitted to start a replay. Ask an admin for audit:execute_actions.";
  }
  if (status === 404) return "That sink no longer exists.";
  return "The replay didn't start. Check your connection and try again.";
}

function SectionTitle({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("callout")}
      accessibilityRole="header"
      style={{
        color: t.fg,
        fontWeight: "700",
        fontFamily: FONT.bold,
        ...typeStyle("callout"),
        marginTop: 6,
      }}
    >
      {text}
    </Text>
  );
}

function Muted({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
