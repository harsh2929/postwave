/**
 * PushDeviceSection — the "push notifications" card of the Settings screen:
 * the device switch, the token fingerprint, and the server's own answer about
 * whether anything is actually being delivered.
 *
 * Extracted from app/(tabs)/settings.tsx so the screen file stops growing with
 * every fact we learn how to show. The three parts belong together because
 * they are three different authorities on ONE question — the OS permission,
 * this device's stored token, and the server row — and a user reading only the
 * first two has been misled every time the third disagreed (NATIVE#49).
 *
 * The screen keeps ownership of the toggle itself: enabling push can prompt
 * for OS permission, which is a one-shot resource the settings screen already
 * primes and reports on.
 */
import { Text } from "react-native";

import { PushDeliveryHealthRow } from "@/components/settings/PushDeliveryHealthRow";
import { PushSelfServiceRows } from "@/components/settings/PushSelfServiceRows";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
  redactToken,
} from "@/components/settings/SettingsScreenPrimitives";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PushDeviceSectionProps {
  enabled: boolean;
  /** Null when this device has never registered. */
  token: string | null;
  onToggle: (next: boolean) => void;
  /** Re-runs registration; resolves true once the device is registered. */
  onReRegister: () => Promise<boolean>;
}

export function PushDeviceSection({
  enabled,
  token,
  onToggle,
  onReRegister,
}: PushDeviceSectionProps) {
  const { t } = useTheme();
  return (
    <>
      <SectionHeader
        anchor="push"
        title="Push notifications"
        subtitle="Choose what pings this device, when it may ping you, and prove the whole chain works."
      />
      <Card>
        <SettingsSwitchRow
          label="Enable on this device"
          hint="Registers or unregisters this device for push notification delivery."
          value={enabled}
          onValueChange={onToggle}
        />
        {token ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 10,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            Token ending {redactToken(token)}
          </Text>
        ) : null}
        <PushDeliveryHealthRow
          locallyEnabled={enabled}
          onReRegister={onReRegister}
        />
        <PushSelfServiceRows locallyEnabled={enabled} />
      </Card>
    </>
  );
}
