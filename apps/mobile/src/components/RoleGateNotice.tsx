/**
 * RoleGateNotice — "your session cannot see this", said once, the same way.
 *
 * WHY THIS IS ITS OWN COMPONENT. The branch it renders is the single easiest
 * place for a screen to state something false: with no data and a role the
 * server will refuse, the path of least resistance is to fall through to an
 * empty state, which tells the reader their WORKSPACE has nothing when the true
 * statement is about their SESSION. Two screens had already written their own
 * version of this notice; a third copy would have been the point where they
 * started to drift.
 *
 * TWO WAYS IN, ONE MESSAGE. Either the client already knows the session's role
 * is below the route's floor, or a request came back 403. `live` distinguishes
 * them for the reader — a live refusal means the role may have changed since
 * sign-in, which is worth saying because it is actionable and the pre-emptive
 * case is not.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RoleGateNoticeProps {
  /** Headline, e.g. "Needs an owner or admin session". */
  title: string;
  /** Why, in the server's terms, plus where the reader can go instead. */
  body: string;
  /** The server refused a request just now, rather than the client pre-empting. */
  live?: boolean;
}

export function RoleGateNotice({ title, body, live = false }: RoleGateNoticeProps) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${body}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
      {live ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          The server refused this read just now, so the role may have changed
          since you signed in.
        </Text>
      ) : null}
    </View>
  );
}
