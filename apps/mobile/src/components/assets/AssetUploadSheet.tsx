/**
 * AssetUploadSheet — the two ways an image gets into the library from a phone.
 *
 * This is the one thing a phone does here that a laptop cannot: the picture is
 * already on the device, or is about to be taken. Everything else on this
 * surface is browsing.
 *
 * IT STATES THE RULES BEFORE THE PICKER OPENS, not after the upload fails. The
 * 10 MB ceiling and the four accepted formats are the server's
 * (`MaxBytes`, image.go:18; `validateAndSanitizeImage`, image.go:90), and both
 * are checked again client-side by `evaluateAssetUpload` the instant a pick
 * comes back — so the refusal, when there is one, costs nothing but a tap.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { ASSET_MAX_BYTES, assetSizeLabel } from "@/lib/assetUploadPolicy";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetUploadSheetProps {
  visible: boolean;
  /** True while an upload is in flight; both doors are disabled. */
  busy: boolean;
  onClose: () => void;
  onPickLibrary: () => void;
  onPickCamera: () => void;
}

function Choice({
  label,
  description,
  onPress,
  disabled,
}: {
  label: string;
  description: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ disabled }}
      style={{
        minHeight: 64,
        justifyContent: "center",
        gap: 3,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {description}
      </Text>
    </Pressable>
  );
}

export function AssetUploadSheet({
  visible,
  busy,
  onClose,
  onPickLibrary,
  onPickCamera,
}: AssetUploadSheetProps) {
  const { t } = useTheme();
  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 12,
          }}
        >
          <Text
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            Add an image
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Cancel
            </Text>
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <Choice
            label="Choose from library"
            description="Pick a photo or graphic already on this phone."
            onPress={onPickLibrary}
            disabled={busy}
          />
          <Choice
            label="Take a photo"
            description="Open the camera and shoot one now."
            onPress={onPickCamera}
            disabled={busy}
          />

          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {`PNG, JPEG, GIF and WebP, up to ${assetSizeLabel(ASSET_MAX_BYTES)}. Photos are re-encoded before sending, and location data is never included.`}
          </Text>

          {busy ? (
            <Text
              accessibilityLiveRegion="polite"
              {...typeCap("callout")}
              style={{
                color: t.fgMuted,
                ...typeStyle("callout"),
                fontFamily: FONT.regular,
              }}
            >
              Uploading… keep this screen open until it finishes.
            </Text>
          ) : null}
        </View>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
