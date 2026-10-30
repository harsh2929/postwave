/**
 * DisplayPreferencesSection — theme, list density, and which screen the app
 * opens on (LOVE#51).
 *
 * Settings offered exactly ONE display preference — theme — in a product whose
 * every list is card-heavy and whose every launch lands on Dashboard. An
 * approvals-focused operator opened the app somewhere other than their work,
 * every time, forever.
 *
 * Three deliberate positions, all of which are the reason this is a component
 * and not three loose controls in `settings.tsx`:
 *
 *  1. DENSITY NEVER TOUCHES TEXT SIZE. It removes padding only. Type belongs
 *     to the OS Dynamic Type setting (lib/typeScale.ts), and a "compact" that
 *     quietly shrank text would be overriding an accessibility preference with
 *     a display one. The numbers, and the assertion that no row drops under
 *     the 44pt touch floor, live in lib/displayPreferences.ts.
 *
 *  2. THE LANDING LIST IS ROLE-GATED AGAINST THE HANDLER, not the manifest.
 *     `GET /api/v1/approvals` calls `requireAdmin`
 *     (apps/api/internal/approvals/handlers.go:226 → :597, owner|admin only),
 *     so Approvals is offered only to someone it will admit. The generated
 *     route-authz manifest says viewer, but that row is a
 *     `fail_closed_default` safe default rather than a reading of the code.
 *
 *  3. TAB ORDER IS ABSENT ON PURPOSE, AND SAYS SO. The five bottom tabs are
 *     fixed across mobile, desktop and web by `@postwave/nav`; per-device
 *     reordering would make a screenshot in a support thread mean something
 *     different on the next phone. The need underneath it — reaching YOUR
 *     destinations fast — is already met by pinned favourites in More. The
 *     last card states that instead of leaving a hole where a control looks
 *     like it should be.
 *
 * Every string here comes from the catalogue (lib/messagesEn.ts) through
 * `msg()`. This file is in `i18nCoverage.test.ts`'s covered set, so a
 * hardcoded literal added later fails the build — it is the JSX half of the
 * proof that the i18n seam works on real UI, not only on pure copy modules.
 */
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import {
  Card,
  FieldLabel,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { useDisplayPreferences } from "@/hooks/useDisplayPreferences";
import {
  ROW_DENSITIES,
  landingOptions,
  resolveLandingRoute,
  type LandingRoute,
  type RowDensity,
} from "@/lib/displayPreferences";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { msg } from "@/lib/i18n";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

const THEME_OPTIONS: readonly ThemePreference[] = ["system", "light", "dark"];

const THEME_LABELS = {
  system: "display.theme.system",
  light: "display.theme.light",
  dark: "display.theme.dark",
} as const;

const DENSITY_LABELS = {
  comfortable: "display.density.comfortable",
  compact: "display.density.compact",
} as const;

/** Route → catalogue key. The route is policy; the word is a message. */
const LANDING_LABELS = {
  "/(tabs)/dashboard": "display.landing.dashboard",
  "/(tabs)/subscribers": "display.landing.subscribers",
  "/(tabs)/campaigns": "display.landing.campaigns",
  "/(tabs)/approvals": "display.landing.approvals",
} as const satisfies Record<LandingRoute, string>;

const CHIP_ROW = {
  flexDirection: "row" as const,
  gap: 6,
  flexWrap: "wrap" as const,
};

export function DisplayPreferencesSection({
  onChange,
}: {
  /**
   * Structural telemetry hook owned by the Settings screen — `(setting, value)`
   * where both are fixed enum tokens from this file, never workspace content.
   */
  onChange?: ((setting: string, value: string) => void) | undefined;
}) {
  const { t, preference, setPreference } = useTheme();
  const prefs = useDisplayPreferences();
  const effectiveRole = useAuthStore(
    (s) => s.session?.effectiveRole ?? s.session?.role ?? null,
  );
  const mode = useAuthStore((s) => s.mode);
  const canApprove = canAccessMinimumRole("admin", effectiveRole, mode);
  const options = landingOptions(canApprove);
  // Resolved, not raw: an admin who chose Approvals and was later demoted must
  // see the fallback selected rather than a chip that is no longer offered.
  const landing = resolveLandingRoute(prefs.landing, canApprove);

  return (
    <>
      <SectionHeader
        anchor="appearance"
        title={msg("display.title")}
        subtitle={msg("display.subtitle")}
      />
      <Card>
        <FieldLabel>{msg("display.theme.legend")}</FieldLabel>
        <View style={CHIP_ROW}>
          {THEME_OPTIONS.map((option) => (
            <Chip
              key={option}
              label={msg(THEME_LABELS[option])}
              active={preference === option}
              onPress={() => {
                haptics.tap();
                onChange?.("theme", option);
                setPreference(option);
              }}
            />
          ))}
        </View>
        <Hint text={msg("display.theme.hint")} />

        <FieldLabel marginBottom={4}>{msg("display.density.legend")}</FieldLabel>
        <View style={CHIP_ROW}>
          {ROW_DENSITIES.map((option: RowDensity) => (
            <Chip
              key={option}
              label={msg(DENSITY_LABELS[option])}
              active={prefs.density === option}
              onPress={() => {
                haptics.tap();
                onChange?.("row_density", option);
                prefs.setDensity(option);
              }}
            />
          ))}
        </View>
        <Hint text={msg("display.density.hint")} />

        <FieldLabel marginBottom={4}>{msg("display.landing.legend")}</FieldLabel>
        <View style={CHIP_ROW}>
          {options.map((route) => {
            const label = msg(LANDING_LABELS[route]);
            return (
              <Chip
                key={route}
                label={label}
                // The visible chip is one word ("Home"); on its own it does
                // not say what choosing it DOES. The spoken label carries the
                // verb, which is the whole point of the setting.
                accessibilityLabel={msg("display.landing.a11y", { label })}
                active={landing === route}
                onPress={() => {
                  haptics.tap();
                  onChange?.("landing_route", route);
                  prefs.setLanding(route);
                }}
              />
            );
          })}
        </View>
        <Hint text={msg("display.landing.hint")} />
      </Card>

      {/* The control that is deliberately not here, said out loud. A missing
          affordance with no explanation reads as an oversight; this reads as a
          decision, and it points at the thing that DOES solve the need. */}
      <Card>
        <FieldLabel>{msg("display.tabOrder.legend")}</FieldLabel>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {msg("display.tabOrder.hint")}
        </Text>
      </Card>
    </>
  );
}

function Hint({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginTop: 6,
        marginBottom: 12,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
