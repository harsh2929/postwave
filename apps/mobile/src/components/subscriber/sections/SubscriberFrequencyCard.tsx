/**
 * SubscriberFrequencyCard — "email me less often", for one person.
 *
 * Desktop's FrequencyPreferencePanel as a phone card: the cadence choices as
 * chips, the vacation presets when pausing, and one sentence that always
 * states what send-time will actually do (a future pause expiry silences
 * every cadence, so the sentence — not the selected chip — is the truth).
 *
 * Role + connection honesty: the chips exist only for `canMutate`
 * (editor+, online, live session — the frequency keys are in
 * offlineQueueSafety's online-only list); a viewer sees the summary sentence
 * and no dead controls.
 */
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useToast } from "@/components/Toast";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { useSubscriberFrequencyWrite } from "@/hooks/useSubscriberFrequency";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  FREQUENCY_OPTIONS,
  PAUSE_PRESET_DAYS,
  buildClearPauseBody,
  buildFrequencyPreferenceBody,
  buildPauseDaysBody,
  frequencyPauseActive,
  frequencyStateFromSubscriber,
  frequencySummary,
} from "@/lib/subscriberFrequency";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberFrequencyCard({
  subscriberId,
  subscriber,
  canMutate,
}: {
  subscriberId: string;
  /** The loaded detail row — the two SUB-132 fields are read off it. */
  subscriber: unknown;
  canMutate: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const write = useSubscriberFrequencyWrite();
  const state = frequencyStateFromSubscriber(subscriber);
  const paused = frequencyPauseActive(state);

  const submit = (body: Record<string, unknown>, receipt: string) => {
    if (write.isPending) return;
    haptics.tap();
    write.mutate(
      { id: subscriberId, body },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: receipt });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              `Couldn't update the send preference. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Send frequency</Label>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: paused ? t.warning : t.fgMuted,
          ...typeStyle("bodySmall"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {frequencySummary(state)}
      </Text>

      {canMutate ? (
        <>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 10,
            }}
            accessibilityRole="radiogroup"
            accessibilityLabel="Send frequency preference"
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                active={state.preference === opt.value}
                onPress={() => {
                  if (state.preference === opt.value) return;
                  submit(
                    buildFrequencyPreferenceBody(opt.value),
                    opt.value === "paused"
                      ? "Sends paused."
                      : `Cadence set to ${opt.label.toLowerCase()}.`,
                  );
                }}
                accessibilityLabel={`${opt.label}: ${opt.hint}`}
              />
            ))}
          </View>

          {/* Vacation presets: the server computes the expiry and pins the
              preference to paused (pause_days, SUB-135). */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 8,
            }}
          >
            {PAUSE_PRESET_DAYS.map((days) => (
              <Chip
                key={days}
                label={`Pause ${days}d`}
                active={false}
                onPress={() => {
                  const body = buildPauseDaysBody(days);
                  if (!body) return;
                  submit(body, `Paused for ${days} days.`);
                }}
                accessibilityLabel={`Pause all sends for ${days} days`}
              />
            ))}
            {state.pausedUntil ? (
              <Chip
                label="Clear pause expiry"
                active={false}
                onPress={() =>
                  submit(buildClearPauseBody(), "Pause expiry cleared.")
                }
                accessibilityLabel="Clear the pause expiry date"
              />
            ) : null}
          </View>
        </>
      ) : null}
    </Card>
  );
}
