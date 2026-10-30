/**
 * Scan — full-screen QR scanner.
 *
 * A mobile-native capability that also powers desktop→mobile handoff:
 * scan a QR rendered by the web/desktop admin (a `moosewave://` or
 * `https://app.moosewave.com/app/<slug>/<id>` code) and the phone opens
 * that exact entity. Interpretation is delegated to the pure
 * interpretClipboardOrQr (src/lib/qr.ts) so the recognition logic stays
 * unit-tested and shared with the route-map source of truth.
 *
 * On a recognised code:
 *   - entity → router.replace the mobile route (open it in place; the
 *     scanner isn't worth keeping on the back stack)
 *   - email  → confirm, then open Subscribers pre-searched for that address
 *     (mobile looks people up; creation lives in the web admin)
 *   - url    → confirm, then Linking.openURL (leaves the app)
 *   - unknown→ inline "Not a Moosewave code" hint + a brief re-arm cooldown
 *
 * Camera permission is requested with a branded prompt; a denied state
 * links to system Settings. Scans are debounced so a single QR in frame
 * doesn't fire a flood of navigations.
 *
 * CAPTURE FEEDBACK. A camera scanner that succeeds silently leaves the user
 * holding the phone steady, unsure whether anything happened, until navigation
 * finally occurs. Every recognised code fires `haptics.success()` the instant
 * the lock is taken — before any navigation or Alert — and an unrecognised one
 * fires `haptics.warning()`, so the hand knows the answer before the eye does.
 *
 * THE CAMERA STOPS WHEN THE SCREEN DOES. `scan` is a hidden tab route, and
 * react-navigation keeps a visited screen mounted: without a focus check the
 * CameraView kept running (and `onBarcodeScanned` kept firing) after the user
 * navigated away — battery drain plus a persistent OS camera-in-use indicator
 * on a screen nobody is looking at, which reads as a privacy problem even when
 * it isn't. The re-arm timer is likewise held in a ref and cleared on unmount
 * so it cannot fire against a dead screen.
 *
 * CONFIRMATIONS USE THE APP'S SHEET, NOT `Alert`. The two "are you sure"
 * moments here (look up a scanned email, open a scanned link) went through the
 * unbranded OS dialog, which is also the same control the rest of the app uses
 * to report RESULTS — so a question and an answer looked identical. Both now
 * go through `useConfirm`, which is awaitable, so the re-arm no longer has to
 * be threaded through three separate callbacks.
 *
 * TORCH (NATIVE#40). The one place this scanner is actually used — a printed
 * sign-up code on a poster at an event, a code taped to a shelf in a warehouse
 * — is also the one place the light is bad, and a camera scanner with no torch
 * simply fails there. `enableTorch` is a CameraView prop, so the control is a
 * boolean piece of screen state; it is forced back off whenever the screen
 * loses focus, because the camera is torn down on blur and a torch flag left
 * true would re-ignite the LED in the user's face on return.
 *
 * SCAN FROM A PHOTO (COMMERCE#56). The screen exists for desktop→mobile
 * handoff, and the most common way one of those codes reaches a phone is as a
 * SCREENSHOT — which the live camera can never read, because the code is on the
 * same screen holding the camera. `expo-camera`'s `scanFromURLAsync` decodes an
 * image file; `expo-image-picker` supplies it. Outcome policy (code found /
 * no code / decode failed / cancelled) is pure and unit-tested in
 * lib/photoScan.ts — "no QR in that image" and "couldn't read that image" send
 * the user to different next steps and must never collapse into one message.
 *
 * TYPE. Every `Text` here is on the shared Dynamic Type scale (lib/typeScale):
 * the permission prompt is prose that must reflow at large accessibility sizes,
 * and the torch pill is a dense control whose row cannot grow. Nothing here
 * carries a hand-picked pixel size any more.
 *
 * NativeWind v4 gotcha: every Pressable here uses a STATIC style object,
 * never the function-form `style={({pressed})=>…}` (which NativeWind v4
 * silently drops).
 */
