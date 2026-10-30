/**
 * components/scan/ScanViewfinder — everything drawn OVER the camera preview:
 * the bracket frame, the standing instruction, the inline verdict hint, and the
 * torch (NATIVE#40).
 *
 * TWO LAYERS, ON PURPOSE. The frame/instruction layer is `pointerEvents="none"`
 * so the camera keeps receiving frames underneath it; the torch therefore CANNOT
 * live inside it or it would be un-tappable. It sits in its own sibling layer.
 * That is the single easiest mistake to make in this file and the reason the two
 * are separated rather than merged into one absolute overlay.
 *
 * TORCH STATE IS NEVER COLOUR-ALONE. The pill changes its label ("Torch" →
 * "Torch on"), its border, its fill, and its filament dot together, and carries
 * `accessibilityState={{ selected }}` — so it reads in monochrome, under
 * VoiceOver, and for a user who cannot distinguish the accent from white.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const ABSOLUTE_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

export function ScanViewfinder({
  t,
  hint,
  torch,
  showTorch,
  onToggleTorch,
  onScanPhoto,
  scanningPhoto,
}: {
  t: ReturnType<typeof useTheme>["t"];
  /** Inline verdict line under the frame ("Not a Moosewave code."), or null. */
  hint: string | null;
  torch: boolean;
  /**
   * False while the route is unfocused. The frame overlay stays mounted (so
   * returning to the screen does not flash a re-layout) but the torch does not:
   * the CameraView behind it has been torn down, so there is nothing to light.
   */
  showTorch: boolean;
  onToggleTorch: () => void;
  /**
   * Decode a QR from an image in the photo library instead of the live camera.
   *
   * This screen's stated purpose is desktop→mobile handoff, and the most
   * common way a code reaches a phone is as a SCREENSHOT — which the live
   * camera can never read, because the code is on the same device.
   */
  onScanPhoto?: (() => void) | undefined;
  /** True while a picked image is being decoded. */
  scanningPhoto?: boolean | undefined;
}) {
  return (
    <>
      <View
        pointerEvents="none"
        style={{
          ...ABSOLUTE_FILL,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: 240,
            height: 240,
            borderRadius: 24,
            borderWidth: 3,
            borderColor: t.accent,
            backgroundColor: "transparent",
          }}
        />
        <Text
          {...typeCap("callout")}
          style={{
            color: "#ffffff",
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            marginTop: 20,
            textAlign: "center",
            textShadowColor: "rgba(0,0,0,0.6)",
            textShadowRadius: 4,
          }}
        >
          Point at a Moosewave QR code
        </Text>
        {hint ? (
          <View
            style={{
              marginTop: 12,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 999,
              backgroundColor: "rgba(0,0,0,0.7)",
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: "#ffffff",
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
              }}
            >
              {hint}
            </Text>
          </View>
        ) : null}
      </View>

      {showTorch ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 28,
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 16,
          }}
        >
          <Pressable
            onPress={() => {
              haptics.tap();
              onToggleTorch();
            }}
            accessibilityRole="button"
            accessibilityLabel={torch ? "Turn torch off" : "Turn torch on"}
            accessibilityHint="Lights the camera for scanning a code in the dark"
            accessibilityState={{ selected: torch }}
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: torch ? t.accent : "rgba(255,255,255,0.35)",
              backgroundColor: torch ? t.accent : "rgba(0,0,0,0.55)",
            }}
          >
            {/* Decorative filament dot — the ONLY thing here allowed to ignore
              the OS text size, because it carries no meaning the words beside
              it do not already carry. */}
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                borderWidth: 1.5,
                borderColor: torch ? t.accentFg : "#ffffff",
                backgroundColor: torch ? t.accentFg : "transparent",
              }}
            />
            <Text
              {...typeCap("control")}
              style={{
                color: torch ? t.accentFg : "#ffffff",
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {torch ? "Torch on" : "Torch"}
            </Text>
          </Pressable>

          {onScanPhoto ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                onScanPhoto();
              }}
              disabled={scanningPhoto}
              accessibilityRole="button"
              accessibilityLabel={
                scanningPhoto ? "Reading photo" : "Scan a code from a photo"
              }
              accessibilityHint="Reads a QR code out of a screenshot or saved image"
              accessibilityState={{ disabled: Boolean(scanningPhoto) }}
              hitSlop={12}
              style={{
                minHeight: 44,
                minWidth: 44,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 18,
                paddingVertical: 10,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.35)",
                backgroundColor: "rgba(0,0,0,0.55)",
                opacity: scanningPhoto ? 0.6 : 1,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: "#ffffff",
                  ...typeStyle("control"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                {scanningPhoto ? "Reading…" : "From photo"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  );
}
