/**
 * useIsOnline — reactive OS reachability for UI (banners, disabled actions).
 *
 * Mirrors lib/connectivity's online definition (connected AND not explicitly
 * unreachable) but as React state, so components re-render when the phone
 * drops off / rejoins the network. Seeded from the synchronous
 * isProbablyOnline() snapshot so the first paint is correct.
 */
import NetInfo from "@react-native-community/netinfo";
import { useEffect, useState } from "react";

import { isProbablyOnline } from "@/lib/connectivity";

export function useIsOnline(): boolean {
  const [online, setOnline] = useState<boolean>(isProbablyOnline());

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(
        Boolean(state.isConnected) && state.isInternetReachable !== false,
      );
    });
    return () => unsubscribe();
  }, []);

  return online;
}
