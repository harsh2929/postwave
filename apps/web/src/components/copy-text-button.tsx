// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Reusable "copy this exact text" button (e.g. a hosted form URL — FORM-021).
// Unlike CopyEntityLink (which derives a route-map link), this copies an
// arbitrary string. Same clipboard-guard posture as the rest of the app:
// disabled with a manual-copy `title` when the Clipboard API is unavailable,
// and a visible failure state (icon flip + toast) on a rejected write.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyTextButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** Toast on success. Default true. */
  toastOnCopy?: boolean;
}

type CopyStatus = "idle" | "copied" | "error";

export function CopyTextButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "outline",
  size = "sm",
  className,
  toastOnCopy = true,
}: CopyTextButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [available, setAvailable] = useState(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAvailable(isClipboardAvailable());
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setStatus("idle"), 1600);
  };

  const iconOnly = label.trim() === "" && copiedLabel.trim() === "";
  const accessibleLabel =
    status === "copied"
      ? "Copied to clipboard"
      : status === "error"
        ? "Retry copy to clipboard"
        : "Copy to clipboard";

  const onCopy = async () => {
    const result = await copyToClipboard(value);
    if (result === "copied") {
      setStatus("copied");
      if (toastOnCopy) toast.success("Copied to clipboard.");
    } else {
      setStatus("error");
      toast.error(
        result === "unavailable"
          ? "Clipboard unavailable — copy the value manually."
          : "Could not copy to the clipboard.",
      );
    }
    scheduleReset();
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      // Empty visible labels intentionally create the compact icon variant.
      // It still needs a stable accessible name and a 44px touch target at
      // narrow viewports; the desktop footprint remains unchanged.
      className={cn(iconOnly && "min-w-11 sm:min-w-0", className)}
      aria-label={iconOnly ? accessibleLabel : undefined}
      disabled={!available}
      title={!available ? value : undefined}
      onClick={() => void onCopy()}
    >
      {status === "copied" ? (
        <Check className="h-3.5 w-3.5" />
      ) : status === "error" ? (
        <AlertTriangle className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {status === "copied" ? copiedLabel : label}
    </Button>
  );
}
