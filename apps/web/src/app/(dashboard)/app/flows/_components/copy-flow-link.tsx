// SPDX-License-Identifier: AGPL-3.0-only
//
// "Copy link" for a flow (FLOW-040). Mirrors the app's copy-entity-link
// behaviour — guarded clipboard access, a brief confirmation, and a visible
// failure state — but targets the flow's canonical /app/flows/[id] URL
// directly, because the shared route-map registry does not yet carry a "flow"
// entity (so CopyEntityLink would render nothing).
"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Link2 } from "lucide-react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { flowWebUrl } from "@/lib/flows-api";

type CopyStatus = "idle" | "copied" | "error";

export function CopyFlowLink({
  flowId,
  label = "Copy link",
  variant = "outline",
  size = "sm",
  className,
  iconOnly = false,
}: {
  flowId: string;
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  iconOnly?: boolean;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [url, setUrl] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the origin on the client so SSR doesn't bake in a fixed host.
  useEffect(() => {
    setUrl(flowWebUrl(flowId));
  }, [flowId]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const available = isClipboardAvailable();

  async function handleCopy() {
    const result = await copyToClipboard(url || flowWebUrl(flowId));
    if (result === "copied") {
      setStatus("copied");
      toast.success("Flow link copied");
    } else {
      setStatus("error");
      toast.error("Could not copy the link");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  const Icon =
    status === "copied" ? Check : status === "error" ? AlertTriangle : Link2;
  const text =
    status === "copied" ? "Copied" : status === "error" ? "Failed" : label;

  return (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? "icon" : size}
      className={className}
      disabled={!available}
      title={available ? url : `Copy manually: ${url}`}
      aria-label={iconOnly ? label : undefined}
      onClick={() => void handleCopy()}
    >
      <Icon className={iconOnly ? "" : "mr-1.5 h-4 w-4"} aria-hidden />
      {iconOnly ? null : text}
    </Button>
  );
}
