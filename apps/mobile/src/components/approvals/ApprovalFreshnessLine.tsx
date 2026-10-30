/**
 * ApprovalFreshnessLine — "Approvals as of 3m ago."
 *
 * The governance cluster's answer to a question every compliance surface owes
 * its reader and none of them answered: a screen resumed from background after
 * two hours looks identical to one fetched a second ago. On a queue whose rows
 * expire and whose decisions are irreversible, that is the difference between
 * deciding on current state and deciding on a memory.
 *
 * The sentence itself comes from lib/auditGrouping.freshnessSentence, which is
 * derived from the OLDEST contributing stamp — overstating freshness is worse
 * than saying nothing, because it is trusted. Renders nothing until something
 * has actually loaded.
 */
import { Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ApprovalFreshnessLine({ sentence }: { sentence: string | null }) {
  const { t } = useTheme();
  if (!sentence) return null;
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {sentence}
    </Text>
  );
}
