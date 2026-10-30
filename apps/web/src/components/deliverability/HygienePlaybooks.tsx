// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Hygiene playbooks — expandable operator guidance for the deliverability
 * hub. Desktop parity: components/deliverability/HygienePlaybooks.tsx
 * (expand/collapse at 150-153, hosted by DeliverabilityHubWorkspace:544).
 *
 * Static copy, no request. One playbook is open at a time, exactly as on
 * desktop. The Apple MPP entry differs from desktop in one place on purpose:
 * desktop promises an "Exclude pre-fetched opens" Send-time setting that no
 * surface or API implements, so this version points at the hub's own
 * Machine opens figure instead of a control that does not exist.
 */
import { useId, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface HygienePlaybook {
  id: string;
  title: string;
  summary: string;
  body: ReactNode;
}

export const HYGIENE_PLAYBOOKS: readonly HygienePlaybook[] = [
  {
    id: "sunset",
    title: "Sunset flow",
    summary:
      "Re-engage or suppress subscribers who haven't opened in 90+ days.",
    body: (
      <>
        <p>
          Mailbox providers (Gmail / Yahoo) penalize senders that keep mailing
          dormant addresses. A sunset flow protects your reputation:
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            <strong>Identify</strong> subscribers with no engagement in ≥90 days
            (open + click + reply + form-submit).
          </li>
          <li>
            <strong>Win-back</strong> series: 2–3 emails over 14 days with a
            single, friction-free CTA (&ldquo;Still want these?&rdquo;).
          </li>
          <li>
            <strong>Suppress</strong> non-responders — move them to a separate
            list and stop sending broadcasts. They stay reachable for 1:1 and
            transactional mail.
          </li>
          <li>
            <strong>Measure</strong> the suppression cohort&apos;s bounce and
            complaint deltas over the following 30 days.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: "mpp",
    title: "Apple Mail Privacy Protection (MPP)",
    summary:
      "Open rates from Apple Mail are inflated — here's what to use instead.",
    body: (
      <>
        <p>
          MPP pre-fetches images server-side when the recipient opens Apple Mail
          with privacy protection enabled (~40% of opens in most B2C audiences).
          Treat opens from Apple as inflated.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Use clicks</strong> as the primary engagement signal for
            segmentation, sunset flows, and send-time optimization.
          </li>
          <li>
            <strong>Watch machine opens</strong>: the hub&apos;s Machine opens
            figure shows how much of your open volume was pre-fetched rather
            than read. Keep engagement-based segments off open-only criteria
            while it is high.
          </li>
          <li>
            <strong>Compare cohorts</strong>: Apple vs Gmail open rates should
            track within ~5pp of each other once MPP is corrected for.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "bounces",
    title: "Bounce-class playbook",
    summary:
      "Hard / soft / block / mailbox_full each need a different response.",
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Hard</strong>: address is invalid. Suppress immediately and
          never retry.
        </li>
        <li>
          <strong>Soft</strong>: temporary failure. Retry with backoff up to
          72h; after 5 soft bounces in 30 days, suppress.
        </li>
        <li>
          <strong>Block</strong>: receiver rejected for reputation / content
          reasons. Pause sending to that domain and check blocklists. Don&apos;t
          keep retrying — it makes things worse.
        </li>
        <li>
          <strong>Mailbox full</strong>: retry once per day for 7 days, then
          suppress.
        </li>
        <li>
          <strong>DNS</strong>: the recipient&apos;s domain has no valid MX
          records. Suppress.
        </li>
        <li>
          <strong>Content</strong>: receiver flagged the message body. Review
          the template, then re-send via a different identity.
        </li>
      </ul>
    ),
  },
];

export function HygienePlaybooks({
  playbooks = HYGIENE_PLAYBOOKS,
}: {
  playbooks?: readonly HygienePlaybook[];
}) {
  const baseId = useId();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      className="rounded-lg border p-4"
    >
      <div className="mb-3 flex items-start gap-2">
        <BookOpen className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div>
          <h2 id={`${baseId}-title`} className="text-base font-medium">
            Hygiene playbooks
          </h2>
          <p className="text-xs text-muted-foreground">
            Operator-grade recipes for keeping reputation healthy.
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {playbooks.map((playbook) => {
          const isOpen = open === playbook.id;
          const panelId = `${baseId}-${playbook.id}-panel`;
          const buttonId = `${baseId}-${playbook.id}-button`;
          return (
            <div
              key={playbook.id}
              className="overflow-hidden rounded-md border"
            >
              <h3 className="m-0">
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  onClick={() => setOpen(isOpen ? null : playbook.id)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {playbook.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {playbook.summary}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                      !isOpen && "-rotate-90",
                    )}
                  />
                </button>
              </h3>
              {isOpen ? (
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  className="border-t px-4 py-3 text-sm leading-6"
                >
                  {playbook.body}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
