import { useSyncExternalStore } from "react";

function subscribeDocumentVisibility(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function documentIsVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

/** Stops confidential polling while the renderer is backgrounded. */
export function useSMSDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    documentIsVisible,
    () => true,
  );
}
