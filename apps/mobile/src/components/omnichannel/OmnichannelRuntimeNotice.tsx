/**
 * OmnichannelRuntimeNotice — the one sentence this whole surface depends on.
 *
 * Omnichannel EXECUTION is deliberately disabled server-side:
 * `omnichannelRuntimeQualified` is the constant `false`
 * (apps/api/internal/omnichannel/omnichannel.go:22), every catalog channel is
 * emitted with `runtime_status: "unavailable"`, and every campaign response
 * carries the same `runtimecapability.Descriptor`. Nothing dispatches. A row
 * whose `status` says "sending" is a value somebody typed into a form, not a
 * report from a sender.
 *
 * So a definition list is genuinely useful — it is the only place on a phone
 * where a cross-channel plan is visible at all — and it is also the easiest
 * screen in the app to misread as a delivery monitor. This component is the
 * fix, and it is deliberately NOT a dismissible banner: the caveat is as true
 * on the tenth visit as on the first.
 *
 * It renders the server's OWN message rather than a paraphrase. If the runtime
 * is ever qualified, the descriptor changes and this notice disappears on its
 * own — no client release required, and no stale warning left behind claiming
 * a working system is broken.
 */
import { Text, View } from "react-native";

import { withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import {
  runtimeIsExecuting,
  type OmniRuntime,
} from "@/lib/omnichannelDefinitions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OmnichannelRuntimeNotice({
  runtime,
  statusIsLiveSounding,
}: {
  runtime: OmniRuntime | null;
  /** True when a status on screen would read as a claim about live delivery. */
  statusIsLiveSounding?: boolean | undefined;
}) {
  const { t } = useTheme();
  if (runtimeIsExecuting(runtime)) return null;

  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 6,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(t.warning, 0.35),
        backgroundColor: withAlpha(t.warning, 0.12),
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        Definitions only — nothing here is sending
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {runtime?.message ??
          "Omnichannel campaign execution is unavailable; nothing was materialized, evaluated, or dispatched."}
      </Text>
      {statusIsLiveSounding ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The status shown below is persisted metadata on the row, not a report
          from a dispatcher.
        </Text>
      ) : null}
      {runtime && runtime.prerequisites.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Still required: ${runtime.prerequisites.join(", ").replace(/_/gu, " ")}.`}
        </Text>
      ) : null}
    </View>
  );
}
