/**
 * HygienePlaybooksCard — the canned remediation education desktop ships
 * (HygienePlaybooks.tsx), translated to collapsible mobile cards.
 *
 * Pure markup, no API. The CONTENT is desktop's verbatim (sunset flow, Apple
 * MPP, bounce-class playbook) so the two clients teach the same recipes; only
 * the container is mobile idiom. The steps live in lib/hygienePlaybooks.ts so
 * the copy is node-testable and this file stays a renderer.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { OpsCard, OpsCardBody, OpsCardTitle } from "@/components/deliverability/OpsCard";
import { FONT } from "@/lib/fonts";
import { HYGIENE_PLAYBOOKS } from "@/lib/hygienePlaybooks";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HygienePlaybooksCard() {
  const { t } = useTheme();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <OpsCard>
      <OpsCardTitle>Hygiene playbooks</OpsCardTitle>
      <OpsCardBody>
        Operator-grade recipes for keeping reputation healthy.
      </OpsCardBody>
      {HYGIENE_PLAYBOOKS.map((playbook) => {
        const isOpen = open === playbook.id;
        return (
          <View
            key={playbook.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 8,
              gap: 4,
            }}
          >
            <Pressable
              onPress={() => {
                haptics.tap();
                setOpen(isOpen ? null : playbook.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${playbook.title}. ${playbook.summary}`}
              accessibilityState={{ expanded: isOpen }}
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: "center", gap: 2 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {playbook.title}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {playbook.summary}
              </Text>
            </Pressable>
            {isOpen ? (
              <View style={{ gap: 6, paddingBottom: 4 }}>
                {playbook.intro ? <OpsCardBody>{playbook.intro}</OpsCardBody> : null}
                {playbook.steps.map((step) => (
                  <Text
                    key={step.lead}
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    <Text style={{ fontFamily: FONT.semibold, color: t.fg }}>
                      {`${step.lead}: `}
                    </Text>
                    {step.detail}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </OpsCard>
  );
}