import {
  CameraView,
  scanFromURLAsync,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
// `useIsFocused` comes from expo-router (which re-exports React Navigation's)
// rather than from @react-navigation/native directly — the same import the
// dashboard uses. Reaching past the router for it bypasses the router seam
// the rest of the app is written and tested against.
import { router, useIsFocused } from "expo-router";
import type { Href } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { ScanChrome } from "@/components/scan/ScanChrome";
import { ScanPermissionPrompt } from "@/components/scan/ScanPermissionPrompt";
import { ScanViewfinder } from "@/components/scan/ScanViewfinder";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { haptics } from "@/lib/haptics";
import { trackCommerceAction } from "@/lib/commerceTelemetry";
import { trackPermissionOutcome } from "@/lib/permissionTelemetry";
import { photoScanHint, photoScanOutcome } from "@/lib/photoScan";
import { interpretClipboardOrQr } from "@/lib/qr";
import { useTheme } from "@/lib/theme";

// Route-scoped boundary: a camera/permission crash must not take the app down.
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

// Re-arm window after a handled scan. A QR sitting in frame fires
// onBarcodeScanned continuously; this stops a single code from queuing
// dozens of navigations / Alerts.
const SCAN_DEBOUNCE_MS = 2000;

export default function Scan() {
  const { t } = useTheme();
  const confirm = useConfirm();
  const [permission, requestPermission] = useCameraPermissions();
  // Inline status line under the frame ("Not a Moosewave code", etc).
  const [hint, setHint] = useState<string | null>(null);
  // Guards against the continuous onBarcodeScanned firehose.
  const lockedRef = useRef(false);
  const reArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only render the camera while this screen is the focused route.
  const focused = useIsFocused();
  // NATIVE#40 — torch for the low-light case the scanner exists for.
  const [torch, setTorch] = useState(false);
  // COMMERCE#56 — decoding a picked image; the picker can sit open for a long
  // time, so the control must show it is busy rather than look inert.
  const [scanningPhoto, setScanningPhoto] = useState(false);
  // The picker is modal and outlives a navigation, so every setState after it
  // resolves has to be guarded.
  const mountedRef = useRef(true);
  useScreenViewed("scan");

  // Blur tears the CameraView down, which extinguishes the LED. Keeping the
  // flag true would silently re-ignite it the next time the user opens the
  // scanner, so the control returns to its off state with the camera.
  //
  // FOCUS ALSO RE-ARMS THE SCANNER. `lockedRef` throttles the continuous
  // onBarcodeScanned firehose, and the entity / deviceApprove branches take it
  // and deliberately never start a re-arm timer because they navigate away.
  // But this is a TAB route and react-navigation keeps a visited screen
  // MOUNTED — the same fact the `focused` guard above the CameraView exists
  // for — so the ref survived the navigation that abandoned it and the SECOND
  // visit to the scanner was a live camera that silently refused every code
  // for the rest of the process. Re-entering the screen is the re-arm those
  // branches never scheduled.
  useEffect(() => {
    if (!focused) {
      setTorch(false);
      return;
    }
    if (reArmTimer.current) {
      clearTimeout(reArmTimer.current);
      reArmTimer.current = null;
    }
    lockedRef.current = false;
  }, [focused]);

  const reArmLater = useCallback(() => {
    if (reArmTimer.current) clearTimeout(reArmTimer.current);
    reArmTimer.current = setTimeout(() => {
      reArmTimer.current = null;
      lockedRef.current = false;
    }, SCAN_DEBOUNCE_MS);
  }, []);

  // A pending re-arm — or a resolving photo pick — must not outlive the screen.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reArmTimer.current) clearTimeout(reArmTimer.current);
      reArmTimer.current = null;
    };
  }, []);

  const handleCode = useCallback(
    (payload: string) => {
      if (lockedRef.current) return;
      lockedRef.current = true;
      const verdict = interpretClipboardOrQr(payload);
      // Confirm the capture in the hand immediately — before navigation or an
      // Alert, either of which can take a beat to appear.
      if (verdict.kind === "unknown") haptics.warning();
      else haptics.success();
      // COMMERCE#58. Only WHETHER a code was recognised — never the code, the
      // entity, the id or the address it resolved to. A high `unrecognized`
      // rate means the QR producers and this parser have drifted, which is
      // otherwise invisible until someone reports that scanning "does nothing".
      trackCommerceAction(
        "scan_code",
        verdict.kind === "unknown" ? "unrecognized" : "success",
      );

      switch (verdict.kind) {
        case "entity": {
          // Open the entity in place — replace so Back doesn't bounce
          // the user into a dead camera screen.
          setHint(null);
          router.replace(verdict.href as unknown as Href);
          // No re-arm: we've navigated away from the scanner.
          return;
        }
        case "deviceApprove": {
          // A CLI/desktop device-login QR — go straight to the native approval
          // screen (pre-filled) instead of bouncing to the browser.
          setHint(null);
          router.replace({
            pathname: "/(tabs)/cli-approve",
            params: { user_code: verdict.userCode },
          } as unknown as Href);
          return;
        }
        case "email": {
          setHint(null);
          void (async () => {
            const ok = await confirm({
              title: "Look up subscriber?",
              message: verdict.email,
              confirmLabel: "Look up",
            });
            // Declining re-arms the scanner; accepting navigates away, so
            // there is nothing left to re-arm.
            if (!ok) {
              reArmLater();
              return;
            }
            // Mobile manages subscribers (creation is web-admin), so we open
            // Subscribers pre-searched for this address.
            router.replace({
              pathname: "/(tabs)/subscribers",
              params: { q: verdict.email },
            } as unknown as Href);
          })();
          return;
        }
        case "url": {
          setHint(null);
          void (async () => {
            const ok = await confirm({
              title: "Open link?",
              message: verdict.url,
              confirmLabel: "Open",
            });
            if (ok) {
              await Linking.openURL(verdict.url).catch(() => {
                setHint("Couldn't open that link.");
              });
            }
            // Either way we stay on the scanner, so it must come back.
            reArmLater();
          })();
          return;
        }
        case "unknown":
        default: {
          setHint("Not a Moosewave code.");
          reArmLater();
          return;
        }
      }
    },
    [confirm, reArmLater],
  );

  const handleScan = useCallback(
    (result: BarcodeScanningResult) => handleCode(result.data),
    [handleCode],
  );

  /**
   * Decode a QR out of an image in the photo library.
   *
   * The live camera cannot read a code that is on THIS screen, and a
   * desktop→mobile handoff code most often arrives as a screenshot — so
   * without this the screen's own stated purpose has a hole in it.
   *
   * The scan lock is released before handing the payload over: the lock exists
   * to throttle the continuous `onBarcodeScanned` firehose, and a deliberate
   * pick is never that. Without the release, picking a photo within two seconds
   * of a failed live scan would silently do nothing.
   */
  const pickAndScanPhoto = useCallback(async () => {
    setScanningPhoto(true);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (!mountedRef.current) return;
      // Backing out is a deliberate action; it needs no commentary.
      if (picked.canceled) return;
      const uri = picked.assets?.[0]?.uri;
      const codes = uri ? await scanFromURLAsync(uri, ["qr"]) : null;
      if (!mountedRef.current) return;
      const outcome = photoScanOutcome(codes);
      if (outcome.kind === "code") {
        lockedRef.current = false;
        setHint(null);
        handleCode(outcome.data);
        return;
      }
      haptics.warning();
      setHint(photoScanHint(outcome));
    } catch {
      // A picker or decoder throw is NOT "no code in that image" — the user
      // needs to know the difference to decide what to try next.
      if (!mountedRef.current) return;
      haptics.warning();
      setHint(photoScanHint({ kind: "failed" }));
    } finally {
      if (mountedRef.current) setScanningPhoto(false);
    }
  }, [handleCode]);

  // ——— Permission: not-yet-asked → branded prompt ———
  if (!permission) {
    // Hook is still resolving the initial status; render the chrome with
    // no camera so there's no flash.
    return (
      <ScanChrome t={t}>
        <View style={{ flex: 1 }} />
      </ScanChrome>
    );
  }

  if (!permission.granted) {
    return (
      <ScanChrome t={t}>
        <ScanPermissionPrompt
          t={t}
          denied={!permission.canAskAgain}
          onRequest={() => {
            // NATIVE#56: the scanner had NO telemetry of any kind, so a
            // camera permission the OS refuses looked identical to a feature
            // nobody uses. Only the OS decision is reported — never what was
            // scanned.
            void requestPermission().then((next) => {
              trackPermissionOutcome(
                "camera",
                next.granted ? "granted" : "denied",
              );
            });
          }}
        />
      </ScanChrome>
    );
  }

  // ——— Granted: live scanner ———
  return (
    <ScanChrome t={t}>
      <View style={{ flex: 1 }}>
        {focused ? (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleScan}
          />
        ) : (
          // Unfocused: the camera is torn down, so nothing is captured and no
          // in-use indicator is shown. A plain backdrop keeps the overlay
          // geometry identical, so returning here does not flash a re-layout.
          <View
            style={{ flex: 1, backgroundColor: "#000" }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        )}
        {/* The frame overlay stays mounted while unfocused so returning does
            not flash a re-layout; the torch does not, because there is no
            camera behind it to light. */}
        <ScanViewfinder
          t={t}
          hint={hint}
          torch={torch}
          showTorch={focused}
          onToggleTorch={() => setTorch((on) => !on)}
          onScanPhoto={() => void pickAndScanPhoto()}
          scanningPhoto={scanningPhoto}
        />
      </View>
    </ScanChrome>
  );
}
