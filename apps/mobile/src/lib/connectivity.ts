/**
 * Mobile networking lifecycle.
 *
 * TanStack Query does not automatically understand React Native app focus or
 * OS reachability. This module bridges AppState + NetInfo into Query's
 * focusManager/onlineManager and exposes a tiny synchronous read for custom
 * streams that sit outside Query.
 */
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { AppState, type AppStateStatus } from "react-native";
import { focusManager, onlineManager } from "@tanstack/react-query";

let configured = false;
let probablyOnline = true;

function stateToOnline(state: NetInfoState): boolean {
  return Boolean(state.isConnected) && state.isInternetReachable !== false;
}

function appStateToFocused(status: AppStateStatus): boolean {
  return status === "active";
}

export function isProbablyOnline(): boolean {
  return probablyOnline;
}

export function configureMobileConnectivity(options: {
  onOnline?: () => void;
} = {}): () => void {
  if (configured) {
    return () => {
      /* already configured by the root layout */
    };
  }
  configured = true;

  onlineManager.setEventListener((setOnline) => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const wasOnline = probablyOnline;
      probablyOnline = stateToOnline(state);
      setOnline(probablyOnline);
      if (!wasOnline && probablyOnline) {
        options.onOnline?.();
      }
    });
    void NetInfo.fetch()
      .then((state) => {
        const wasOnline = probablyOnline;
        probablyOnline = stateToOnline(state);
        setOnline(probablyOnline);
        if (!wasOnline && probablyOnline) {
          options.onOnline?.();
        }
      })
      .catch(() => {
        /* initial reachability probes are best-effort */
      });
    return unsubscribe;
  });

  focusManager.setEventListener((setFocused) => {
    const sub = AppState.addEventListener("change", (status) => {
      setFocused(appStateToFocused(status));
    });
    setFocused(appStateToFocused(AppState.currentState));
    return () => sub.remove();
  });

  return () => {
    configured = false;
    onlineManager.setOnline(true);
    focusManager.setFocused(true);
  };
}
