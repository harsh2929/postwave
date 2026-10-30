// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { ArrowRight, FilePlus2, type LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { asRoute } from "@/lib/typed-routes";
import type {
  CompatResource,
  MailchimpLocalClosure,
} from "@/lib/mailchimp-compat-api";

export function ParityCard({
  icon: Icon,
  title,
  metric,
  detail,
  items,
  action,
  busy,
  demoActionsEnabled,
  onAction,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  metric: string;
  detail: string;
  items: string[];
  action: string;
  busy: string | null;
  demoActionsEnabled: boolean;
  onAction: () => void;
  /** Shown when the area is unmet: what to do + where (GOV-035). */
  hint?: { text: string; href: string };
}) {
  const isBusy = busy === action;
  const source = items.length ? items : ["No records yet"];
  const shown = source.slice(0, 4);
  const overflow = source.length - shown.length;
  return (
    <Card className="min-w-0">
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle
            as="h2"
            className="flex min-w-0 items-center gap-2 text-base"
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> {title}
          </CardTitle>
          {demoActionsEnabled ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 shrink-0 sm:min-h-8"
              onClick={onAction}
              disabled={busy !== null}
              loading={isBusy}
            >
              {!isBusy ? <FilePlus2 className="h-4 w-4" /> : null}
              {action}
            </Button>
          ) : null}
        </div>
        <div>
          <div className="text-2xl font-semibold">{metric}</div>
          <CardDescription>{detail}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {shown.map((item, i) => (
            <li
              key={`${i}-${item}`}
              className="break-words rounded-md bg-muted px-2 py-1.5"
            >
              {item}
            </li>
          ))}
          {overflow > 0 ? (
            <li className="px-2 text-xs text-muted-foreground/70">
              +{overflow} more
            </li>
          ) : null}
        </ul>
        {hint ? (
          <Link
            href={asRoute(hint.href)}
            className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {hint.text}
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A row in a MiniList: plain text, or text that links to a setup destination. */
export type MiniRow = string | { text: string; href?: string };

export function MiniList({
  title,
  rows,
  action,
}: {
  title: string;
  rows: MiniRow[];
  /** Optional footer link, e.g. to resolve unmet provider gates (GOV-034). */
  action?: { label: string; href: string };
}) {
  const source = rows.length ? rows : ["None yet"];
  const shown = source.slice(0, 8);
  const overflow = source.length - shown.length;
  return (
    <div className="min-w-0 rounded-md border p-3">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <div className="space-y-1 text-xs text-muted-foreground">
        {shown.map((row, i) => {
          const text = typeof row === "string" ? row : row.text;
          const href = typeof row === "string" ? undefined : row.href;
          return href ? (
            <Link
              key={`${i}-${text}`}
              href={asRoute(href)}
              className="flex min-h-11 items-center break-words rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {text}
            </Link>
          ) : (
            <div key={`${i}-${text}`} className="break-words py-0.5">
              {text}
            </div>
          );
        })}
        {overflow > 0 ? (
          <div className="text-[11px] text-muted-foreground/70">
            +{overflow} more
          </div>
        ) : null}
      </div>
      {action ? (
        <Link
          href={asRoute(action.href)}
          className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {action.label}
          <ArrowRight className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

export function journeyStatus(journey: CompatResource): string {
  return journey.status?.replaceAll("_", " ") ?? "rebuild tracked";
}

export function localClosureCount(
  closures: MailchimpLocalClosure[] | undefined,
  requiresExternal: boolean,
): number {
  return (closures ?? []).filter(
    (closure) => closure.requires_external === requiresExternal,
  ).length;
}

const READY_PROVIDER_GATE_STATUSES = new Set([
  "configured",
  "connected",
  "approved",
  "verified",
  "ready",
  "pass",
  "complete",
  "done",
  "not_required",
  "waived",
]);

export function providerGateReady(status: string): boolean {
  return READY_PROVIDER_GATE_STATUSES.has(status.trim().toLowerCase());
}

export function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
