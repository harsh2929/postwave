/**
 * ABSettingsSheet — configure how the A/B test decides, and force a decision.
 *
 * The results reader was read-only: the winner metric, the evaluation window
 * and the winner-recipients share were all reachable on desktop and on none of
 * them here, and there was no way to force an evaluation pass. An operator
 * watching a test converge on a phone had to find a desk to act on it.
 *
 * Every option offered is inside the Go validator's bounds
 * (src/lib/abSettings.ts asserts this), so the sheet cannot produce a 400.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setABSettings } from "@/api/abSettings";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  AB_EVALUATION_WINDOWS,
  AB_WINNER_METRICS,
  AB_WINNER_PCTS,
  abSettingsCaption,
  abSettingsError,
  abSettingsPayload,
  type ABSettingsDraft,
  type ABWinnerMetric,
} from "@/lib/abSettings";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

export interface ABSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  campaignId: string;
  initial: ABSettingsDraft;
  /** False for a viewer / offline / cached session. */
  canMutate: boolean;
  blockedReason?: string | null | undefined;
}

export function ABSettingsSheet({
  visible,
  onClose,
  campaignId,
  initial,
  canMutate,
  blockedReason,
}: ABSettingsSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ABSettingsDraft>(initial);

  useEffect(() => {
    if (visible) setDraft(initial);
  }, [visible, initial]);

  const error = abSettingsError(draft);

  const save = useMutation({
    mutationFn: () => setABSettings(campaignId, abSettingsPayload(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ab-view"] });
      void queryClient.invalidateQueries({ queryKey: ["ab-results"] });
      onClose();
      toast({ kind: "success", message: "A/B settings saved." });
    },
    onError: (err: unknown) => {
      haptics.error();
      toast({
        kind: "error",
        message: campaignErrorMessage(err, "Couldn't save the A/B settings."),
      });
    },
  });

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="A/B test settings"
    >
      <ModalHeader title="A/B settings" onClose={onClose} />

      {!canMutate && blockedReason ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            lineHeight: 17,
            marginBottom: 14,
            fontFamily: FONT.regular,
          }}
        >
          {blockedReason}
        </Text>
      ) : null}

      <Field label="Winner metric">
        <SegmentedControl<ABWinnerMetric>
          options={AB_WINNER_METRICS.map((m) => ({
            value: m.value,
            label: m.label,
          }))}
          value={draft.winnerMetric}
          onChange={(winnerMetric) =>
            setDraft((prev) => ({ ...prev, winnerMetric }))
          }
          accessibilityLabel="Winner metric"
        />
      </Field>

      <Field label="Evaluation window">
        <SegmentedControl<string>
          scrollable
          options={AB_EVALUATION_WINDOWS.map((h) => ({
            value: String(h),
            label: `${h}h`,
          }))}
          value={String(draft.evaluationWindowHours)}
          onChange={(value) =>
            setDraft((prev) => ({
              ...prev,
              evaluationWindowHours: Number(value),
            }))
          }
          accessibilityLabel="Evaluation window in hours"
        />
      </Field>

      <Field label="Winner goes to">
        <SegmentedControl<string>
          scrollable
          options={AB_WINNER_PCTS.map((p) => ({
            value: String(p),
            label: `${p}%`,
          }))}
          value={String(draft.winnerRecipientsPct)}
          onChange={(value) =>
            setDraft((prev) => ({
              ...prev,
              winnerRecipientsPct: Number(value),
            }))
          }
          accessibilityLabel="Share of the remaining audience the winner is sent to"
        />
      </Field>

      <Text
        {...typeCap("label")}
        accessibilityLiveRegion="polite"
        style={{
          color: error ? t.danger : t.fgSubtle,
          fontSize: 12,
          lineHeight: 17,
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {error ?? abSettingsCaption(draft)}
      </Text>

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton
          label="Cancel"
          onPress={onClose}
          disabled={save.isPending}
        />
        <ActionButton
          label={save.isPending ? "Saving…" : "Save"}
          primary
          onPress={() => save.mutate()}
          disabled={save.isPending || !canMutate || error != null}
        />
      </View>
    </KeyboardFormSheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontSize: 12,
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}
