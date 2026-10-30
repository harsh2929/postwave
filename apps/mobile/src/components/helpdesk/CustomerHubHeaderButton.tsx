/**
 * The Helpdesk header's entry point to the Customer Hub configuration record.
 *
 * Owns the sheet's open state and the return-focus ref so the queue screen
 * mounts one element and gains no state of its own. Rendered for every
 * session that reaches the queue; the sheet itself states the admin gate and
 * the offline case, because "the control is missing" and "the control is
 * refused, and here is why" are different answers to an operator.
 */
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { CustomerHubConfigSheet } from "@/components/helpdesk/CustomerHubConfigSheet";
import type { HelpdeskAccess } from "@/hooks/useHelpdesk";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CustomerHubHeaderButton({
  access,
}: {
  access: HelpdeskAccess;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<View>(null);

  return (
    <>
      <Pressable
        ref={buttonRef}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Open the Customer Hub configuration record"
        // NativeWind v4: a function-style `style` on Pressable drops layout.
        style={{
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 4,
        }}
      >
        <Text
          {...typeCap("badge")}
          style={{
            color: t.accent,
            ...typeStyle("badge"),
            fontFamily: FONT.semibold,
          }}
        >
          Hub
        </Text>
      </Pressable>
      <CustomerHubConfigSheet
        visible={open}
        onClose={() => setOpen(false)}
        access={access}
        returnFocusRef={buttonRef}
      />
    </>
  );
}
