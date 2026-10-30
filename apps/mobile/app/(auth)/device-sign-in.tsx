import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";

import { DeviceSessionSignInView } from "@/components/auth/DeviceSessionSignInView";
import { useDeviceSessionSignIn } from "@/hooks/useDeviceSessionSignIn";
import { announce } from "@/lib/a11y";
import { readLastBaseUrl, rememberLastBaseUrl } from "@/lib/authPrefs";
import { readConnectionProfiles } from "@/lib/connectionProfileStore";
import { redeemInAppOrigin } from "@/lib/inAppOriginHandoff";
import { DEFAULT_API_BASE_URL, validateApiBaseUrl } from "@/lib/config";
import { haptics } from "@/lib/haptics";
import { goBackOr } from "@/lib/nav";
import { destinationForSession, type SessionProfile } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function DeviceSignInScreen() {
  const params = useLocalSearchParams<{ base_url?: string }>();
  const passedBaseUrl =
    typeof params.base_url === "string" ? params.base_url : "";
  // A VALID url is not a TRUSTED one. This screen is reachable by system URL
  // (`moosewave://device-sign-in?base_url=...`) — app/+native-intent.tsx passes
  // unrecognised paths straight to the router, and the (auth) layout only
  // bounces users who are already signed in — so a signed-out device can be
  // pointed at any origin an attacker names. Completing the flow then binds the
  // session to that origin AND calls rememberLastBaseUrl below, which is
  // deliberately outside the sign-out wipe set, so the address survives into
  // the password form (with the API field collapsed) after the user signs out.
  //
  // So the parameter may only RE-SELECT an origin this device already knows —
  // the in-app "use another device" hand-off passes the URL the user is already
  // looking at, which is exactly that case. It can never introduce a new one.
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [apiFieldExpanded, setApiFieldExpanded] = useState(false);
  const [remember, setRemember] = useState(false);
  const [baseUrlError, setBaseUrlError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await readLastBaseUrl();
      if (!active) return;
      const candidate = validateApiBaseUrl(passedBaseUrl).ok
        ? passedBaseUrl
        : "";
      if (candidate) {
        // Vouched three ways, all of which mean "this device already chose it":
        // an in-app hand-off deposited in process memory moments ago (a deep
        // link cannot write there), the remembered address, or a workspace the
        // operator themself saved.
        if (redeemInAppOrigin(candidate)) {
          setBaseUrl(candidate);
          return;
        }
        const known = new Set<string>();
        if (stored) known.add(stored);
        try {
          const profiles = await readConnectionProfiles();
          for (const profile of profiles.profiles) known.add(profile.baseUrl);
        } catch {
          // A profile-store read failure must not widen trust; the param
          // simply stays unvouched and we fall through to the stored value.
        }
        if (!active) return;
        if (known.has(candidate)) {
          setBaseUrl(candidate);
          return;
        }
      }
      if (stored) setBaseUrl(stored);
    })();
    return () => {
      active = false;
    };
  }, [passedBaseUrl]);

  const finish = (profile: SessionProfile): void => {
    void rememberLastBaseUrl(baseUrl);
    haptics.success();
    announce("This device is signed in.");
    router.replace(destinationForSession(profile));
  };

  const deviceSignIn = useDeviceSessionSignIn({
    baseUrl,
    remember,
    onSignedIn: finish,
  });

  function start(): void {
    const validated = validateApiBaseUrl(baseUrl);
    if (!validated.ok) {
      haptics.error();
      setApiFieldExpanded(true);
      setBaseUrlError(validated.message);
      announce(validated.message);
      return;
    }
    setBaseUrlError("");
    void deviceSignIn.start();
  }

  function cancel(): void {
    void deviceSignIn.cancel().finally(() => {
      goBackOr("/(auth)/sign-in");
    });
  }

  return (
    <DeviceSessionSignInView
      state={deviceSignIn.state}
      baseUrl={baseUrl}
      apiFieldExpanded={apiFieldExpanded}
      remember={remember}
      baseUrlError={baseUrlError}
      onToggleApiField={() => setApiFieldExpanded((current) => !current)}
      onChangeBaseUrl={(next) => {
        setBaseUrl(next);
        if (baseUrlError) setBaseUrlError("");
      }}
      onChangeRemember={setRemember}
      onStart={start}
      onCancel={cancel}
    />
  );
}
