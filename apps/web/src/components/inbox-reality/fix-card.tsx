// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowRight, Copy, Send, SquarePen, Wrench } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";
import type { Fix, FixAction } from "@/lib/inbox-reality-types";

const ACTION_LABEL: Record<FixAction, string> = {
  dns_record: "DNS record",
  copy_change: "Copy change",
  image_swap: "Image swap",
  resend: "Re-send",
};

const ACTION_VARIANT: Record<FixAction, "default" | "secondary" | "outline"> = {
  dns_record: "default",
  copy_change: "secondary",
  image_swap: "secondary",
  resend: "outline",
};

export interface FixCardProps {
  fix: Fix;
  index: number;
  /** Campaign this fix belongs to — enables "open in editor" / "re-send"
   *  deep links so a fix routes to where it's actually applied. */
  campaignId?: string;
}

/**
 * The primary "apply this fix" action, dispatched on the fix type so the
 * remediation loop actually closes (INBOX-006):
 *   dns_record  → Settings › Domain (where DNS records live)
 *   copy/image  → the campaign editor
 *   resend      → the campaign detail (its Resend-to-non-openers control)
 */
function PrimaryAction({
  action,
  campaignId,
}: {
  action: FixAction;
  campaignId?: string;
}) {
  if (action === "dns_record") {
    return (
      <Button asChild size="sm">
        <Link href={asRoute("/app/settings/domain")}>
          <Wrench className="h-3.5 w-3.5" />
          Open Settings › Domain
        </Link>
      </Button>
    );
  }
  if (!campaignId) return null;
  if (action === "resend") {
    return (
      <Button asChild size="sm">
        <Link href={asRoute(`/app/campaigns/${campaignId}`)}>
          <Send className="h-3.5 w-3.5" />
          Go to campaign to re-send
        </Link>
      </Button>
    );
  }
  // copy_change / image_swap → open the editor where the content is changed.
  return (
    <Button asChild size="sm">
      <Link href={asRoute(`/app/campaigns/${campaignId}`)}>
        <SquarePen className="h-3.5 w-3.5" />
        Open in editor
      </Link>
    </Button>
  );
}

export function FixCard({ fix, index, campaignId }: FixCardProps) {
  const impactPct = Math.round(fix.estimated_impact * 100);
  const copyInstructions = async () => {
    const dns = fix.dns_record
      ? `\n${fix.dns_record.type} ${fix.dns_record.name} ${fix.dns_record.value}`
      : "";
    try {
      await navigator.clipboard.writeText(
        `${fix.title}\n\n${fix.detail}${dns}`,
      );
      toast.success("Remediation instructions copied");
    } catch {
      toast.error("Could not copy instructions");
    }
  };
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">
                #{index + 1}
              </span>
              <h4 className="text-sm font-semibold">{fix.title}</h4>
            </div>
            <Badge variant={ACTION_VARIANT[fix.action]}>
              {ACTION_LABEL[fix.action]}
            </Badge>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyInstructions()}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy instructions
          </Button>
        </div>
        <p className="text-sm text-muted-foreground whitespace-pre-line">
          {fix.detail}
        </p>
        {fix.dns_record && (
          <pre
            tabIndex={0}
            role="group"
            aria-label="Suggested DNS record"
            className="text-xs bg-muted rounded p-2 overflow-x-auto font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {fix.dns_record.type} {fix.dns_record.name} → {fix.dns_record.value}
          </pre>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-32">
            Predicted impact
          </span>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full bg-success",
                impactPct === 0 && "opacity-30",
              )}
              style={{ width: `${Math.min(impactPct, 100)}%` }}
            />
          </div>
          <span className="text-xs font-medium w-10 text-right">
            +{impactPct}%
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <PrimaryAction action={fix.action} campaignId={campaignId} />
          {fix.action === "resend" && !campaignId ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowRight className="h-3 w-3" aria-hidden />
              Ships after content &amp; DNS fixes are applied
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
