/**
 * DomainsHeaderActions — the two write affordances in the Custom domains
 * header: "re-check DNS for every domain" and "add one".
 *
 * Extracted from the screen because the re-check flow is not a button, it is a
 * mutation with three outcomes (queued / failed / in flight) and it had grown
 * to forty lines of JSX inside the screen's already-ratcheted render function.
 * It owns the mutation so the screen keeps no state it does not read.
 *
 * The caller decides WHETHER these render at all: both writes are admin-scoped
 * server-side, so a viewer must never be shown a control whose only possible
 * outcome is a 403.
 *
 * The two labels are GLYPHS, not copy — icons the app happens to draw with a
 * character — so they are named constants, never inline strings on a
 * user-facing prop.
 */
import { View } from "react-native";

import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { useToast } from "@/components/Toast";
import { useRunDnsCheck } from "@/hooks/useDeliverability";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { haptics } from "@/lib/haptics";
import { msg } from "@/lib/i18n";

const RECHECK_GLYPH = "⟳";
const ADD_GLYPH = "+";

export interface DomainsHeaderActionsProps {
  onAdd: () => void;
}

export function DomainsHeaderActions({ onAdd }: DomainsHeaderActionsProps) {
  const { toast } = useToast();
  const recheck = useRunDnsCheck();

  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <HeaderAction
        label={RECHECK_GLYPH}
        accessibilityLabel={msg("customDomains.recheck.a11y")}
        tone="muted"
        disabled={recheck.isPending}
        onPress={() => {
          haptics.tap();
          recheck
            .mutateAsync()
            .then(() =>
              toast({
                kind: "info",
                message: msg("customDomains.recheck.queued"),
              }),
            )
            .catch((e: unknown) =>
              toast({
                kind: "error",
                message: writeFailureMessage(
                  e,
                  msg("customDomains.recheck.failed"),
                ),
              }),
            );
        }}
      />
      <HeaderAction
        label={ADD_GLYPH}
        accessibilityLabel={msg("customDomains.add.a11y")}
        onPress={() => {
          haptics.tap();
          onAdd();
        }}
      />
    </View>
  );
}
