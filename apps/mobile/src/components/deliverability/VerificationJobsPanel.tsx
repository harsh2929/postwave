/**
 * VerificationJobsPanel — see a bulk verification burning credits, and stop it.
 *
 * VERB#5. Mobile's only verification calls were the health probes; the JOBS half
 * had no client, so a bulk run spending third-party credits could be neither
 * watched nor cancelled from a phone. Same shape as the SMS gap — a per-unit vendor
 * cost with no brake — except this one is easier to start by accident, because a
 * large list looks like a small one until the invoice arrives.
 *
 * The row counts what is left to SPEND rather than what is done, because that is
 * the number the Cancel decision turns on. Cancel disappears once the work is
 * finished: the money is already gone and the button would imply a refund.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { VerificationJobDetailSheet } from "@/components/deliverability/VerificationJobDetailSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useCancelVerificationJob,
  useVerificationJobs,
} from "@/hooks/useVerificationJobs";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  verificationJobIsCancellable,
  verificationJobIsRunning,
  verificationJobSummary,
} from "@/lib/verificationJobs";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function VerificationJobsPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const query = useVerificationJobs();
  const cancel = useCancelVerificationJob();
  const [openJobId, setOpenJobId] = useState("");

  // Array.isArray, not `?? []` -- a truthy non-array reaches .filter.
  const rows = (Array.isArray(query.data) ? query.data : []).filter((job) =>
    verificationJobIsRunning(job.status),
  );
  const unavailable = query.isError;
  if (rows.length === 0 && !unavailable) {
    // The panel is a live-spend brake, so it still disappears once nothing is
    // running — but an OPEN drill-in survives the job it was opened on
    // finishing. Unmounting the sheet mid-read would close the only place the
    // finished run's failed addresses can be seen.
    return openJobId ? (
      <VerificationJobDetailSheet
        jobId={openJobId}
        onClose={() => setOpenJobId("")}
      />
    ) : null;
  }
  const mayCancel = canAccessMinimumRole("editor", gate.effectiveRole);

  const onCancel = async (id: string, remaining: string) => {
    haptics.tap();
    const ok = await confirm({
      title: "Stop this verification?",
      message: `${remaining} Provider credits already used are not refunded; stopping prevents the remaining work.`,
      confirmLabel: "Stop verification",
      destructive: true,
    });
    if (!ok) return;
    cancel.mutate(id, {
      onSuccess: () =>
        toast({ kind: "success", message: "Verification stopped." }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't stop the verification.",
        }),
    });
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {rows.length > 0
          ? "Verification in progress"
          : "Verification status unavailable"}
      </Text>
      {unavailable ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {rows.length > 0
            ? "The latest verification status is unavailable. Last known active jobs remain below; refresh before retrying paid work."
            : "Verification job status is unavailable, so active provider spend is unknown. Refresh before starting or retrying paid work."}
        </Text>
      ) : null}
      {rows.map((job) => {
        const summary = verificationJobSummary(job);
        return (
          <View
            key={job.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 10,
              gap: 4,
            }}
          >
            {/* The row is the way in: totals and a status pill cannot say
                WHICH addresses came back bad, and the per-address page is a
                viewer read that costs nothing to open. */}
            <Pressable
              onPress={() => {
                haptics.tap();
                setOpenJobId(job.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open verification job detail: ${job.total} addresses, ${summary}`}
              style={{ gap: 4 }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: t.fg,
                    ...typeStyle("body"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {job.total} addresses
                </Text>
                <Pill label={job.status || "running"} tone="warning" />
              </View>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {summary}
              </Text>
            </Pressable>
            {mayCancel && verificationJobIsCancellable(job) ? (
              <Pressable
                onPress={() => void onCancel(job.id, summary)}
                disabled={cancel.isPending}
                accessibilityRole="button"
                accessibilityLabel="Stop this verification job"
                accessibilityState={{ disabled: cancel.isPending }}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: cancel.isPending ? t.fgSubtle : t.danger,
                    ...typeStyle("control"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {cancel.isPending ? "Stopping…" : "Stop verification"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      <VerificationJobDetailSheet
        jobId={openJobId}
        onClose={() => setOpenJobId("")}
      />
    </View>
  );
}
