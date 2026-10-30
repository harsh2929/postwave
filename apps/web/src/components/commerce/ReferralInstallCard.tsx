// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * "Install on website" — the public referral widget install verb.
 *
 * Desktop reference: components/referrals/ReferralsPageContent.tsx renders
 * the control aria-disabled unless every REFERRAL_* boundary is open AND the
 * operator is an admin with a loaded program, and names the reason beside it
 * (REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON). The server keeps
 * /api/public/r/{code}/widget.js behind the same hold
 * (referrals.go MountPublicRoutes, OperationalRuntimeAvailable).
 *
 * When the hold lifts, the dialog shows the script tag a site embeds. The
 * `{{referral_code}}` placeholder is the subscriber-code template the reason
 * names: the widget is per-subscriber, so a site must render each visitor's
 * own code into the tag.
 */
import { useId, useState } from "react";
import { Code2 } from "lucide-react";

import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE,
  REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON,
  REFERRAL_SUBSCRIBER_LINKS_AVAILABLE,
} from "@/lib/referral-operational-availability";

export const REFERRAL_CODE_PLACEHOLDER = "{{referral_code}}";

/** The embed a site pastes; `apiOrigin` "" yields an origin-relative src. */
export function referralWidgetInstallSnippet(apiOrigin: string): string {
  const origin = apiOrigin.replace(/\/+$/u, "");
  return `<script async src="${origin}/api/public/r/${REFERRAL_CODE_PLACEHOLDER}/widget.js"></script>`;
}

/** Every activation boundary the public install depends on (desktop parity). */
export function referralInstallBoundariesOpen(): boolean {
  return (
    REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE &&
    REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE &&
    REFERRAL_PROGRAM_MUTATIONS_AVAILABLE &&
    REFERRAL_SUBSCRIBER_LINKS_AVAILABLE
  );
}

export function ReferralInstallCard({
  canAdmin,
  hasProgram,
}: {
  canAdmin: boolean;
  hasProgram: boolean;
}) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const boundariesOpen = referralInstallBoundariesOpen();
  const canInstall = boundariesOpen && canAdmin && hasProgram;
  const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "";
  const snippet = referralWidgetInstallSnippet(apiOrigin);

  const reason = !boundariesOpen
    ? REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON
    : !canAdmin
      ? "Only workspace owners and admins can install the referral widget."
      : "Create a referral program before installing the widget.";

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Install on website</CardTitle>
        <CardDescription>
          Embed the “Refer a friend” widget on your marketing site. The script
          is served per subscriber from the API origin.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full gap-2 sm:min-h-9 sm:w-auto"
          aria-disabled={!canInstall || undefined}
          aria-describedby={!canInstall ? reasonId : undefined}
          onClick={() => {
            if (canInstall) setOpen(true);
          }}
        >
          <Code2 className="h-4 w-4" aria-hidden />
          Install on website
        </Button>
        {!canInstall ? (
          <p
            id={reasonId}
            role="note"
            className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
          >
            {!boundariesOpen ? (
              <>
                <strong>Website installation is review-gated.</strong>{" "}
              </>
            ) : null}
            {reason}
          </p>
        ) : null}
      </CardContent>

      {canInstall ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Install the referral widget</DialogTitle>
              <DialogDescription>
                Paste this tag where the “Refer a friend” button should appear.
                Replace <code>{REFERRAL_CODE_PLACEHOLDER}</code> with the
                signed-in subscriber’s own referral code; the widget is
                per-subscriber and will not render for an unknown code.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              aria-label="Referral widget install code"
              readOnly
              rows={3}
              spellCheck={false}
              className="font-mono text-xs"
              value={snippet}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
              <CopyTextButton
                value={snippet}
                label="Copy install code"
                copiedLabel="Copied"
                variant="default"
                size="default"
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
