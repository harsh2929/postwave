/**
 * lib/photoScan.ts — the pure half of "scan a QR out of a photo".
 *
 * The scanner's stated purpose is desktop→mobile handoff, and the most common
 * way one of those codes reaches a phone is as a SCREENSHOT — which the live
 * camera can never read, because the code is on the same screen holding the
 * camera. `expo-camera`'s `scanFromURLAsync` decodes an image file; this module
 * owns the decisions around it so they are testable without a native module.
 *
 * Import-free of react-native/expo by construction (node vitest environment).
 */

/** What the picker + decoder produced, reduced to one of four outcomes. */
export type PhotoScanOutcome =
  /** The user backed out of the picker. Say nothing. */
  | { kind: "cancelled" }
  /** A code was found. `data` is its payload, to be interpreted as a scan. */
  | { kind: "code"; data: string }
  /** The image decoded fine and simply contains no QR. */
  | { kind: "no-code" }
  /** The picker or the decoder failed. NOT the same as "no code". */
  | { kind: "failed" };

/**
 * Reduce a decode result to an outcome.
 *
 * `codes` is whatever `scanFromURLAsync` returned. The FIRST non-empty payload
 * wins: multiple codes in one screenshot is real (a page with two QRs), and
 * asking the user to crop is worse than acting on the first, which is also what
 * the live camera does with two codes in frame.
 *
 * ABSENCE IS NOT FAILURE: an empty array means the image genuinely had no code
 * and must produce `no-code`, which is a statable answer. A throw upstream is
 * `failed`, which is a different sentence to the user.
 */
export function photoScanOutcome(
  codes: readonly { data?: unknown }[] | null | undefined,
): PhotoScanOutcome {
  if (!Array.isArray(codes)) return { kind: "failed" };
  for (const code of codes) {
    const data = typeof code?.data === "string" ? code.data.trim() : "";
    if (data) return { kind: "code", data };
  }
  return { kind: "no-code" };
}

/**
 * Inline hint for an outcome, or null when the screen should stay silent.
 *
 * Cancelling is a deliberate user action and needs no commentary; every other
 * non-success outcome gets a distinct sentence, because "no code in that
 * picture" and "we couldn't read that picture" send the user to different next
 * steps.
 */
export function photoScanHint(outcome: PhotoScanOutcome): string | null {
  switch (outcome.kind) {
    case "no-code":
      return "No QR code in that image.";
    case "failed":
      return "Couldn't read that image.";
    case "cancelled":
    case "code":
    default:
      return null;
  }
}
