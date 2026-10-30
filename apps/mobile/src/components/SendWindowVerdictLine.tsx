/**
 * SendWindowVerdictLine — the one advisory line under the schedule sheet's
 * picker: "is THIS time inside the workspace send window?" (P2.11; desktop
 * parity: SendChecklist's send-window row).
 *
 * Own component, not a block inside CampaignScheduleModal, for two reasons:
 *  - RESPONSIBILITY. Debounce, reachability, the POST /send-window/check
 *    query and the state → sentence mapping are one concern; the sheet's
 *    is picking a time and committing it.
 *  - ADVISORY BY CONSTRUCTION. The sheet never sees the verdict, so nothing
 *    in it can gate Save on one. The schedule handler
 *    (campaigns/handlers_schedule.go) evaluates the same policy itself and
 *    refuses a blocked instant with 422 `outside_send_window`; this line only
 *    lets the operator find that out BEFORE tapping Save.
 *
 * Lives at the top of components/ (like SendTimeOptBanner) rather than under
 * components/campaigns/, which jest.routes.config.cjs stubs to a null
 * component — the schedule sheet's render test asserts on this line.
 */
import { Text } from "react-native";

import { useDebounced } from "@/hooks/useDebounced";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useSendWindowCheck } from "@/hooks/useSendWindowCheck";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import {
  SEND_WINDOW_CHECK_FALLBACK,
  sendWindowCheckState,
  sendWindowScheduleLine,
  type SendWindowLineTone,
} from "@/lib/sendWindowScheduleLine";
import { sendWindowCheckInstant } from "@/lib/sendWindowVerdict";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

/**
 * How long the wheel must rest before the check asks about the new instant.
 * A spinning column passes through many minutes; asking about each would
 * queue a policy evaluation per tick and show a verdict about a time the
 * operator has already left.
 */
const SEND_WINDOW_DEBOUNCE_MS = 400;

export function SendWindowVerdictLine({
  picked,
  applicable,
}: {
  /** The instant the wheel currently shows. */
  picked: Date;
  /**
   * Fixed-time mode with the sheet open. In best-time mode the picked moment
   * is only the window anchor, so a verdict about it would describe the wrong
   * instant; the line then renders nothing and fires no request.
   */
  applicable: boolean;
}) {
  const { t } = useTheme();
  // Only while the phone is online: a check that cannot reach the server
  // should say so rather than spin. The check itself is a pure policy read
  // (send_window.go Check writes nothing), which is why it may run as the
  // picker moves.
  const online = useIsOnline();
  const debouncedPicked = useDebounced(picked, SEND_WINDOW_DEBOUNCE_MS);
  const check = useSendWindowCheck(debouncedPicked, applicable && online);
  const line = sendWindowScheduleLine(
    sendWindowCheckState({
      applicable,
      online,
      settling:
        sendWindowCheckInstant(picked) !==
        sendWindowCheckInstant(debouncedPicked),
      fetching: check.isFetching || check.isLoading,
      errorMessage: check.isError
        ? campaignErrorMessage(check.error, SEND_WINDOW_CHECK_FALLBACK)
        : null,
      verdict: check.data ?? null,
    }),
  );
  if (!line) return null;

  const color: Record<SendWindowLineTone, string> = {
    muted: t.fgMuted,
    ok: t.success,
    warning: t.warning,
    danger: t.danger,
  };
  return (
    <Text
      {...typeCap("caption")}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Send window: ${line.text}`}
      testID="send-window-line"
      style={{
        color: color[line.tone],
        fontSize: 12,
        marginTop: 6,
        fontFamily: FONT.regular,
      }}
    >
      {line.text}
    </Text>
  );
}
