/**
 * AiRegressionCard — is the AI still writing like it used to?
 *
 * The regression harness replays approved outputs against the current model
 * and its verdict gates model changes for the whole workspace. A compact
 * pass/fail read is a natural phone glance.
 *
 * The card never compresses the answer into a green tick it has not earned —
 * "never run", "in flight", "harness failed" and "advisory only" are four
 * different things, and lib/aiRegression keeps them apart.
 *
 * TWO DRILL-INS HANG OFF THIS CARD, both additive and both role-honest:
 *   History  — the evidence workspace (runs + per-run results). Every read is
 *              `read:reports`, so a VIEWER gets it.
 *   Manage / — settings (warn threshold + recording policy), trigger a replay,
 *   Reference   and save a golden reference. All three are `admin`, so the
 *              buttons do not exist below that role rather than 403ing.
 *
 * The card still hides itself entirely when the latest read fails: /runs and
 * /runs/latest share `read:reports`, so a card that could only offer a history
 * button that 403s is worse than no card.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { AiRegressionAdminSheet } from "@/components/voice/AiRegressionAdminSheet";
import { AiRegressionGoldenSheet } from "@/components/voice/AiRegressionGoldenSheet";
import { AiRegressionHistorySheet } from "@/components/voice/AiRegressionHistorySheet";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { regressionPresentation, regressionSpoken } from "@/lib/aiRegression";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useLatestRegressionRun } from "@/hooks/useAiRegression";
import {
  useCaptureGoldenExample,
  useRegressionSettings,
  useSaveRegressionSettings,
  useTriggerRegressionRun,
} from "@/hooks/useAiRegressionAdmin";

export function AiRegressionCard({
  offline,
  canAdmin = false,
}: {
  offline: boolean;
  canAdmin?: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useLatestRegressionRun();
  const [sheet, setSheet] = useState<"history" | "admin" | "golden" | null>(
    null,
  );
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [goldenError, setGoldenError] = useState<string | null>(null);

  // Admin-only, and only once the sheet is open: the settings GET is
  // admin-scoped, so fetching it on mount would 403 for every other session.
  const settings = useRegressionSettings(canAdmin && sheet === "admin");
  const saveSettings = useSaveRegressionSettings();
  const trigger = useTriggerRegressionRun();
  const capture = useCaptureGoldenExample();

  // Hidden entirely when the deployment has no harness or the token lacks
  // read:reports — an empty card that only ever says "unavailable" is worse
  // than no card. The gate-closed case is covered by the tab's own notice.
  if (offline) return null;
  if (query.isError) return null;

  const run = query.data ?? null;
  const p = regressionPresentation(run);

  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "500",
            fontFamily: FONT.medium,
            flex: 1,
          }}
        >
          AI fidelity check
        </Text>
        {query.isLoading ? null : <Pill label={p.label} tone={p.tone} />}
      </View>

      {query.isLoading ? (
        <SkeletonCard lines={2} />
      ) : (
        <View
          accessible
          accessibilityLabel={regressionSpoken(p)}
          style={{ gap: 6 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {p.detail}
          </Text>
          {p.score || p.examples ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
            >
              {[p.score, p.examples].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          {run?.completed_at ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              Ran {relativeTime(run.completed_at)}
            </Text>
          ) : null}
        </View>
      )}

      {query.isError ? null : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <CardAction
            label="Refresh"
            a11yLabel="Refresh the AI fidelity check"
            onPress={() => void query.refetch()}
          />
          <CardAction
            label="History"
            a11yLabel="Browse regression run history"
            onPress={() => {
              haptics.tap();
              setSheet("history");
            }}
          />
          {canAdmin ? (
            <>
              <CardAction
                label="Manage"
                onPress={() => {
                  haptics.tap();
                  setTriggerError(null);
                  setSheet("admin");
                }}
              />
              <CardAction
                label="Save reference"
                // Distinct from the sheet's own submit control, which carries
                // "Save reference": two buttons with one spoken name is a
                // screen-reader trap, not a shortcut.
                a11yLabel="Save a golden reference"
                onPress={() => {
                  haptics.tap();
                  setGoldenError(null);
                  setSheet("golden");
                }}
              />
            </>
          ) : null}
        </View>
      )}

      <AiRegressionHistorySheet
        visible={sheet === "history"}
        onClose={() => setSheet(null)}
      />

      <AiRegressionAdminSheet
        visible={sheet === "admin"}
        settings={settings.data ?? null}
        loading={settings.isLoading}
        loadError={settings.isError ? (settings.error as Error).message : null}
        saving={saveSettings.isPending}
        triggering={trigger.isPending}
        triggerError={triggerError}
        onSave={(body) => {
          saveSettings.mutate(body, {
            onSuccess: () =>
              toast({ kind: "success", message: "Settings saved." }),
            onError: (err) =>
              toast({ kind: "error", message: (err as Error).message }),
          });
        }}
        onTrigger={(body) => {
          setTriggerError(null);
          trigger.mutate(body, {
            onSuccess: () => {
              setSheet(null);
              toast({
                kind: "success",
                message: "Run queued. It executes on the server.",
              });
            },
            // The server's refusal sentence stays IN the sheet, next to the
            // control that caused it, instead of flashing past in a toast.
            onError: (err) => setTriggerError((err as Error).message),
          });
        }}
        onClose={() => setSheet(null)}
      />

      <AiRegressionGoldenSheet
        visible={sheet === "golden"}
        saving={capture.isPending}
        serverError={goldenError}
        onSubmit={(body) => {
          setGoldenError(null);
          capture.mutate(body, {
            onSuccess: () => {
              setSheet(null);
              toast({ kind: "success", message: "Reference saved." });
            },
            onError: (err) => setGoldenError((err as Error).message),
          });
        }}
        onClose={() => setSheet(null)}
      />
    </Card>
  );
}

function CardAction({
  label,
  a11yLabel,
  onPress,
}: {
  label: string;
  a11yLabel?: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      hitSlop={8}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.accent,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
