/**
 * lib/assetCapture.ts — the two native doors into the asset library, behind one
 * small, mockable surface.
 *
 * This is the ONLY module in the asset cluster that touches expo-image-picker
 * (the clipboard call moved to the leaf `lib/clipboard` and is re-exported
 * below). Everything downstream of it — the size gate, the format sniff, the
 * stored-filename preview — is pure and lives in lib/assetUploadPolicy, which
 * is why those rules are unit-tested in the node environment while this file
 * is not.
 *
 * WHY BASE64 AND NOT A FILE HANDLE. The upload endpoint takes multipart OR
 * `{filename, mime, content_base64}` (handlers.go:104). The SDK's `request()`
 * JSON-stringifies its body and has no multipart path, so the JSON form is the
 * one that needs no new transport — and the picker can produce base64 directly,
 * so no filesystem read is involved either.
 *
 * WHY `quality: 0.8`. It is a compression setting, not a size guarantee: a
 * modern phone photo at full quality routinely exceeds the server's 10 MiB
 * ceiling, and re-encoding at 0.8 puts the overwhelming majority of them well
 * under it while staying visually indistinguishable in an email. It does NOT
 * replace the size check — `evaluateAssetUpload` still measures the real bytes,
 * because a large panorama can exceed the ceiling at any quality.
 *
 * PERMISSIONS ARE ANSWERED, NOT SWALLOWED. A denied library or camera prompt
 * returns a `denied` result carrying a sentence naming which permission and
 * where to change it. Silently returning "cancelled" for a denial is how a
 * screen ends up looking broken to someone who tapped Deny six months ago.
 */
import * as ImagePicker from "expo-image-picker";

import type { AssetUploadCandidate } from "@/lib/assetUploadPolicy";
import { pathLabel } from "@/lib/direction";

export type AssetPickOutcome =
  | { status: "picked"; candidate: AssetUploadCandidate }
  | { status: "cancelled" }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string };

const PICKER_OPTIONS = {
  mediaTypes: ["images"] as ImagePicker.MediaType[],
  base64: true,
  quality: 0.8,
  // EXIF is deliberately off: it carries GPS coordinates, and an image library
  // shared across a workspace is not a place to publish where a photo was
  // taken. The server strips metadata containers anyway (image.go:69), so
  // asking for it would only widen what this process holds in memory.
  exif: false,
  allowsMultipleSelection: false,
} satisfies ImagePicker.ImagePickerOptions;

function toCandidate(
  result: ImagePicker.ImagePickerResult,
): AssetPickOutcome {
  if (result.canceled) return { status: "cancelled" };
  const asset = result.assets?.[0];
  if (!asset) {
    return {
      status: "failed",
      message: "Nothing came back from the picker. Try again.",
    };
  }
  return {
    status: "picked",
    candidate: {
      base64: asset.base64 ?? null,
      fileName: asset.fileName ?? null,
      kind: asset.type ?? null,
    },
  };
}

function failure(error: unknown, what: string): AssetPickOutcome {
  return {
    status: "failed",
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : `Couldn't open ${what}.`,
  };
}

export async function pickAssetFromLibrary(): Promise<AssetPickOutcome> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return {
        status: "denied",
        message:
          `Moosewave doesn't have access to your photos. Turn it on in ${pathLabel([
            "Settings",
            "Moosewave",
            "Photos",
          ])} to upload from your library.`,
      };
    }
    return toCandidate(await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS));
  } catch (error) {
    return failure(error, "your photo library");
  }
}

export async function captureAssetWithCamera(): Promise<AssetPickOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {
        status: "denied",
        message:
          `Moosewave doesn't have access to the camera. Turn it on in ${pathLabel([
            "Settings",
            "Moosewave",
            "Camera",
          ])} to photograph an image.`,
      };
    }
    return toCandidate(await ImagePicker.launchCameraAsync(PICKER_OPTIONS));
  } catch (error) {
    return failure(error, "the camera");
  }
}

/**
 * Copy text to the system clipboard. Returns whether it landed, so the caller
 * can report a failure instead of claiming a copy that did not happen.
 *
 * Re-exported from `lib/clipboard`, which is the leaf module now that screens
 * outside the asset library copy text too — importing THIS file for a one-line
 * clipboard call would drag `expo-image-picker` along with it.
 */
export { copyToClipboard } from "@/lib/clipboard";
