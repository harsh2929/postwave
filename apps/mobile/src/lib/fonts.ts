/**
 * Brand typography — kept 1:1 with the website + desktop:
 *   - Body / UI text: Inter (the brand sans).
 *   - Display (headlines, big metrics, hero numbers): Fraunces, the
 *     editorial serif the web uses via `font-display`.
 *
 * Fonts load at runtime via expo-font's useFonts() in app/_layout.tsx
 * (no native rebuild needed). Components reference the FONT.* family
 * names; on the first frame before load, RN falls back to the system
 * sans, which is visually close enough to avoid a jarring flash.
 */
// Import the individual generated entry points. The package roots eagerly
// `require()` every weight and italic face, so a seemingly selective named
// import still made Metro ship all 36 font files on both platforms.
import { Fraunces_600SemiBold } from "@expo-google-fonts/fraunces/600SemiBold";
import { Fraunces_700Bold } from "@expo-google-fonts/fraunces/700Bold";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";

/** Asset map passed to useFonts(). */
export const fontAssets = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Fraunces_600SemiBold,
  Fraunces_700Bold,
} as const;

/** Family names to set via `style={{ fontFamily: FONT.x }}`. */
export const FONT = {
  /** Body / UI — Inter. */
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  /** Editorial display serif — Fraunces. Headlines + big metrics only. */
  display: "Fraunces_700Bold",
  displaySemibold: "Fraunces_600SemiBold",
} as const;
