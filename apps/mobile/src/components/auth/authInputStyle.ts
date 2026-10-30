/**
 * authInputStyle — the ONE text-input style for the auth tree.
 *
 * This block was copy-pasted into six files, and two copies had already
 * drifted: `forgot-password.tsx` and `PasswordResetForm.tsx` were otherwise
 * byte-identical to `sign-in.tsx` but omitted `fontFamily: FONT.regular`, so
 * those two screens rendered their inputs in the system font while every other
 * auth input rendered in Inter. Nobody would ever notice that in review; a
 * shared module makes it impossible.
 */
import type { TextStyle } from "react-native";

import { FONT } from "@/lib/fonts";
import type { useTheme } from "@/lib/theme";

type ThemeTokens = ReturnType<typeof useTheme>["t"];

export function authInputStyle(
  t: ThemeTokens,
  options: { invalid?: boolean } = {},
): TextStyle {
  return {
    backgroundColor: t.bgSubtle,
    // An invalid field is bordered AND captioned — colour alone is not a
    // signal a colour-blind or screen-reader user receives.
    borderColor: options.invalid ? t.danger : t.border,
    borderWidth: 1,
    color: t.fg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    fontFamily: FONT.regular,
  };
}
