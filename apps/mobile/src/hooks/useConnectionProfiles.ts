/**
 * useConnectionProfiles — the effectful half of multi-server support.
 *
 * The rules live in `lib/connectionProfiles.ts` (pure) and the record in
 * `lib/connectionProfileStore.ts` (AsyncStorage). This hook is only the
 * plumbing: load, reconcile with where the app is actually pointed, add,
 * remove, and commit a switch.
 *
 * WHY A SWITCH IS A SIGN-OUT, and why that needed no change to the auth store.
 *
 * A profile is a different SERVER, not a different tenant on the same one. The
 * session cookie is origin-scoped, so the current one cannot authenticate
 * anything on the new host, and every cached artifact on the device belongs to
 * the workspace it came from. The honest transition is therefore the one the
 * app already implements exactly once, in `lib/signOutFlow.ts`: revoke push,
 * clear local credentials, wipe the query cache / vault / offline queue /
 * widget snapshot / Spotlight donations / saved list views
 * (store/authCleanup.ts), then land on sign-in.
 *
 * The only thing this adds is that the sign-in screen opens ALREADY POINTED at
 * the chosen server — via `rememberLastBaseUrl`, the preference both sign-in
 * screens already read on mount. No new state in the auth store, no second
 * credential path, and no way for server A's data to be on screen under server
 * B's name: at the moment the switch commits there is no data at all.
 */
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useIsOnline } from "@/hooks/useIsOnline";
import { rememberLastBaseUrl } from "@/lib/authPrefs";
import {
  addConnectionProfile,
  reconcileActiveProfile,
  removeConnectionProfile,
  type ConnectionProfile,
  type ConnectionProfileProblem,
  type ConnectionProfilesState,
  EMPTY_CONNECTION_PROFILES,
} from "@/lib/connectionProfiles";
import {
  readConnectionProfiles,
  writeConnectionProfiles,
} from "@/lib/connectionProfileStore";
import { unregisterPushThenSignOut } from "@/lib/push";
import { runSignOut } from "@/lib/signOutFlow";
import { useAuthStore } from "@/store/auth";

/**
 * A local row id.
 *
 * `Crypto.randomUUID()` is the source, but it is not treated as one that
 * cannot fail: it returns undefined wherever the native module is absent (the
 * jest environment is one such place, and so is any build where expo-crypto
 * failed to link), and an undefined id produces a profile that can be listed
 * but never switched away from or removed. These ids address a row in device
 * storage and are never sent anywhere, so a non-cryptographic fallback is
 * sufficient — and strictly better than an unaddressable row.
 */
function newProfileId(): string {
  const uuid = Crypto.randomUUID() as unknown;
  if (typeof uuid === "string" && uuid.trim()) return uuid.trim();
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ConnectionProfilesController {
  state: ConnectionProfilesState;
  /** False until the stored record has been read — the sheet shows a skeleton. */
  ready: boolean;
  online: boolean;
  /** Adds a profile. Returns the refusal, or null on success. */
  add: (draft: {
    name: string;
    baseUrl: string;
  }) => Promise<ConnectionProfileProblem | null>;
  /** Removes a profile. Returns the refusal message, or null on success. */
  remove: (id: string) => Promise<string | null>;
  /** Signs out of this server and opens sign-in pointed at the chosen one. */
  commitSwitch: (profile: ConnectionProfile) => Promise<void>;
}

export function useConnectionProfiles(): ConnectionProfilesController {
  const online = useIsOnline();
  const mode = useAuthStore((s) => s.mode);
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const signOut = useAuthStore((s) => s.signOut);
  const [state, setState] = useState<ConnectionProfilesState>(
    EMPTY_CONNECTION_PROFILES,
  );
  const [ready, setReady] = useState(false);
  // The record is read once and then owned in memory; `latest` lets the async
  // actions build on the newest value without re-reading storage and without
  // capturing a stale `state` in their closure.
  const latest = useRef<ConnectionProfilesState>(EMPTY_CONNECTION_PROFILES);

  const publish = useCallback((next: ConnectionProfilesState) => {
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readConnectionProfiles().then((stored) => {
      if (cancelled) return;
      // Adopt the address the app is actually signed in to, so the list can
      // never omit — or mis-mark — where the user currently is.
      const reconciled = reconcileActiveProfile(
        stored,
        baseUrl,
        newProfileId(),
      );
      publish(reconciled);
      setReady(true);
      if (reconciled !== stored) void writeConnectionProfiles(reconciled);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, publish]);

  const add = useCallback(
    async (draft: {
      name: string;
      baseUrl: string;
    }): Promise<ConnectionProfileProblem | null> => {
      const result = addConnectionProfile(latest.current, {
        id: newProfileId(),
        name: draft.name,
        baseUrl: draft.baseUrl,
      });
      if (!result.ok) return result.problem;
      const written = await writeConnectionProfiles(result.state);
      if (!written) {
        // Do NOT publish: a list that shows a connection storage refused would
        // vanish on the next launch with no explanation.
        return {
          field: "form",
          message: "Couldn't save this connection to the device.",
        };
      }
      publish(result.state);
      return null;
    },
    [publish],
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const result = removeConnectionProfile(latest.current, id);
      if (!result.ok) return result.message;
      const written = await writeConnectionProfiles(result.state);
      if (!written) return "Couldn't update the saved connections.";
      publish(result.state);
      return null;
    },
    [publish],
  );

  const commitSwitch = useCallback(
    async (profile: ConnectionProfile): Promise<void> => {
      const next: ConnectionProfilesState = {
        profiles: latest.current.profiles,
        activeId: profile.id,
      };
      // Both writes land BEFORE the teardown: sign-out unmounts this screen,
      // and the sign-in screen reads the remembered address on mount.
      await writeConnectionProfiles(next);
      await rememberLastBaseUrl(profile.baseUrl);
      publish(next);
      await runSignOut({
        performSignOut: () => unregisterPushThenSignOut(signOut),
        navigateToSignIn: () => {
          // An api-key install signs in on the legacy screen; sending it to the
          // session form would hand the operator a password box for a server
          // they authenticate to with a key.
          router.replace(mode === "api_key" ? "/(auth)/login" : "/(auth)/sign-in");
        },
      });
    },
    [mode, publish, signOut],
  );

  return { state, ready, online, add, remove, commitSwitch };
}
