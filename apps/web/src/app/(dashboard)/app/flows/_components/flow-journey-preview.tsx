// SPDX-License-Identifier: AGPL-3.0-only
//
// FLOW-010 — configuration-only "preview the journey" panel. It renders the
// ordered path this flow defines (message references, branches, and order) so
// an operator can inspect a stored graph while activation remains release-held.
// Honest by construction: it walks authored data, calls no runtime, and never
// implies a specific subscriber execution.
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Clock,
  CornerDownRight,
  ExternalLink,
  Flag,
  GitBranch,
  Mail,
  MessageSquare,
  Split,
  StopCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { asRoute } from "@/lib/typed-routes";
import type { FlowCatalog, FlowGraph } from "@/lib/flows-api";
import { cn } from "@/lib/utils";

import {
  buildJourneySteps,
  type JourneyStep,
  type TemplateNamePending,
  type TemplateNameResolver,
} from "./flow-journey";

function iconFor(type: string) {
  switch (type) {
    case "send_email":
      return Mail;
    case "send_sms":
      return MessageSquare;
    case "wait":
    case "delay":
    case "wait_until_trigger":
      return Clock;
    case "branch":
      return GitBranch;
    case "percentage_split":
    case "ab_test":
      return Split;
    case "goal":
      return Flag;
    case "exit":
      return StopCircle;
    default:
      return Zap;
  }
}

function StepRow({ step }: { step: JourneyStep }) {
  const Icon = iconFor(step.type);
  return (
    <li
      className="flex items-start gap-2"
      style={{ paddingLeft: `${step.depth * 20}px` }}
    >
      {step.depth > 0 ? (
        <CornerDownRight
          className="mt-2 h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden
        />
      ) : null}
      <div className="flex-1 rounded-md border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{step.label}</span>
          {step.branchLabel ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {step.branchLabel}
            </span>
          ) : null}
          {step.templateId ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs"
            >
              <Link
                href={asRoute(
                  `/app/templates/${encodeURIComponent(step.templateId)}/preview`,
                )}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Preview email
              </Link>
            </Button>
          ) : null}
        </div>
        {step.detail ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
        ) : null}
        {step.note ? (
          <p
            className={cn(
              "mt-0.5 text-xs",
              step.note === "dead-end"
                ? "text-destructive"
                : "text-warning-emphasis",
            )}
          >
            {step.note === "dead-end"
              ? "Dead-end — this edge points at a step that doesn't exist."
              : step.note}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function FlowJourneyPreview({
  graph,
  catalog,
  disabled,
  resolveTemplateName,
  templateNamePending,
}: {
  graph: FlowGraph;
  catalog: FlowCatalog | null;
  disabled?: boolean;
  /** Names the templates send_email steps use (the canvas uses the same). */
  resolveTemplateName?: TemplateNameResolver;
  /** True while a template's name is still loading. */
  templateNamePending?: TemplateNamePending;
}) {
  const [open, setOpen] = useState(false);

  const labelForType = useMemo(() => {
    const m = new Map<string, string>(
      (catalog?.nodes ?? []).map((n) => [n.key, n.label]),
    );
    return (t: string) => m.get(t) ?? t;
  }, [catalog]);

  // Only walk while the dialog is open (the graph can be large + mutating).
  const steps = useMemo(
    () =>
      open
        ? buildJourneySteps(
            graph,
            labelForType,
            resolveTemplateName,
            templateNamePending,
          )
        : [],
    [open, graph, labelForType, resolveTemplateName, templateNamePending],
  );

  const hasNodes = (graph.nodes ?? []).length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          Preview journey
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Journey preview</DialogTitle>
          <DialogDescription>
            The stored path this flow defines, step by step. Inspect the content
            referenced by each send step and every authored branch. This is a
            structural preview only; activation, subscriber selection, and
            delivery remain release-held.
          </DialogDescription>
        </DialogHeader>
        {!hasNodes ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This flow has no steps yet. Add a trigger and at least one step to
            preview the journey.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Flow journey steps"
            tabIndex={0}
            className="max-h-[60vh] overflow-y-auto pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ol className="space-y-2">
              {steps.map((step, i) => (
                <StepRow key={`${step.nodeId}-${i}`} step={step} />
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
