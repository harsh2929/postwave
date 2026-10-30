/**
 * CampaignGoalCard — set (or correct) the conversion goal a report will
 * attribute against.
 *
 * Mobile could READ goal results (insights GoalBody) but never write the
 * goal; desktop edits goal_event + goal_window_hours through the same
 * PATCH /campaigns/{id} (CampaignDetailEditor.tsx:167-208). The fields are
 * deliberately NOT frozen after dispatch server-side — they change what the
 * report measures, not what is delivered — so this card renders before AND
 * after the send.
 *
 * Desktop's window rule is mirrored by lib/campaignGoal: with an event set
 * the window defaults to 24h; clearing the event sends window 0.
 *
 * ONLINE via the authoring PATCH (useCampaignAuthoringPatch) — the goal
 * changes how a live report reads, and a queued stale copy replayed later
 * would silently re-point attribution nobody is looking at.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import { useCampaignAuthoringPatch } from "@/hooks/useCampaignAuthoring";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  campaignGoalDraft,
  campaignGoalPatch,
  GOAL_WINDOW_OPTIONS,
  goalEventProblem,
} from "@/lib/campaignGoal";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignGoalCard({
  campaign,
}: {
  campaign: { id: string; goal_event?: unknown; goal_window_hours?: unknown };
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const original = campaignGoalDraft(campaign);
  const [event, setEvent] = useState(original.event);
  const [windowHours, setWindowHours] = useState(original.windowHours);
  const patch = useCampaignAuthoringPatch(campaign.id);

  // Re-seed when the server record changes under the card (another device
  // saved) — but never while a save is in flight.
  const serverEvent = original.event;
  const serverWindow = original.windowHours;
  useEffect(() => {
    if (!patch.isPending) {
      setEvent(serverEvent);
      setWindowHours(serverWindow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverEvent, serverWindow]);

  const problem = goalEventProblem(event);
  const wire = campaignGoalPatch(original, { event, windowHours });
  const dirty = wire !== null;

  const onSave = () => {
    if (!wire || problem || patch.isPending) return;
    haptics.tap();
    patch.mutate(wire, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: wire.goal_event
            ? `Goal set: ${wire.goal_event} within ${wire.goal_window_hours}h of the send.`
            : "Conversion goal cleared.",
        }),
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(err, "Couldn't save the goal."),
        }),
    });
  };

  return (
    <Card>
      <Text
        {...typeCap("callout")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          marginBottom: 4,
        }}
      >
        Conversion goal
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        The event this campaign&apos;s report attributes as a conversion. Leave
        blank to measure none.
      </Text>
      <TextInput
        {...typeCap("body")}
        value={event}
        onChangeText={setEvent}
        placeholder="e.g. checkout.complete"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Conversion goal event key"
        // The return key saves exactly when the Save button would, so a
        // one-field edit never needs the keyboard dismissed to commit it.
        {...keyboardChain({
          onSubmit: onSave,
          disabled: patch.isPending || !dirty || problem !== null,
        })}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: problem ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          minHeight: 44,
          fontSize: 15,
          fontFamily: FONT.regular,
        }}
      />
      {problem ? (
        <Text
          {...typeCap("caption")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
            marginTop: 6,
          }}
        >
          {problem}
        </Text>
      ) : null}
      {event.trim() ? (
        <View style={{ marginTop: 10 }}>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginBottom: 6,
            }}
          >
            Attribution window after the send
          </Text>
          <SegmentedControl<string>
            options={GOAL_WINDOW_OPTIONS.map((o) => ({
              value: String(o.hours),
              label: o.label,
            }))}
            value={String(windowHours)}
            onChange={(next) => setWindowHours(Number(next))}
            accessibilityLabel="Attribution window"
          />
        </View>
      ) : null}
      <View
        style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 12 }}
      >
        <ActionButton
          label={patch.isPending ? "Saving…" : "Save goal"}
          primary
          onPress={onSave}
          disabled={patch.isPending || !dirty || problem !== null}
        />
      </View>
    </Card>
  );
}
