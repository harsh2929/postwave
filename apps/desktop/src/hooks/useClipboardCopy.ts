import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AriaAttributes,
} from "react";

import {
  clipboardAnnouncement,
  writeClipboardText,
  type ClipboardWriteOptions,
  type ClipboardWriteResult,
} from "../lib/clipboard";

export type ClipboardCopyStatus = "idle" | "copying" | "copied" | "failed";

interface ClipboardCopyState {
  status: ClipboardCopyStatus;
  copied: boolean;
  announcement: string;
  liveRegionProps: Pick<AriaAttributes, "aria-live" | "aria-atomic">;
  copy: (
    value: string,
    options?: ClipboardWriteOptions,
    accessibleLabel?: string,
  ) => Promise<ClipboardWriteResult>;
}

/**
 * Accessible transient copied/failed state for icon buttons and inline copy
 * controls. Domain surfaces can still add a toast; the polite live message
 * ensures an icon or label change is announced without exposing the value.
 */
export function useClipboardCopy(resetAfterMs = 1600): ClipboardCopyState {
  const [status, setStatus] = useState<ClipboardCopyStatus>("idle");
  const [announcement, setAnnouncement] = useState("");
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    async (
      value: string,
      options: ClipboardWriteOptions = {},
      accessibleLabel = "Value",
    ): Promise<ClipboardWriteResult> => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
      setStatus("copying");
      const result = await writeClipboardText(value, options);
      if (!mountedRef.current) return result;

      setStatus(result.ok ? "copied" : "failed");
      setAnnouncement(clipboardAnnouncement(result, accessibleLabel));
      resetTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return;
        setStatus("idle");
        resetTimerRef.current = null;
      }, resetAfterMs);
      return result;
    },
    [resetAfterMs],
  );

  return {
    status,
    copied: status === "copied",
    announcement,
    liveRegionProps: { "aria-live": "polite", "aria-atomic": true },
    copy,
  };
}
