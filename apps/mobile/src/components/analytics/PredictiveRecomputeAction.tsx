/**
 * PredictiveRecomputeAction — the one write on the Analytics screen's model
 * card: `POST /api/v1/predictive/recompute` (admin, predictive.go:128).
 *
 * The card above it reads a ROLLUP TABLE, and that table is only ever written
 * by a recompute (repo.go:457). So an admin who opened Analytics on a phone,
 * read "we can believe 4% of this model", and wanted a fresher answer had
 * exactly one option: find a laptop. Desktop has had the button since
 * PredictiveAnalyticsSection.tsx:10.
 *
 * FOUR RULES THIS COMPONENT KEEPS:
 *
 *  - VIEWERS SEE, ADMINS ACT. Below admin the control is replaced by the
 *    sentence that says why, not hidden — a reader who cannot find the button
 *    assumes the phone cannot do it, and asks for a feature that exists.
 *  - THE RUN IS SYNCHRONOUS AND REWRITES WHAT IS ON SCREEN, so it is
 *    confirmed first and the two predictive queries are invalidated after.
 *  - THE RESULT IS RENDERED IN THE SERVER'S NUMBERS. `runResultSummary` only
 *    ever states counts the RunResult carried; a run that scored nothing says
 *    so, because "recomputed" without a count is how a reader concludes that
 *    coverage improved when it cannot have.
 *  - NO OFFLINE QUEUE. The result is the reason to press it; a replay hours
 *    later would rewrite these numbers with nobody reading them.
 *
 * NativeWind v4: the Pressable's style is a STATIC object (house rule 1) —
 * the function form silently drops layout.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { postPredictiveRecompute } from "@/api/predictiveRecompute";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  RECOMPUTE_CONFIRM,
  RECOMPUTE_ROLE_NOTE,
  recomputeFailureCopy,
  runErrorText,
  runResultSummary,
  runWindowNote,
  type PredictiveRunResult,
} from "@/lib/predictiveRecompute";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function PredictiveRecomputeAction() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const confirm = useConfirm();
  const { toast } = useToast();
  const client = useQueryClient();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PredictiveRunResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const allowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const onRecompute = useCallback(async () => {
    const ok = await confirm({
      title: RECOMPUTE_CONFIRM.title,
      message: RECOMPUTE_CONFIRM.body,
      confirmLabel: RECOMPUTE_CONFIRM.confirmLabel,
    });
    if (!ok) return;
    setRunning(true);
    setFailure(null);
    try {
      const run = await postPredictiveRecompute();
      setResult(run);
      haptics.success();
      toast({ kind: "success", message: runResultSummary(run) });
      // The coverage line and the RFM bands on this card were both rewritten
      // by the run; leaving them cached would show the OLD snapshot beside a
      // sentence saying the model was just recomputed.
      await client.invalidateQueries({ queryKey: ["predictive-data-sufficiency"] });
      await client.invalidateQueries({ queryKey: ["predictive-rfm-segments"] });
    } catch (error) {
      haptics.error();
      const message = recomputeFailureCopy(error);
      setFailure(message);
      toast({ kind: "error", message });
    } finally {
      setRunning(false);
    }
  }, [client, confirm, toast]);

  if (!allowed) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {RECOMPUTE_ROLE_NOTE}
      </Text>
    );
  }

  const disabled = running || !gate.enabled;

  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Recompute the predictive model"
        accessibilityState={{ disabled, busy: running }}
        disabled={disabled}
        onPress={() => void onRecompute()}
        // Static style object: the `({pressed}) => …` form drops layout on
        // NativeWind v4 (scripts/fix-pressable-style.mjs).
        style={{
          minHeight: 44,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          paddingHorizontal: 14,
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {running ? <ActivityIndicator size="small" color={t.fgMuted} /> : null}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("label"),
          }}
        >
          {running ? "Recomputing…" : "Recompute now"}
        </Text>
      </Pressable>

      {!gate.enabled ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          You&apos;re offline. The run happens on the server while you wait, so
          it needs a connection.
        </Text>
      ) : null}

      {result ? <RunReport result={result} /> : null}

      {failure ? (
        <Text
          {...typeCap("caption")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {failure}
        </Text>
      ) : null}
    </View>
  );
}

/** The finished run, in the server's own words and counts. */
function RunReport({ result }: { result: PredictiveRunResult }) {
  const { t } = useTheme();
  const window = runWindowNote(result);
  const error = runErrorText(result);
  return (
    <View style={{ gap: 2 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fg,
          fontFamily: FONT.medium,
          ...typeStyle("caption"),
        }}
      >
        {runResultSummary(result)}
      </Text>
      {window ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {window}
        </Text>
      ) : null}
      {error ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.warning,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
