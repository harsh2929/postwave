/**
 * PushTopicsSection — which events this device is allowed to buzz for.
 *
 * The endpoint has always accepted a per-event allowlist; mobile sent a
 * module-level constant no UI could change, so "I want approval pings but not
 * bounce pings" had one available answer: turn push off forever. Granular
 * control is what keeps push ENABLED at all.
 *
 * Changing a switch re-registers the device so the server-side allowlist
 * updates immediately — a preference that only takes effect after the next
 * cold start is a preference users conclude is broken.
 */
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";

import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  FieldLabel,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { registerForPushNotifications } from "@/lib/push";
import {
  defaultPushSelection,
  groupedPushTopics,
  isRequiredPushEvent,
  readPushTopicSelection,
  togglePushTopic,
  topicDescription,
  writePushTopicSelection,
  type PushTopicGroup,
} from "@/lib/pushTopics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Hand-written on purpose — these are user-facing headings, not slugs. The
 * `Record<PushTopicGroup["category"], …>` type is what keeps them honest: a new
 * manifest category fails the build here rather than rendering a group with no
 * heading, which is how a whole class of notifications becomes invisible in the
 * one screen that controls it.
 */
const CATEGORY_LABELS: Record<PushTopicGroup["category"], string> = {
  security: "Account security",
  approvals: "Approvals",
  billing: "Billing",
  // DELIVERABILITY#15. "Sender health" would be the friendlier phrase, but the
  // tab these notifications open is called Deliverability and a settings row
  // that names a different thing than its destination is a small lie.
  deliverability: "Deliverability",
  integrations: "Integrations",
  campaigns: "Campaigns",
  subscribers: "Subscribers",
  automations: "Automations",
  migrations: "Migrations",
  forms: "Forms",
};

export interface PushTopicsSectionProps {
  enabled: boolean;
  /**
   * Defensive fallback called if a future manifest has no mandatory topic and
   * the user switches the last optional topic off.
   *
   * "Send me nothing" cannot be expressed as an empty allowlist — the server
   * reads an empty `enabled_events` as "no preference" and turns its own
   * default set on (apps/api/internal/mobilepush/devices.go). The only honest
   * representation of "no topics" is an unregistered device, so this asks the
   * owning screen to turn the master push switch off.
   */
  onAllTopicsOff?: (() => void) | undefined;
}

export function PushTopicsSection({
  enabled,
  onAllTopicsOff,
}: PushTopicsSectionProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [selection, setSelection] = useState<string[] | null>(null);
  const groups = groupedPushTopics();

  useEffect(() => {
    let cancelled = false;
    void readPushTopicSelection().then((stored) => {
      if (!cancelled) setSelection(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Defensive migration for a legacy empty stored selection. Current builds
  // inject the mandatory account-security event at the storage boundary, so
  // this normally has nothing to do.
  useEffect(() => {
    if (!enabled || selection === null || selection.length > 0) return;
    const restored = defaultPushSelection();
    setSelection(restored);
    void writePushTopicSelection(restored);
  }, [enabled, selection]);

  const toggle = useCallback(
    (event: string, next: boolean) => {
      // Side effects deliberately OUTSIDE the setState updater: React may
      // invoke an updater more than once, which would double-write storage,
      // double-buzz the taptic engine and fire two registrations.
      setSelection((current) => {
        if (!current) return current;
        const updated = togglePushTopic(current, event, next);
        haptics.tap();
        void persist(current, updated);
        return updated;
      });

      async function persist(previous: string[], updated: string[]) {
        if (!(await writePushTopicSelection(updated))) {
          setSelection(previous);
          toast({
            kind: "error",
            message: "Couldn't save that notification preference.",
          });
          return;
        }
        if (updated.length === 0) {
          // A future manifest with no required events must not send the
          // server's special "defaults" empty allowlist. Unregister instead.
          onAllTopicsOff?.();
          return;
        }
        // Re-register so the SERVER allowlist matches. Failing here is not
        // fatal — the stored preference still applies at the next
        // registration — but the user should know it isn't live yet.
        try {
          if (enabled) await registerForPushNotifications();
        } catch {
          toast({
            kind: "warning",
            message: "Saved, but the server copy will update on next launch.",
          });
        }
      }
    },
    [enabled, onAllTopicsOff, toast],
  );

  if (!selection) {
    return (
      <Card>
        <SkeletonList rows={2} lines={2} label="Loading push topics" />
      </Card>
    );
  }

  return (
    <Card>
      {!enabled ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginBottom: 10,
            fontFamily: FONT.regular,
          }}
        >
          Push is off on this device. These choices are saved and apply as soon
          as you turn it back on.
        </Text>
      ) : null}
      {groups.map((group, index) => (
        <View key={group.category} style={{ marginTop: index === 0 ? 0 : 16 }}>
          <FieldLabel marginBottom={6}>
            {CATEGORY_LABELS[group.category] ?? group.category}
          </FieldLabel>
          <View style={{ gap: 10 }}>
            {group.events.map((topic) => (
              <SettingsSwitchRow
                key={topic.event}
                label={topic.title}
                // The manifest body is a TEMPLATE — three of these carry a
                // `{campaignName}` placeholder that only has a value at send
                // time — so it is resolved before it reaches a label.
                hint={
                  isRequiredPushEvent(topic.event)
                    ? `${topicDescription(topic.body)} Always on while push is enabled.`
                    : topicDescription(topic.body)
                }
                value={selection.includes(topic.event)}
                onValueChange={(next) => toggle(topic.event, next)}
                disabled={isRequiredPushEvent(topic.event)}
              />
            ))}
          </View>
        </View>
      ))}
    </Card>
  );
}
