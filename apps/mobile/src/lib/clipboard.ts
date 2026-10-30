/**
 * lib/clipboard.ts — the app's ONE door to the system clipboard.
 *
 * It previously lived inside `lib/assetCapture.ts`, which also imports
 * `expo-image-picker`. That was fine for the asset library, but it meant any
 * screen that wanted to copy one string dragged the camera/photo-library
 * permission modules in with it. The DNS-record card — a screen whose entire
 * job is transporting a 400-character DKIM value into a registrar form — has
 * no business importing an image picker, so the clipboard call now lives in
 * its own leaf module and `assetCapture` re-exports it.
 *
 * `Clipboard.setStringAsync` resolves `false` (and can reject on a locked
 * pasteboard) rather than throwing consistently, so the boolean is returned to
 * the caller instead of being swallowed: a control that says "Copied" when
 * nothing was copied is worse than one that admits the failure.
 */
import * as Clipboard from "expo-clipboard";

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(value);
  } catch {
    return false;
  }
}
