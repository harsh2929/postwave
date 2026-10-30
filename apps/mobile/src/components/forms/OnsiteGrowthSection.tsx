/**
 * OnsiteGrowthSection — is this form's onsite popup armed, what triggers it,
 * and are its experiments and spin rewards doing anything?
 *
 * READ + ENABLE/DISABLE, per the parity register's recorded scope: the ledger
 * argued "an on-site surface is configured where the site is", and rule
 * AUTHORING stays desk-side accordingly. What a phone legitimately answers
 * is the operational half — "the popup is spamming visitors, pause it" — so
 * the one write here is the targeting status toggle: a full-replace PUT of
 * the record the GET returned with only `status` changed (lib/onsiteGrowth
 * carries the guard and its test).
 *
 * RENDERS NOTHING when the workspace never configured onsite growth for this
 * form and the caller cannot change that here (a section of em-dashes about
 * an unused feature is noise). The 404 resting state maps to `null` data.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  useOnsiteExperiments,
  useOnsiteSpinRewards,
  useOnsiteTargeting,
  usePutOnsiteTargeting,
} from "@/hooks/useOnsiteGrowth";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  buildTargetingStatusPut,
  onsiteToggleVerb,
} from "@/lib/onsiteGrowth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TRIGGER_LABELS: Record<string, string> = {
  immediate: "on page load",
  delay: "after a delay",
  scroll: "on scroll",
  exit_intent: "on exit intent",
  custom_event: "on a custom event",
  button_click: "on a button click",
};

export function OnsiteGrowthSection({
  formId,
  canAdmin = false,
}: {
  formId: string | undefined;
  /** Admin floor + online session, computed by the route. */
  canAdmin?: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
  const targeting = useOnsiteTargeting(formId);
  const experiments = useOnsiteExperiments(formId);
  const rewards = useOnsiteSpinRewards(formId);
  const put = usePutOnsiteTargeting();

  const record = targeting.data ?? null;
  // Array.isArray, not `?? []`: these ride the persisted query cache, and a
  // truthy non-array from an older build would sail into `.filter`.
  const experimentRows = Array.isArray(experiments.data)
    ? experiments.data
    : [];
  const rewardRows = Array.isArray(rewards.data) ? rewards.data : [];
  const loading =
    targeting.isLoading || experiments.isLoading || rewards.isLoading;

  // Nothing configured, nothing failed, nothing to act on → no section.
  if (
    !loading &&
    !targeting.isError &&
    record === null &&
    experimentRows.length === 0 &&
    rewardRows.length === 0
  ) {
    return null;
  }
  if (loading) return null;

  const verb = record ? onsiteToggleVerb(record.status) : null;
  const actionable = canAdmin && online && record !== null;

  const onToggle = async () => {
    if (!record || !verb || put.isPending) return;
    const ok = await confirm({
      title: verb.confirmTitle,
      message: verb.confirmMessage,
      confirmLabel: verb.label,
      destructive: verb.destructive,
    });
    if (!ok) return;
    haptics.impact();
    try {
      await put.mutateAsync({
        formId: formId ?? "",
        body: buildTargetingStatusPut(record, verb.target),
      });
      haptics.success();
      toast({ kind: "success", message: verb.successMessage });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : `${verb.label} failed. Please try again.`,
      });
    }
  };

  const activeRewards = rewardRows.filter((r) => r.status === "active").length;
  const runningExperiments = experimentRows.filter(
    (e) => e.status === "running",
  ).length;

  return (
    <Card style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "500",
          fontFamily: FONT.medium,
        }}
      >
        Onsite popup
      </Text>

      <OnsiteReadout
        targetingFailed={targeting.isError}
        record={record}
        experimentsFailed={experiments.isError}
        experimentCount={experimentRows.length}
        runningExperiments={runningExperiments}
        rewardsFailed={rewards.isError}
        rewardCount={rewardRows.length}
        activeRewards={activeRewards}
      />

      {actionable && verb ? (
        <Pressable
          onPress={() => void onToggle()}
          disabled={put.isPending}
          accessibilityRole="button"
          accessibilityLabel={verb.label}
          accessibilityState={{ disabled: put.isPending }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: put.isPending
                ? t.fgSubtle
                : verb.destructive
                  ? t.danger
                  : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {put.isPending ? "Saving…" : verb.label}
          </Text>
        </Pressable>
      ) : null}

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {canAdmin
          ? "Targeting rules, experiment authoring and reward wheels are edited on the web app; this section arms and disarms what they built."
          : "Pausing or publishing the popup needs an admin role; rules are authored on the web app."}
      </Text>
    </Card>
  );
}

/** The three read lines, split out at the section's complexity budget. */
function OnsiteReadout(props: {
  targetingFailed: boolean;
  record: { status: string; triggerType: string; priority: number | null } | null;
  experimentsFailed: boolean;
  experimentCount: number;
  runningExperiments: number;
  rewardsFailed: boolean;
  rewardCount: number;
  activeRewards: number;
}) {
  const { record } = props;
  return (
    <>
      {props.targetingFailed ? (
        <Line muted>
          The targeting read failed — nothing can be said about the popup.
        </Line>
      ) : record ? (
        <Line>
          {`Targeting ${record.status}`}
          {record.triggerType
            ? ` · fires ${TRIGGER_LABELS[record.triggerType] ?? record.triggerType}`
            : ""}
          {record.priority !== null ? ` · priority ${record.priority}` : ""}
        </Line>
      ) : (
        <Line muted>
          No popup targeting configured for this form. Rules are authored on
          the web app.
        </Line>
      )}

      {props.experimentsFailed ? (
        <Line muted>The experiments read failed.</Line>
      ) : props.experimentCount > 0 ? (
        <Line>
          {`${plural(props.experimentCount, "experiment")} · ${props.runningExperiments} running`}
        </Line>
      ) : null}

      {props.rewardsFailed ? (
        <Line muted>The spin-rewards read failed.</Line>
      ) : props.rewardCount > 0 ? (
        <Line>
          {`${plural(props.rewardCount, "spin reward")} · ${props.activeRewards} active`}
        </Line>
      ) : null}
    </>
  );
}

function Line({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: muted ? t.fgMuted : t.fg,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
