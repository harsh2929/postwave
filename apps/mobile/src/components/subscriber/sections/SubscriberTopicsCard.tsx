/**
 * SubscriberTopicsCard — "what has this person actually agreed to hear about?"
 *
 * The preference centre is the one consent surface a subscriber controls
 * themselves, and mobile could not read it. Worse, the coverage table
 * (lib/desktopOnlyCapabilities.ts) declared topics COVERED on the phone, so
 * the one guarantee that table exists to give was inverted for this row.
 *
 * Per-person state belongs on the person, which is where mobile already puts
 * the consent receipt (PortableReceiptCard) and the deliverability hold
 * (SubscriberSuppressionCard). The topic CATALOG — creating and deleting the
 * topics themselves — is admin-scoped workspace configuration and stays on
 * desktop.
 *
 * Renders nothing on a workspace with no topics, and nothing on a deployment
 * whose gateway does not serve the route. It never renders "no topics" for a
 * FAILED read: a lookup that did not complete is not evidence of consent.
 */
import { Text } from "react-native";

import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { useToast } from "@/components/Toast";
import {
  useSetSubscriberTopic,
  useSubscriberTopics,
  type SubscriberTopic,
} from "@/hooks/useSubscriberTopics";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** A gateway that does not serve the route is not an error worth a card. */
function isAbsentRoute(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 501;
}

/**
 * What a row's state MEANS, spoken. "On" beside a topic name does not say
 * whether the subscriber chose it or simply never touched it, and those are
 * different facts about consent.
 */
export function topicStateHint(topic: SubscriberTopic): string {
  if (topic.description) return topic.description;
  return topic.defaultOptIn
    ? "On by default for everyone who has not chosen."
    : "Off unless the subscriber opts in.";
}

export function SubscriberTopicsCard({
  email,
  canMutate,
  disabledReason,
}: {
  email: string | undefined;
  canMutate: boolean;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const topics = useSubscriberTopics(email);
  const setTopic = useSetSubscriberTopic();

  if (topics.isError) {
    if (isAbsentRoute(topics.error)) return null;
    return (
      <Card style={{ marginTop: 12 }}>
        <Label>Preferences</Label>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Couldn&apos;t read this contact&apos;s topic preferences, so this
          profile can&apos;t say what they have agreed to hear about.
        </Text>
      </Card>
    );
  }

  const rows = Array.isArray(topics.data) ? topics.data : [];
  // A workspace with no topic catalogue has nothing to say here, and an empty
  // card would imply the opposite.
  if (rows.length === 0) return null;

  function onToggle(topic: SubscriberTopic, next: boolean): void {
    if (!canMutate || !email) return;
    haptics.tap();
    setTopic.mutate(
      { email, topicId: topic.id, optedIn: next },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message: next
              ? `Opted in to ${topic.name}.`
              : `Opted out of ${topic.name}.`,
          });
        },
        onError: (error: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              `Couldn't change ${topic.name}. ${error instanceof Error ? error.message : ""}`.trim(),
          });
        },
      },
    );
  }

  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Preferences</Label>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          marginBottom: 4,
          fontFamily: FONT.regular,
        }}
      >
        What this contact has chosen to hear about. They can change these
        themselves from any email&apos;s preference link.
      </Text>
      {rows.map((topic) => (
        <SettingsSwitchRow
          key={topic.id}
          label={topic.name}
          hint={topicStateHint(topic)}
          value={topic.optedIn}
          disabled={!canMutate || setTopic.isPending}
          onValueChange={(next) => onToggle(topic, next)}
        />
      ))}
      {!canMutate && disabledReason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {disabledReason}
        </Text>
      ) : null}
    </Card>
  );
}
