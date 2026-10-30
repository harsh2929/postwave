// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  campaignTemplateActionReason,
  campaignTemplateCapabilities,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import { useTemplateGenerationAvailability } from "@/lib/use-template-generation-availability";

const DeferredUseTemplateDialog = dynamic(
  () => import("./template-actions").then((module) => module.UseTemplateDialog),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading campaign setup…
      </span>
    ),
  },
);

const DeferredAdaptTemplateDialog = dynamic(
  () =>
    import("./template-actions").then((module) => module.AdaptTemplateDialog),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading template adaptation…
      </span>
    ),
  },
);

interface DeferredTemplateActionProps {
  template: CampaignTemplateSummary;
  label: string;
  size?: "default" | "sm" | "lg";
  triggerClassName?: string;
}

/**
 * Keep the gallery's per-card dialog implementation out of the list route
 * until the operator asks for it. Once requested, the mounted dialog is kept
 * alive so a close/reopen cycle preserves draft state and restores focus to
 * the same lightweight trigger.
 */
export function LazyUseTemplateAction({
  template,
  label,
  size = "default",
  triggerClassName,
}: DeferredTemplateActionProps) {
  const capabilities = campaignTemplateCapabilities(template);
  const actionReason = campaignTemplateActionReason(template);
  const actionReasonID = `lazy-use-template-${encodeURIComponent(template.id)}-reason`;
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!capabilities.can_create_campaign) {
    return (
      <>
        <Button
          type="button"
          size={size}
          className={triggerClassName}
          aria-disabled="true"
          aria-describedby={actionReasonID}
        >
          Preview only
        </Button>
        <span id={actionReasonID} className="sr-only">
          {actionReason}
        </span>
      </>
    );
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        size={size}
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setActivated(true);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {activated ? (
        <DeferredUseTemplateDialog
          template={template}
          open={open}
          onOpenChange={setOpen}
          showTrigger={false}
          onCloseAutoFocus={() => triggerRef.current?.focus()}
        />
      ) : null}
    </>
  );
}

export function LazyAdaptTemplateAction({
  template,
  label,
  size = "default",
  triggerClassName,
}: DeferredTemplateActionProps) {
  const capabilities = campaignTemplateCapabilities(template);
  const generationAvailability = useTemplateGenerationAvailability(capabilities.can_adapt);
  const actionReason = campaignTemplateActionReason(template);
  const actionReasonID = `lazy-adapt-template-${encodeURIComponent(template.id)}-reason`;
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!capabilities.can_adapt) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size={size}
          className={triggerClassName}
          aria-disabled="true"
          aria-describedby={actionReasonID}
        >
          {template.review_status === "pending"
            ? "Awaiting review"
            : "Preview only"}
        </Button>
        <span id={actionReasonID} className="sr-only">
          {actionReason}
        </span>
      </>
    );
  }

  if (generationAvailability !== "available") {
    return <Button type="button" variant="outline" size={size} className={triggerClassName} disabled>
      <Sparkles className="h-4 w-4" aria-hidden />
      {generationAvailability === "checking" ? "Checking AI…" : generationAvailability === "error" ? "AI temporarily unavailable" : "AI adaptation · Coming soon"}
    </Button>;
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size={size}
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setActivated(true);
          setOpen(true);
        }}
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        {label}
      </Button>
      {activated ? (
        <DeferredAdaptTemplateDialog
          template={template}
          open={open}
          onOpenChange={setOpen}
          showTrigger={false}
          onCloseAutoFocus={() => triggerRef.current?.focus()}
        />
      ) : null}
    </>
  );
}
